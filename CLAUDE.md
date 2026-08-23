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

尚未開始/明確不做：估值歷史回補（`fill-gap-valuation.ts` 已支援 `--date` 隨時可補，但依計畫不主動回補）、heatScore 欄位與市值加權熱度（第一版等權即可，分數用時現算）、股本更新排程（月頻手動跑）、新聞情緒分析（`NewsArticle.sentiment`/`sentimentScore` 欄位已存在但尚未有腳本填值）、Tag/StockTag 篩選邏輯（`topic_alignment` 因子固定中性分）、WatchlistItem 操作介面、AnalysisResult 產出流程（Phase D）、`daily-pipeline.ts` 的 cron 排程設定（腳本已可手動執行，但還沒排程）、`fetch-candidate-details.ts`、`calculate-screen-score.ts`、`calculate-breakout-strength.ts` 皆尚未整合進 `daily-pipeline.ts`（目前是獨立手動執行的腳本）、`WEIGHTS` 權重調整（`calculate-screen-score.ts` 與 `calculate-breakout-strength.ts` 目前都是規劃文件給的初始值，未來可能需依實際排名結果微調）。

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
  - `fillTodayTpex()`：用 TPEx OpenAPI `tpex_mainboard_daily_close_quotes` 補齊全上櫃（TPEx）市場報價；該端點不支援日期參數，永遠回傳「目前最新一天」，無法補歷史缺漏。
  執行：`npx tsx scripts/fill-daily-quotes.ts --date=YYYY-MM-DD`（CLI 模式會依序呼叫 `fillOneDayTwse(date)` 和 `fillTodayTpex()`）。
- **`scripts/calculate-industry-heat.ts`**：依 `DailyQuote` 計算各產業（Sector）每日等權熱度寫入 `IndustryHeatSnapshot`。漲跌幅用 `change / (close - change) * 100` 現算（`DailyQuote` 只有漲跌價差沒有漲跌幅）；排除無產業別、當日無成交（volume = 0）、前收 ≤ 0 的股票。匯出 `calculateOneDayHeat(date: Date)`。純資料庫計算，零 API 呼叫。執行：`npx tsx scripts/calculate-industry-heat.ts`（最近一個交易日）或 `--backfill 20`（往回補 20 個「有 DailyQuote 資料的日子」），結束後印出最新一日產業排名前 5 供目視抽查。
- **`scripts/fill-gap-valuation.ts`**：抓取指定日期的 TWSE（`BWIBBU_d`）+ TPEx（`peQryDate`）個股估值寫入 `StockValuation`，兩邊都可查任意歷史日期。只寫入 `Stock` 表已存在的代號（join 過濾），回傳日期與請求日期不符會直接 throw，回傳筆數與 Stock 表普通股差異 > 5% 會 log warning。匯出 `fillOneDayValuation(date: Date)`。執行：`npx tsx scripts/fill-gap-valuation.ts --date=YYYY-MM-DD`（也接受 `YYYYMMDD`；不帶參數抓今天）。
- **`scripts/update-shares-outstanding.ts`**：下載 MOPS 股本 CSV（上市 `t187ap03_L` + 上櫃 `t187ap03_O`）更新 `Stock.sharesOutstanding` 與 `sharesOutstandingUpdatedAt`。**獨立手動執行，不進 daily pipeline**，每月跑一次即可。執行：`npx tsx scripts/update-shares-outstanding.ts`。
- **`scripts/daily-pipeline.ts`**：每日排程主控腳本，串接上述腳本：檢查 `DailyQuote` 最新日期與今天的差距→依序（非平行）呼叫 `fillOneDayTwse` 補齊每個缺漏日期（僅 TWSE，TPEx 無法補歷史）→呼叫 `fillOneDayTwse(today)` + `fillTodayTpex()` 確保今天 TWSE、TPEx 都是最新→呼叫 `calculateTechnicalIndicators()`→呼叫 `fillOneDayValuation(today)` 抓估值、`calculateOneDayHeat(最新交易日)` 算產業熱度（這兩步失敗只 log 不中斷，其餘步驟照跑）→呼叫 `runScreener()`→印出總結。任何步驟失敗會印出清楚的步驟/日期/錯誤訊息並以非 0 狀態碼結束。執行：`npx tsx scripts/daily-pipeline.ts`。**目前僅能手動執行，尚未設定 cron 排程，也尚未串接 `fetch-candidate-details.ts`。**
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
  匯出 `calculateBreakoutStrength(date)`。結果不寫資料庫，輸出至 `data/breakout-strength-results/{date}.json`（含 `gates`/`weights`/`stats`/`results`），console 印候選股表格。執行：`npx tsx scripts/calculate-breakout-strength.ts --date=YYYY-MM-DD`（不帶參數用最新交易日）。**不修改** `run-screener.ts`/`calculate-screen-score.ts`/`daily-pipeline.ts`，先獨立跑，穩定後再討論是否整合。2026-08-19 已用 2026-08-18 全市場 1947 檔資料實測（觸發 33 檔、通過門檻 16 檔），完成 PLAN.md 全部 5 項驗證（候選名單合理性、firstBar 抽查、stats 遞減、重跑一致性、null 市值防禦）。

## README.md 維護

修改功能、新增腳本、調整環境需求或專案結構時，順手檢查 [README.md](README.md) 是否還反映目前狀態（尤其是「目前功能」與「使用方式」區塊），過時就一併更新，不要留給下次對話才發現。
