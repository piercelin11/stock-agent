# Stock Agent

## 專案目的

台股觀察/分析 agent 的後端資料層。抓取證交所（TWSE）與櫃買中心（TPEx）公開資料與 FinMind API，存進 PostgreSQL，之後透過 Claude Code 互動式地做篩選、族群分析、新聞整合等工作。

## 資料表結構總覽

- **Sector**：正式產業別，一支股票對應一個（`Stock.sectorId`）。
- **Stock**：股票基本資料（代號、名稱、市場、證券類型、所屬產業別）。是大部分其他表的關聯核心。
- **Tag**：概念題材標籤，會動態變動，與 Stock 多對多。
- **StockTag**：Stock 與 Tag 的多對多關聯表。
- **DailyQuote**：每日報價快取（開高低收、量、漲跌），依 `stockCode + date` 唯一。
- **NewsArticle**：新聞文章（標題、連結、來源、發布時間、情緒分析結果）。
- **NewsStock**：NewsArticle 與 Stock 的多對多關聯表。
- **WatchlistItem**：手動維護的正式觀察名單，一支股票最多一筆。
- **AnalysisResult**：AI 產出的分析結果歷史紀錄（screener / watchlist_summary / sector_ranking 等）。
- **StockValuation**：個股每日估值（本益比/股價淨值比/殖利率/收盤價），依 `stockCode + date` 唯一。TPEx 來源沒有收盤價（`closePrice` 為 null）；虧損公司 `peRatio` 為 null。
- **IndustryHeatSnapshot**：產業熱度每日快照（等權平均漲跌幅、漲跌家數、當日排名），依 `sectorId + date` 唯一。**不存 heatScore**——熱度分數要用時從原始欄位現算，避免公式調整後需要重刷歷史。
- **Stock 的股本欄位**：`sharesOutstanding`（已發行普通股數）與 `sharesOutstandingUpdatedAt`。市值不落地存欄位，要用時以 `sharesOutstanding × 當日收盤價` 現算。

## 資料來源與限制

- **FinMind API**：未註冊 300 次/小時，註冊後 600 次/小時；大部分 dataset 需要指定 `stock_id`（例外：`TaiwanStockInfo` 可一次拿全部股票清單）。`TaiwanStockNews` 只有標題/連結/簡短描述，沒有全文。`TaiwanStockInfo` 的 `type` 欄位有 `twse`、`tpex`、`emerging`（興櫃）三種值，目前 `Market` enum 只涵蓋 `TWSE`/`TPEx`，seed 時會跳過 `emerging`。
- **證交所 OpenAPI**（`openapi.twse.com.tw`）：免註冊免金鑰，一次可拿全上市市場當日資料（`STOCK_DAY_ALL`），官方未公布明確 rate limit，自行節流即可。
- **櫃買中心 OpenAPI**（`www.tpex.org.tw/openapi`）：同上，但欄位命名跟證交所不同，且回傳資料混合了股票/ETF/權證/可轉債，需要過濾。
- **證交所舊版報表 API `MI_INDEX`**（`www.twse.com.tw/exchangeReport/MI_INDEX`）：可查「指定單一天」的全上市市場資料（`STOCK_DAY_ALL` 只給當日），已於 2026-08-17 實測驗證可用。用法重點：
  - `date` 參數直接傳西元 `YYYYMMDD` 即可（如 `20260814`），API 內部會自動轉換民國年，不需要自己轉換。
  - `response=json&type=ALL` 即可直接拿到 JSON，不需要 fallback 成 HTML 解析。
  - 回應是 `tables` 陣列，混雜指數/大盤統計/個股明細等 10 個表格，**個股明細在 index 8**（標題「每日收盤行情(全部)」），欄位為 `[證券代號, 證券名稱, 成交股數, 成交筆數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌(+/-), 漲跌價差, ...]`；`漲跌(+/-)` 欄位是含 HTML 顏色標記的字串（`color:red`=漲、`color:green`=跌），要另外解析正負號。
  - 非交易日（週末/假日）回應不含 `tables` 欄位，只有 `{"stat": "很抱歉，沒有符合條件的資料!"}`，可用這個判斷跳過。
  - 這支 API 的「全部」個股明細包含股票/ETF/權證/可轉債等所有證券類型（權證數量可達上萬筆），不是只有一般股票，寫入 `Stock` 前要套用過濾規則分類。
- **過濾規則**：ETF 代號開頭為 `00`；權證名稱含「購」或「售」，或代號為 6 碼數字；可轉債（bond）代號為 5 碼數字；一般股票為恰好 4 碼數字；特別股代號為 4 碼 + 1 碼英文字母（共 5 碼）；其餘歸類為 other。
- **權證（warrant）與可轉債（bond）不存進資料庫**：這個專案的分析目標不涉及衍生性金融商品。`fill-daily-quotes.ts` 的 `writeRows` 分類完 `securityType` 後，若為 `warrant` 或 `bond` 會直接跳過（不建立 Stock、不寫入 DailyQuote），並在統計輸出裡回報跳過筆數。2026-08-17 已一次性清理過資料庫裡既有的 18,041 筆 warrant/bond Stock 記錄與對應的 29,382 筆 DailyQuote。
- **TPEx OpenAPI 個股行情端點不支援歷史日期查詢**：`tpex_mainboard_daily_close_quotes`、`tpex_mainboard_quotes`、`tpex_delayed_stock_close` 等端點的 swagger 定義 `parameters` 都是空陣列，2026-08-17 實測不論傳什麼查詢參數，回應的 `Date` 欄位永遠是「目前最新一天」，無法像證交所 `MI_INDEX` 一樣指定任意歷史日期。因此上櫃股票的「補歷史缺漏」目前無解，只能補當天（`fill-daily-quotes.ts` 的 `fillTodayTpex`）或靠 FinMind 逐支回補（`backfill-daily-quotes.ts`）。
- **`STOCK_DAY_ALL` 有發布延遲，不適合當作「今天資料是否已可取得」的判斷依據**：2026-08-17 實測，`MI_INDEX` 對當天日期已回應 `stat: OK`（資料齊備）的同一時間點，`STOCK_DAY_ALL` 回傳的 `Date` 仍是前一個交易日，代表兩支 API 的資料更新時間點不同步。因此 `fill-daily-quotes.ts` 的 TWSE 部分固定用 `MI_INDEX`（可指定日期、資料較即時），沒有改用 `STOCK_DAY_ALL`。
- **TPEx `tpex_mainboard_daily_close_quotes` 回應細節**：`Date` 欄位是民國年（如 `1150817`，需 `+1911` 轉西元），欄位名稱為 `SecuritiesCompanyCode`/`CompanyName`/`Close`/`Open`/`High`/`Low`/`TradingShares`/`Change`（`Change` 直接是帶正負號的數字字串，不像 `MI_INDEX` 用 HTML 顏色標記）。回應同樣混雜股票/ETF/權證/可轉債，需套用同一套過濾規則。
- **TWSE 估值 API `BWIBBU_d`**（`www.twse.com.tw/exchangeReport/BWIBBU_d?response=json&date=YYYYMMDD&selectType=ALL`）：全上市普通股的本益比/殖利率/股價淨值比，可查任意歷史日期（2026-08-18 實測，回應 `date` 欄位直接是西元 `YYYYMMDD` 可拿來核對）。欄位順序 `[證券代號, 證券名稱, 收盤價, 殖利率(%), 股利年度, 本益比, 股價淨值比, 財報年/季]`；本益比缺值（虧損公司）為 `"-"`；數字可能含千分位逗號。非交易日 `stat` 不是 `"OK"`。回傳約 1080 筆，比 `Stock` 表的 TWSE 普通股（約 1220 檔）少約 12%——估值端點僅涵蓋有估值資料的普通股，此差異屬正常。
- **TPEx 估值端點支援歷史日期查詢**（與行情端點不同！）：`www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=YYYY/MM/DD&id=&response=json`，`date` 收「西元」年斜線格式（如 `2026/06/01`），2026-08-18 實測可查任意歷史日期。回應在 `tables[0]`，`date` 欄位是民國年斜線格式（`115/06/01`）要 `+1911` 核對；欄位順序 `[股票代號, 公司名稱, 本益比, 每股股利, 股利年度, 殖利率(%), 股價淨值比, 財報年/季]`（**與 TWSE 不同且沒有收盤價**），公司名稱尾端帶補位空白要 trim。非交易日 `totalCount` 為 0。OpenAPI 版 `tpex_mainboard_peratio_analysis` 只給最新一天，不用。
- **MOPS 股本 CSV**（`mopsfin.twse.com.tw/opendata/t187ap03_L.csv` 上市 / `t187ap03_O.csv` 上櫃）：UTF-8 含 BOM，最後一欄「已發行普通股數或TDR原股發行股數」直接就是股數。**絕對不要用「實收資本額 ÷ 面額」推算**——面額不是每家都 10 元（實測案例：國巨 2327 面額 2.5 元）。CSV 只涵蓋現存上市/上櫃公司，`Stock` 表裡的已下市/KY 等標的不在其中（約 TWSE 135 檔、TPEx 34 檔），跳過不動原值。

## 開發慣例

- Prisma model 單數命名（`Stock` 不是 `Stocks`），欄位用 camelCase（`stockCode` 不是 `stock_code`）。
- 新增/更新基礎資料（股票清單、產業別）用 `npx prisma db seed`（會執行 `prisma/seed.ts`），不要每次手寫新腳本。
- `.env` 的資料庫連線變數名稱是 Prisma 預設的 `DATABASE_URL`。
- **Prisma 版本為 7.9.1**（比原始規劃文件 `docs/PLAN.md` 假設的版本新），與舊版 Prisma 有以下差異，之後新增功能時要注意：
  - 連線字串不寫在 `schema.prisma` 的 `datasource.url`，而是在 `prisma.config.ts` 的 `datasource.url`（仍然讀取 `DATABASE_URL`）。
  - `PrismaClient` 需要搭配 driver adapter 初始化，本專案用 `@prisma/adapter-pg`：
    ```ts
    import { PrismaPg } from "@prisma/adapter-pg";
    import { PrismaClient } from "../generated/prisma/client.js";
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    ```
  - Prisma Client 產出位置是 `generated/prisma`（非預設的 `node_modules/@prisma/client`），且是 ESM-only（用了 `import.meta.url`），因此整個專案 `package.json` 設定為 `"type": "module"`。
  - TS 執行工具用 **tsx**，不是 `ts-node`（`ts-node` 與剛發布的 TypeScript 7 新架構不相容）。
  - Prisma seed 指令設定在 `prisma.config.ts` 的 `migrations.seed`，不是 `package.json` 的 `"prisma"` 欄位（後者在 Prisma 7 已不生效）。

## 目前進度

已完成：資料庫 schema（12 個 model，含 `MonthRevenue`、`FinancialStatement`、`InstitutionalTrading`、`TechnicalIndicator`）建立並套用 migration、`prisma/seed.ts` 執行完成、逐支股票用 FinMind 回補歷史報價（`backfill-daily-quotes.ts`）、技術指標計算（`calculate-technical-indicators.ts`）、全市場篩選（`run-screener.ts`）、全市場報價缺漏回補（`fill-daily-quotes.ts`，TWSE 用 `MI_INDEX` API 可補任意歷史日期，TPEx 用 TPEx OpenAPI 只能補當天）、每日排程主控腳本（`daily-pipeline.ts`，串起缺漏檢查→補齊 TWSE+TPEx→算指標→跑篩選）皆已完成並手動測試成功（2026-08-17）。`fill-daily-quotes.ts` 已排除權證/可轉債寫入，資料庫裡既有的權證/可轉債資料也已清理完畢（2026-08-17）。

**Phase B 擴充（估值/市值/產業熱度）已完成（2026-08-18）**：依 `docs/PLAN.md` 完成 schema migration（`StockValuation`、`IndustryHeatSnapshot`、`Stock.sharesOutstanding`，migration `20260818130854_add_valuation_heat_shares`）、`scripts/calculate-industry-heat.ts`（已回補 20 個交易日）、`scripts/fill-gap-valuation.ts`（TWSE + TPEx 皆可查歷史日期，已抓 2026-08-17 與 08-18）、`scripts/update-shares-outstanding.ts`（已手動跑過一次，TWSE 1095 檔 + TPEx 890 檔）。估值與熱度已整合進 `daily-pipeline.ts`（放在技術指標之後、篩選之前，失敗不中斷 pipeline），冪等性與失敗路徑皆已驗證。股本更新為月頻手動執行，不進 daily pipeline。

**Phase C（候選股深度資料抓取）已完成（2026-08-18）**：`scripts/fetch-candidate-details.ts` 讀取 `data/screener-results/{日期}.json` 的候選股清單，逐支依序抓取籌碼面（`InstitutionalTrading`）、月營收（`MonthRevenue`）、季報（`FinancialStatement`）、新聞（`NewsArticle`/`NewsStock`）四個面向，寫入資料庫。已用 2026-08-18 篩選結果（23 檔候選股）實測成功，零失敗。`NewsArticle.link` 已加上 `@unique` 約束（migration `20260818112801_add_news_article_link_unique`）。

**全市場評分腳本（screen_score）已完成（2026-08-18）**：依 `docs/PLAN.md` 完成 Step 0（`calculate-technical-indicators.ts` 新增 `volatility20d`/`maxDrawdown20d`/`atr20`/`rsi14`/`macdStatus` 五欄位，migration `20260818155230_add_screen_score_indicators`）與 Step 1（新增 `scripts/calculate-screen-score.ts`，九因子加權評分，匯出 `calculateScreenScore(date)`，結果輸出至 `data/screen-score-results/{date}.json`，不寫資料庫）。`rankScore`（橫向百分位排名函式）已用假資料單元測試三種邊界情況（全部有值/部分 null/全部 null）；開發過程中發現並修正一個方向性 bug（`lowerIsBetter=false` 時最大值誤排到最低分，已修正並用台積電市值/成交金額實測驗證為 100 分）。已用 2026-08-18 全市場資料實測（1947 檔一般股票），肉眼核對前 20 名、抽查 PE/PB 因子方向、確認估值缺值股票（如 DR 存託憑證）正確降級為 `naScore` 不崩潰。**尚未接進 `daily-pipeline.ts`**（依計畫先獨立驗證，穩定後再考慮整合）。

**突破強度篩選腳本（breakout-strength）已完成（2026-08-19）**：新增 `scripts/calculate-breakout-strength.ts`，依 `docs/PLAN.md` 實作「觸發 → 資格門檻 → 強度評分」三層架構，回答「今天市場的焦點在哪」，與 `calculate-screen-score.ts` 的九因子橫向排名互補（後者是全市場排序，前者是帶量突破訊號的獨立篩選）。匯出 `calculateBreakoutStrength(date)`，結果輸出至 `data/breakout-strength-results/{date}.json`，不寫資料庫。用 2026-08-18 資料實測（1947 檔一般股票 → 觸發 33 檔 → 通過市值/量能門檻 16 檔），完成 PLAN.md 列的 5 項驗證：候選名單肉眼核對（抽查 2605、5608 確認真實突破布林上軌且量比達標）、firstBar 抽查（確認昨日收盤在帶內對應 100 分）、stats 三數字合理遞減、同日重跑兩次輸出完全一致（純確定性）、`sharesOutstanding` 為 null 的股票會被市值門檻正確擋下且計數 log（今天無實際觸發案例撞上此分支，邏輯已審查確認不會 crash）。歷史視窗（base 位階、proximityToHigh）目前資料庫約 60 個交易日，皆已寫成「視窗上限 N 天、不足時降級並標記 `degraded`」，未來歷史補齊後不需改程式碼即可自動使用滿 240 日視窗。

**launchd 排程驗證 + 三大法人籌碼腳本 + daily-pipeline.ts 改寫（2026-08-23）**：先用一支一次性測試腳本（已刪除）驗證「launchd 定時觸發 → tsx 執行 Prisma 查詢 → 寫入 log」整條流程可行，關鍵結論：`generated/prisma/` 是 Prisma 產生的純 `.ts` 原始檔（非編譯過的 `.js`），plist 裡不能直接用 `node` 執行 `scripts/*.ts`，必須讓 `ProgramArguments` 指向 `node_modules/tsx/dist/cli.mjs`（絕對路徑）、把目標腳本當參數傳入。確認可行後新增 `scripts/fill-institutional-trading.ts`：抓取 TWSE `T86`（三大法人買賣超日報，支援任意歷史日期）+ TPEx `tpex_3insti_daily_trading`（不支援日期參數，永遠回傳「目前最新一天」，跟 TPEx 報價 API 同樣限制）寫入 `InstitutionalTrading`，只 upsert `Stock` 表已存在的一般股票代號（不像 `fill-daily-quotes.ts` 會自動新增股票——籌碼資料不該是新股票的來源）。同時把 `daily-pipeline.ts` 整支改寫成五步：補齊今日 TWSE+TPEx 報價 → 抓今日 TWSE+TPEx 三大法人籌碼 → 抓今日估值（`fillOneDayValuation`）→ 算技術指標 → 算產業熱度，移除歷史缺漏回補與 `runScreener` 兩塊（這些功能仍在，只是改回個別手動執行，不再進 daily pipeline）。

**「非當日資料」防呆邏輯（同日追加）**：起因是 2026-08-23（週日）跑 pipeline 時發現 TPEx 報價/籌碼把上一個交易日（08-21）的舊資料當成「今天」寫入 `DailyQuote`/`InstitutionalTrading`，upsert 到同一天雖無害但容易誤判「今天有交易」。修正後行為：`fillTodayTpex(expectedIsoDate?)` 與 `fill-institutional-trading.ts` 的 TPEx 那段都會比對 API 回傳日期與預期日期，**不符就跳過寫入**（不再寫入舊資料）並印出 `⚠` 開頭的 warning、回傳 `isStaleDate: true`。`daily-pipeline.ts` 在報價步驟後判斷：**TWSE 無資料（非交易日）且 TPEx 也拿不到當日資料時，直接印出訊息並提前結束整支 pipeline**（不跑籌碼/估值/技術指標/熱度，因為兩邊都沒有新資料可用時後面的計算沒有意義）；只要有任一邊有正確當日資料就繼續跑完所有步驟（TWSE、TPEx 交易日曆理論上一致，不會有一邊開盤一邊沒開盤的情況，這裡防的是 TPEx API 本身「回傳日期落後」的資料新鮮度問題，不是市場狀態不同步）。總結區塊新增「今日警告：N 則」統計（來自報價/籌碼兩處 `isStaleDate` 加總），方便一眼確認當天有沒有異常，不用逐行翻 log。log 是 append 累積寫入 `logs/daily_pipeline_stdout.log`／`_stderr.log`，不會覆蓋。

已完整跑過三次驗證：（1）平日交易日資料完整時的正常路徑 exit code 0（2148 檔股票技術指標、44-45 個產業熱度、TWSE+TPEx 籌碼皆正確寫入，抽查 2609/2892 兩檔股票籌碼數字與 API 原始回應逐位元核對正確）；（2）今日（週日）非交易日的提前結束路徑，1.7 秒內正確判斷並結束、警告數正確計為 1；（3）「TWSE 有資料但 TPEx 過期」的混合情境，以 `fillOneDayTwse("2026-08-21")` + `fillTodayTpex("2026-08-22")` 模擬驗證繼續執行的判斷邏輯正確。**尚未串接 `InstitutionalTrading` 到任何 calculate 腳本**——`calculate-screen-score.ts`/`calculate-breakout-strength.ts` 目前都不讀籌碼資料，這次寫入的資料短期內只是存底。**plist（`daily_pipeline.plist`）已建立在專案根目錄，設定每天 17:00 觸發，尚未由使用者手動複製到 `~/Library/LaunchAgents` 並 `launchctl bootstrap`**。

**盤中一次性快照篩選（intraday-snapshot）已完成（2026-08-24）**：新增 `scripts/check-intraday-breakout.ts`，把 `calculate-breakout-strength.ts` 的觸發/門檻/評分邏輯提前套用在盤中即時價格上，資料源是 `mis.twse.com.tw` 的社群逆向工程即時報價端點（非官方文件，欄位可能無預警變動）。一次性手動執行，不排程、不接進 `daily-pipeline.ts`。實作重點：批次查詢（每批 120 檔、間隔 1.5 秒節流）、上市/上櫃前綴直接查 `Stock.market` 判斷（不猜測重試）、`elapsedRatio`（開盤到查詢當下的時間比例）用查詢當下時間現算並 clip 到 `[0.05, 1.0]`，用以把累計量換算成預估全天量；下限與上限分別對應「開盤前」（印警告）與「收盤後」（不印警告，此時預估量即為完整全天量）兩種情境，不合併成一種警告。同時新增 MIS 回傳日期與資料庫最新 `DailyQuote` 日期的錯位偵測（僅做「相不相同」二分判斷，因專案無交易日曆表無法正確排除週末）。為避免兩支腳本各自維護一份評分邏輯，把 `GATES`/`WEIGHTS`/`TRIGGER_VOLUME_RATIO` 等常數與六項評分純函式（`computeVolumeStrength`/`computeBreakoutMargin`/`computeFirstBar`/`computeBase`/`computeProximityToHigh`/`computeMarketWideReturns`/`rankScore`/`clip`）、`fetchHistoryWindow` 抽到新檔案 `scripts/breakout-shared.ts`，`calculate-breakout-strength.ts` 同步改為從此檔案 import（原本的內部定義已移除，程式碼行數從 693 行降到 416 行）。結果不寫資料庫，輸出 JSON 快照至 `data/intraday-breakout-snapshots/{timestamp}.json`（檔名含完整時間戳記，同一天可執行多次不覆蓋）。已實測執行成功（1727 檔查詢、45 檔觸發、22 檔通過門檻），輸出分數與統計數字合理遞減。執行：`npx tsx scripts/check-intraday-breakout.ts`（無參數，本質是「現在」的快照，不支援 `--date`）。

尚未開始/明確不做：估值歷史回補（`fill-gap-valuation.ts` 已支援 `--date` 隨時可補，但依計畫不主動回補）、heatScore 欄位與市值加權熱度（第一版等權即可，分數用時現算）、股本更新排程（月頻手動跑）、新聞情緒分析（`NewsArticle.sentiment`/`sentimentScore` 欄位已存在但尚未有腳本填值）、Tag/StockTag 篩選邏輯（`topic_alignment` 因子固定中性分）、WatchlistItem 操作介面、AnalysisResult 產出流程（Phase D）、`fetch-candidate-details.ts`、`calculate-screen-score.ts`、`calculate-breakout-strength.ts`、`check-intraday-breakout.ts`、`run-screener.ts`、`fill-gap-valuation.ts` 皆為獨立手動執行的腳本（不在 `daily-pipeline.ts` 內）、`InstitutionalTrading` 尚未被任何 calculate 腳本消費（純存底）、`WEIGHTS` 權重調整（`calculate-screen-score.ts` 與 `calculate-breakout-strength.ts`/`check-intraday-breakout.ts` 共用的權重目前都是規劃文件給的初始值，未來可能需依實際排名結果微調）。

（每次進度更新，麻煩幫我一併更新這個區塊。）

## 既有腳本

- **`top20-gainers.js`**（專案根目錄，非 TypeScript，尚未整合進 `/scripts` 或資料庫）：抓取當日 TWSE + TPEx 收盤資料，篩選出一般股票（排除 ETF、權證、特別股等），依漲幅排序印出前 20 名。執行方式：`node top20-gainers.js`。之後若要整合進資料庫流程，需改寫成 TypeScript 並搬進 `/scripts`，把結果寫入 `DailyQuote` 而非只印出。
- **`scripts/backfill-daily-quotes.ts`**：用 FinMind API 逐支股票回補近 120 天歷史報價至 `DailyQuote`。執行：`npx tsx scripts/backfill-daily-quotes.ts`（可用 `BACKFILL_LIMIT` 環境變數限制處理支數，測試用）。
- **`scripts/calculate-technical-indicators.ts`**：依 `DailyQuote` 計算 MA5/10/20/60、布林通道（含 `bollingerBandwidth` 帶寬 `= (upper - lower) / mid`）、量能均線，以及 `volatility20d`（近20日日報酬率標準差）、`maxDrawdown20d`（近20日最大回撤）、`atr20`（近20日 True Range 平均值）、`rsi14`（14日 RSI）、`macdStatus`（12/26/9 EMA 判斷 `"bullish"`/`"bearish"`/`null`），寫入 `TechnicalIndicator`。匯出 `calculateTechnicalIndicators()` 供其他腳本 import 使用。執行：`npx tsx scripts/calculate-technical-indicators.ts`。
- **`scripts/run-screener.ts`**：讀取 `scripts/screener-conditions.json` 的條件，對最新交易日跑全市場篩選，結果印出並寫入 `data/screener-results/{date}.json`。匯出 `runScreener()` 供其他腳本 import 使用。執行：`npx tsx scripts/run-screener.ts`。目前支援的條件型別：
  - `bollinger_breakout`（`direction: "upper"|"lower"`）、`volume_surge`（`multiplier`，當日量 > N 倍 20 日均量）、`volume_min`（`lots`，當日量 ≥ N 張，1 張 = 1000 股）：皆為單日可判斷條件，邏輯在 `checkCondition`。
  - `bandwidth_squeeze`（`threshold`、`days`）：判斷「最新交易日往回數 N 天，`bollingerBandwidth` 皆 < threshold」（連續性條件，遇 null 視為不符合）。因需要多天歷史，邏輯獨立在 `checkBandwidthPersistence`，主流程會依所有 `bandwidth_squeeze` 條件裡最大的 `days` 一次性批次查詢近 N 天 `TechnicalIndicator`（而非逐股票查詢），效能考量。
- **`scripts/fill-daily-quotes.ts`**（2026-08-17 由 `fill-gap-mi-index.ts` + `fill-today-tpex.ts` 合併而成）：補齊全市場報價，自動新增資料庫沒有的 `Stock` 記錄並 upsert `DailyQuote`。匯出兩個函式：
  - `fillOneDayTwse(date)`：用證交所 `MI_INDEX` 報表 API 補齊「指定單一天」的全上市（TWSE）市場報價，可補任意歷史日期。
  - `fillTodayTpex(expectedIsoDate?)`：用 TPEx OpenAPI `tpex_mainboard_daily_close_quotes` 補齊全上櫃（TPEx）市場報價；該端點不支援日期參數，永遠回傳「目前最新一天」，無法補歷史缺漏。`expectedIsoDate` 預設系統當天日期，若 API 回傳日期與預期不符（非交易日或資料尚未更新）會印出 `⚠` warning 並**跳過寫入**（不會把舊資料當成當日資料覆蓋進去），回傳 `isStaleDate: true` 供呼叫端（`daily-pipeline.ts`）判斷。
  執行：`npx tsx scripts/fill-daily-quotes.ts --date=YYYY-MM-DD`（CLI 模式會依序呼叫 `fillOneDayTwse(date)` 和 `fillTodayTpex()`）。
- **`scripts/calculate-industry-heat.ts`**：依 `DailyQuote` 計算各產業（Sector）每日等權熱度寫入 `IndustryHeatSnapshot`。漲跌幅用 `change / (close - change) * 100` 現算（`DailyQuote` 只有漲跌價差沒有漲跌幅）；排除無產業別、當日無成交（volume = 0）、前收 ≤ 0 的股票。匯出 `calculateOneDayHeat(date: Date)`。純資料庫計算，零 API 呼叫。執行：`npx tsx scripts/calculate-industry-heat.ts`（最近一個交易日）或 `--backfill 20`（往回補 20 個「有 DailyQuote 資料的日子」），結束後印出最新一日產業排名前 5 供目視抽查。
- **`scripts/fill-gap-valuation.ts`**：抓取指定日期的 TWSE（`BWIBBU_d`）+ TPEx（`peQryDate`）個股估值寫入 `StockValuation`，兩邊都可查任意歷史日期。只寫入 `Stock` 表已存在的代號（join 過濾），回傳日期與請求日期不符會直接 throw，回傳筆數與 Stock 表普通股差異 > 5% 會 log warning。匯出 `fillOneDayValuation(date: Date)`。執行：`npx tsx scripts/fill-gap-valuation.ts --date=YYYY-MM-DD`（也接受 `YYYYMMDD`；不帶參數抓今天）。
- **`scripts/update-shares-outstanding.ts`**：下載 MOPS 股本 CSV（上市 `t187ap03_L` + 上櫃 `t187ap03_O`）更新 `Stock.sharesOutstanding` 與 `sharesOutstandingUpdatedAt`。**獨立手動執行，不進 daily pipeline**，每月跑一次即可。執行：`npx tsx scripts/update-shares-outstanding.ts`。
- **`scripts/fill-institutional-trading.ts`**：抓取指定日期的 TWSE（`T86` 三大法人買賣超日報）+ TPEx（`tpex_3insti_daily_trading`）三大法人買賣超寫入 `InstitutionalTrading`。TWSE 支援任意歷史日期查詢，回傳日期與請求日期不符會直接 throw；TPEx 端點**不支援日期參數**，永遠回傳「目前最新一天」（跟 `tpex_mainboard_daily_close_quotes` 同樣限制），回傳日期與預期不同時印出 `⚠` warning 並**跳過寫入**（不寫入舊資料，回傳 `isStaleDate: true`）。欄位映射：TWSE `T86` 用「外陸資買賣超+外資自營商買賣超」→ `foreignNetBuy`、「投信買賣超」→ `investmentTrustNetBuy`、「自營商買賣超(合計)」→ `dealerNetBuy`；TPEx 因為原始欄位名稱不規則（大小寫/空格不一致），直接信賴其算好的 `*-Difference` 欄位，不自己重算 buy-sell。只 upsert `Stock` 表已存在的一般股票代號（`securityType = stock`），跟 `fill-gap-valuation.ts` 一樣不會自動新增股票（籌碼資料不該是新股票的來源），也會過濾掉回應中混雜的 ETF/權證/可轉債。匯出 `fillOneDayInstitutional(date: string)`。執行：`npx tsx scripts/fill-institutional-trading.ts --date=YYYY-MM-DD`（也接受 `YYYYMMDD`；不帶參數抓今天）。2026-08-23 已用 2026-08-21（交易日）與 2026-08-23（週日非交易日）雙路徑實測，抽查 2609/2892 兩檔股票數字與 API 原始回應逐位元核對正確。**尚無下游消費者**：`calculate-screen-score.ts`/`calculate-breakout-strength.ts` 目前都不讀這張表。
- **`scripts/daily-pipeline.ts`**：每日排程主控腳本，2026-08-23 改寫成五步：呼叫 `fillOneDayTwse(today)` + `fillTodayTpex(today)` 補齊今日報價 → 呼叫 `fillOneDayInstitutional(today)` 抓今日籌碼 → 呼叫 `fillOneDayValuation(today)` 抓今日估值（本益比/股價淨值比/殖利率）→ 呼叫 `calculateTechnicalIndicators()` 算技術指標 → 呼叫 `calculateOneDayHeat(最新一筆 DailyQuote 的日期)` 算產業熱度 → 印出總結。任一步驟失敗都會印出清楚的步驟/日期/錯誤訊息並以非 0 狀態碼結束。**非當日資料防呆**：報價步驟後檢查「TWSE 是否非交易日」與「TPEx 回傳日期是否為今天」，若**兩者皆無當日資料**，直接印出訊息、印出總結後 `return`，跳過籌碼/估值/技術指標/熱度（避免對著沒有新資料的一天空跑近 4 分鐘的技術指標計算）；只要任一邊有當日資料就繼續跑完全部步驟（TPEx 若過期只跳過自己那筆寫入，不影響其他步驟）。總結會印出「今日警告：N 則」（統計報價/籌碼兩處 TPEx 資料過期的次數）。歷史缺漏回補、`runScreener()` 跑篩選已移除，改為個別手動執行對應腳本（`fill-daily-quotes.ts`／`run-screener.ts` 本身都沒被修改，只是不再被此腳本呼叫）。執行：`npx tsx scripts/daily-pipeline.ts`。已驗證三種情境：平日交易日資料完整的正常路徑（exit code 0，2148 檔股票技術指標、44-45 個產業熱度）、今日非交易日的提前結束路徑（1.7 秒內結束，警告數正確為 1）、「TWSE 有資料但 TPEx 過期」混合情境的繼續執行判斷（模擬驗證）。搭配 `daily_pipeline.plist`（專案根目錄）用 launchd 每天 17:00 自動觸發，**plist 已建立但尚未由使用者手動複製到 `~/Library/LaunchAgents` 並 `launchctl bootstrap` 啟用**。
- **`scripts/fetch-candidate-details.ts`**：讀取 `data/screener-results/{日期}.json`（不帶 `--date` 則自動取目錄下最新一份）的候選股清單，對每支候選股依序（非平行）抓取四個面向並寫入資料庫：
  - 籌碼面：FinMind `TaiwanStockInstitutionalInvestorsBuySell`，近 30 天，依日期加總 `Foreign_Investor`/`Foreign_Dealer_Self`（外資）、`Investment_Trust`（投信）、`Dealer_self`/`Dealer_Hedging`（自營商）的 `buy - sell`，upsert 進 `InstitutionalTrading`。
  - 月營收：FinMind `TaiwanStockMonthRevenue`，近 12 個月，upsert 進 `MonthRevenue`（`revenueYoY`/`revenueMoM` 目前不計算，維持 null）。
  - 季報：FinMind `TaiwanStockFinancialStatements`，近 8 季，回應是「多筆細項組成一份財報」格式（每列一個 `type`），依 `type` 對應到 `revenue`/`grossProfit`/`operatingIncome`（`netIncome` 對應 `IncomeAfterTaxes`）/`eps` 五個欄位後彙整成一列，upsert 進 `FinancialStatement`。
  - 消息面：FinMind `TaiwanStockNews`，近 14 天。**注意：這支 API 不接受 `end_date` 參數**（帶了會回傳 400 錯誤），只能傳 `start_date` 讓 API 回傳「從該日期到現在」的全部資料，範圍收斂靠自己在本地過濾（用 `daysAgo(14)` 算出的日期字串轉成 `Date` 當 cutoff，取午夜 0 點而非當下時分秒，避免漏掉邊界日當天較早發布的新聞）。**同一則新聞常會因為 `source` 別名不同（如「ETtoday財經雲」vs「finance.ettoday.net」）在回應裡重複出現，需依 `link` 去重**，只保留第一筆。依 `link` 查詢 `NewsArticle` 是否已存在，不存在才 `create`，然後一律 `upsert` `NewsStock` 關聯（同一則新聞可能對應多支候選股）。
  單一步驟失敗不中斷整支腳本，會記錄下來繼續跑下一步，最後總結報告列出所有失敗的股票代號+步驟+錯誤原因。每次 API 呼叫間隔 6 秒節流。執行：`npx tsx scripts/fetch-candidate-details.ts --date=2026-08-18`。2026-08-18 已用 23 檔候選股實測成功，零失敗（處理時間約 10 分鐘/次）。
- **`scripts/calculate-screen-score.ts`**：針對「最新交易日」全市場一般股票（`securityType = "stock"`），用九因子加權概念算出 0~100 的 `screenScore` 並輸出排名，是獨立於 `run-screener.ts` 的全市場評分（不是布林條件式篩選，是排序），零 LLM、零額外外部 API 呼叫。九個因子：`value`（PE/PB 排名）、`size`（市值 log10 排名）、`liquidity`（成交金額 log10 排名）、`momentum`（當日+60日漲跌幅、MACD 加減分）、`reversal`（理想反彈起點、RSI 超買超賣）、`activity`（量比+換手率）、`stability`（波動度/最大回撤/ATR 扣分）、`theme_heat`（讀 `IndustryHeatSnapshot`）、`topic_alignment`（固定中性 50 分，尚無題材 Tag 系統）。核心共用函式 `rankScore()`（橫向百分位排名）已單元測試過三種邊界情況。加權設定在 `WEIGHTS` const，`topic_alignment` 權重為 0，加總時用「有效權重總和」正規化。匯出 `calculateScreenScore(date)`。結果不寫資料庫，輸出至 `data/screen-score-results/{date}.json`，同時 console.log 印前 20 名。執行：`npx tsx scripts/calculate-screen-score.ts --date=YYYY-MM-DD`（不帶參數用最新交易日）。依賴 `TechnicalIndicator`/`StockValuation`/`IndustryHeatSnapshot`/`Stock.sharesOutstanding` 皆已是當天最新資料（程式碼層級不 import 其他腳本，但執行順序上依賴它們先跑過）。2026-08-18 已用全市場 1947 檔實測成功。
- **`scripts/calculate-breakout-strength.ts`**：Layer 1「自動選股」核心腳本，回答「今天市場的焦點在哪」，篩出**帶量帶價第一根突破布林**的股票並依訊號強度排名。與 `calculate-screen-score.ts` 相反的設計哲學：所有評分公式皆單調遞增（越極端分數越高），不用鐘形曲線、不設追高懲罰。零 LLM、零額外外部 API，資料全來自 `DailyQuote`/`TechnicalIndicator`/`Stock`。三層結構：
  - **第一層觸發**（boolean）：今日收盤 > 今日 `bollingerUpper`，且今日 `volume / volumeMa20 ≥ 2.0`；任一指標為 null 直接不進候選。
  - **第二層資格門檻**（boolean，`GATES` const 可調）：市值（`sharesOutstanding × close ≥ 50億`，null 視為不通過並單獨計數 log，不靜默丟棄）、成交量（`≥ 1000 張`）。
  - **第三層強度評分**（六項加權合併，`WEIGHTS` const 可調）：`volumeStrength`（量能倍數，2~6倍線性 40~100分）、`breakoutMargin`（突破幅度，0~3%線性 40~100分）、`firstBar`（第一根判定：昨日收在帶內=100分，連續2天=50分，連續3天以上=20分）、`base`（位階/壓縮品質，**只用 T-1 以前資料**，突破棒本身不參與，含壓縮深度百分位與壓縮時長兩子項）、`proximityToHigh`（距60日/240日高點位置，短長各半權重）、`relativeStrength`（**對全市場所有普通股**先算 60 日報酬率橫向百分位，候選股再查自己的百分位，不是候選股互相比較）。
  - **資料深度不足時的降級規則**：資料庫目前約 90 個日曆日（~60 個交易日）歷史，所有需回看歷史的計算（`base` 的 240 日 bandwidth 分布、`proximityToHigh` 的 240 日高點）都寫成「視窗上限 N 天、實際用現有資料、不足門檻時該項給中性 50 分並標記 `degraded`」，`historyDays` 記錄實際用到的天數；未來歷史補齊後不需改程式碼，自動用滿設計視窗。
  匯出 `calculateBreakoutStrength(date)`。結果不寫資料庫，輸出至 `data/breakout-strength-results/{date}.json`（含 `gates`/`weights`/`stats`/`results`），console 印候選股表格。執行：`npx tsx scripts/calculate-breakout-strength.ts --date=YYYY-MM-DD`（不帶參數用最新交易日）。**不修改** `run-screener.ts`/`calculate-screen-score.ts`/`daily-pipeline.ts`，先獨立跑，穩定後再討論是否整合。2026-08-19 已用 2026-08-18 全市場 1947 檔資料實測（觸發 33 檔、通過門檻 16 檔），完成 PLAN.md 全部 5 項驗證（候選名單合理性、firstBar 抽查、stats 遞減、重跑一致性、null 市值防禦）。**2026-08-24 重構**：`GATES`/`WEIGHTS`/`TRIGGER_VOLUME_RATIO` 等常數與六項評分純函式、`fetchHistoryWindow` 已抽到 `scripts/breakout-shared.ts`，本檔案改為從該檔案 import（不再各自維護一份邏輯），供 `check-intraday-breakout.ts` 共用。
- **`scripts/breakout-shared.ts`**：`calculate-breakout-strength.ts` 與 `check-intraday-breakout.ts` 共用的純函式庫，2026-08-24 從前者抽出。內容：`GATES`/`WEIGHTS`/`TRIGGER_VOLUME_RATIO`/`BASE_MAX_WINDOW_DAYS`/`RS_WINDOW_DAYS` 常數、`HistoryPoint` 型別、`rankScore`（橫向百分位排名）、`clip`、`fetchHistoryWindow`（查 T-1 往前 N 筆 close+bollingerBandwidth）、`computeVolumeStrength`/`computeBreakoutMargin`/`computeFirstBar`/`computeBase`/`computeProximityToHigh`/`computeMarketWideReturns` 六項評分計算函式。不含任何 Prisma client 初始化或 CLI 邏輯，純計算。
- **`scripts/check-intraday-breakout.ts`**：盤中一次性快照篩選，把 `calculate-breakout-strength.ts` 的三層邏輯（觸發→門檻→評分）提前套用在盤中即時價格上，回答「收盤前該注意哪些股票」。**一次性手動執行，不排程、不接進 `daily-pipeline.ts`**。資料源是 `mis.twse.com.tw/stock/api/getStockInfo.jsp` 即時報價端點（社群逆向工程，非官方文件，欄位可能無預警變動），依 `Stock.market` 判斷 `tse_`/`otc_` 前綴（不猜測重試），每批最多 120 檔、批次間隔 1.5 秒節流，單批失敗只記錄不中斷。關鍵計算：`elapsedRatio`（開盤 09:00 到查詢當下的時間比例，現算後 clip 到 `[0.05, 1.0]`）把累計成交量換算成 `estimatedFullDayVolume`；下限（開盤前）印警告，上限（收盤後，此時預估量即完整全天量）不印警告，兩種情境分開處理不合併。另外偵測 MIS 回傳日期與資料庫最新 `DailyQuote` 日期是否相同（相同代表可能是開盤前或 pipeline 尚未執行，印警告但不中斷；專案無交易日曆表，只做「相不相同」二分判斷，不判斷「差一個交易日」）。第一層觸發用**即時價 vs T-1 `bollingerUpper`**（而非當日布林，當天布林要收盤後才有）；第三層評分完整重用 `breakout-shared.ts` 的六項函式與權重，其中 `base`/`proximityToHigh`/`relativeStrength`/`firstBar` 連續天數判斷的輸入本來就是 T-1 以前資料，同一天內查詢結果不變（約 65% 權重不隨盤中價格變動，是已知且使用者確認接受的權衡）。結果不寫資料庫，輸出 JSON 快照至 `data/intraday-breakout-snapshots/{timestamp}.json`（檔名含完整時間戳記，同一天可執行多次不覆蓋）。執行：`npx tsx scripts/check-intraday-breakout.ts`（無參數，不支援 `--date`）。2026-08-24 已實測執行成功（1727 檔查詢、0 批次失敗、45 檔觸發、22 檔通過門檻）。

## README.md 維護

修改功能、新增腳本、調整環境需求或專案結構時，順手檢查 [README.md](README.md) 是否還反映目前狀態（尤其是「目前功能」與「使用方式」區塊），過時就一併更新，不要留給下次對話才發現。
