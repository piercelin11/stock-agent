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

進度詳情記錄在 [docs/PROGRESS.md](docs/PROGRESS.md)，不寫在這裡。每次完成功能或做出重大調整，記得同步更新該檔案。

## 既有腳本

`scripts/` 依用途分子資料夾：`pipeline/`（每日自動跑）、`screening/`（要選股時手動跑）、`backfill/`（偶爾手動回補）、`lib/`（純函式庫，無 Prisma/CLI，多處共用）、`archive/`（已停用、留著參考，不刪不維護）。移動腳本時記得一併更新這裡與 README 的路徑。

### `scripts/pipeline/` — 每日排程

- **`daily-pipeline.ts`**：每日排程主控腳本，五步：補今日 TWSE+TPEx 報價 → 抓今日籌碼 → 抓今日估值 → 算技術指標 → 算產業熱度。任一步驟失敗印錯誤並非 0 結束。**非當日資料防呆**：報價步驟後若 TWSE+TPEx 皆無當日資料，提前結束整支 pipeline 並印警告數。無 `isMain` guard，`import` 這支即會執行 `main()`。`npx tsx scripts/pipeline/daily-pipeline.ts`。搭配 `daily_pipeline.plist`（每天 17:00 觸發，**尚未部署到 launchd、檔案也尚未建立**）。
- **`fill-daily-quotes.ts`**：補齊全市場報價，自動新增 `Stock`、upsert `DailyQuote`。匯出 `fillOneDayTwse(date)`（`MI_INDEX`，可補任意歷史日）與 `fillTodayTpex(expectedIsoDate?)`（TPEx OpenAPI，只能拿「目前最新一天」，日期不符會跳過寫入並回傳 `isStaleDate: true`）。對外 fetch 走 `lib/http.ts` 的 `fetchJson`（3 次 retry + 30s timeout）。`npx tsx scripts/pipeline/fill-daily-quotes.ts --date=YYYY-MM-DD`。
- **`fill-institutional-trading.ts`**：抓指定日期 TWSE（`T86`，可查任意歷史日）+ TPEx（`tpex_3insti_daily_trading`，只能拿最新一天）三大法人買賣超寫入 `InstitutionalTrading`。只 upsert 已存在的一般股票，不新增股票。對外 fetch 走 `lib/http.ts` 的 `fetchJson`。匯出 `fillOneDayInstitutional(date)`。`npx tsx scripts/pipeline/fill-institutional-trading.ts --date=YYYY-MM-DD`。**尚無下游消費者**（`calculate-breakout-strength.ts` 不讀，`calculate-accumulation-score.ts` 有讀）。
- **`fill-gap-valuation.ts`**：抓指定日期 TWSE（`BWIBBU_d`）+ TPEx（`peQryDate`）估值寫入 `StockValuation`，兩邊皆可查任意歷史日期。對外 fetch 走 `lib/http.ts` 的 `fetchJson`。匯出 `fillOneDayValuation(date)`。`npx tsx scripts/pipeline/fill-gap-valuation.ts --date=YYYY-MM-DD`（不帶參數抓今天）。
- **`calculate-technical-indicators.ts`**：依 `DailyQuote` 算 MA5/10/20/60、布林通道、量能均線、`volatility20d`/`maxDrawdown20d`/`atr20`/`rsi14`/`macdStatus`，寫入 `TechnicalIndicator`（對每支股票的全部歷史 `DailyQuote` 逐日重算）。匯出 `calculateTechnicalIndicators(codes?: string[])`——傳代號陣列只重算那幾支，不傳跑全市場一般股票。`npx tsx scripts/pipeline/calculate-technical-indicators.ts`（全市場）或 `... 4104 2330`（指定股票）。
- **`calculate-industry-heat.ts`**：依 `DailyQuote` 算各產業每日等權熱度寫入 `IndustryHeatSnapshot`（純資料庫計算，零 API）。匯出 `calculateOneDayHeat(date)`。`npx tsx scripts/pipeline/calculate-industry-heat.ts`（最近交易日）或 `--backfill 20`。

### `scripts/screening/` — 選股（手動）

- **`calculate-breakout-strength.ts`**：篩出帶量帶價第一根突破布林的股票並依訊號強度排名（三層：觸發→資格門檻→強度評分，評分公式皆單調遞增，不用鐘型曲線）。共用邏輯在 `lib/breakout-shared.ts`。結果不寫資料庫，輸出至 `data/breakout-strength-results/{date}.json`。匯出 `calculateBreakoutStrength(date)`。`npx tsx scripts/screening/calculate-breakout-strength.ts --date=YYYY-MM-DD`。
- **`calculate-accumulation-score.ts`**：盤後選股 v2「投信吃貨訊號」——找還沒出現第一根突破、但籌碼/技術面在醞釀的股票，與 `calculate-breakout-strength.ts`（找已發生的突破）互補。計分為**乘法結構**：`最終分數 = 籌碼分數 × 技術就緒係數`。籌碼分數（主排序依據）= 投信分數 × 0.7 + 其他法人分數 × 0.3；技術就緒係數 = 壓縮度/窒息量合成後線性映射到 `READINESS_FLOOR`~1.0（下限 0.5）。候選池先剔除「今日已站上布林上軌」（與突破清單互斥）與「近 20 日均量 < `MIN_AVG_VOLUME_SHARES`(=500 張)」（低流動性死股）。結果不寫資料庫，輸出至 `data/accumulation-score-results/{date}.json`（`code`+`date` 欄位格式對齊突破腳本，方便日後回測命中率）。匯出 `calculateAccumulationScore(date)`。`npx tsx scripts/screening/calculate-accumulation-score.ts --date=YYYY-MM-DD`。**獨立手動執行，不進 daily-pipeline**。待校準參數集中在 `lib/accumulation-shared.ts`，首版未校準（前段偏大型股）。
- **`check-intraday-breakout.ts`**：盤中一次性快照篩選，把 `calculate-breakout-strength.ts` 的三層邏輯套用在 `mis.twse.com.tw` 即時報價上（社群逆向工程端點，非官方文件）。**一次性手動執行，不排程、不接進 daily-pipeline**，不支援 `--date`。批次查詢（120 檔/批，1.5 秒節流），`elapsedRatio` 現算預估全天量。與 `calculate-breakout-strength.ts` 評分邏輯 100% 共用，但當日 close/volume/OHLC/布林上軌全是即時或估計值（vs 盤後版的定案值），比較基準日也差一天（即時價 vs T-1 上軌）。結果輸出至 `data/intraday-breakout-snapshots/{timestamp}.json`。`npx tsx scripts/screening/check-intraday-breakout.ts`。

### `scripts/backfill/` — 歷史回補（偶爾手動）

- **`backfill-daily-quotes.ts`**：FinMind 逐支回補歷史報價至 `DailyQuote`（只跑 `securityType=stock`）。回補區間為 `BACKFILL_START_DATE`（預設 `2020-01-01`）到執行當天，實測 FinMind 單支查詢 6 年不會被截斷。`npx tsx scripts/backfill/backfill-daily-quotes.ts`（`BACKFILL_LIMIT` 限制測試支數；`BACKFILL_START_DATE=YYYY-MM-DD` 覆蓋起始日）。
- **`backfill-institutional-trading.ts`**：逐支一般股票用 FinMind 回補歷史三大法人買賣超至 `InstitutionalTrading`（TWSE 可回補任意歷史，TPEx 受端點限制效果有限）。回補區間同上。單支失敗不中斷。`npx tsx scripts/backfill/backfill-institutional-trading.ts`（`BACKFILL_LIMIT=10` 小量測試）。**已執行完成（首輪）**：`InstitutionalTrading` 現有 2025-05-02 起 324 個交易日、約 59 萬筆、1989 檔（2026-08-27 起以 `2020-01-01` 起始日重跑回補至 6 年，回補結果待確認實際覆蓋範圍）。
- **`backfill-benchmark-quotes.ts`**：FinMind 回補回測用大盤基準標的的 `DailyQuote`（目前 `BENCHMARK_CODES = ["0050"]`，要加 006208／其他改陣列）。**只寫 `DailyQuote`，不碰 `TechnicalIndicator` / `InstitutionalTrading`**——基準只需要收盤價算報酬。0050 為未還原股價，除息日 `close` 含假跌幅；若基準報酬對除息敏感，日後改抓 `TaiwanStockPriceAdj`。`npx tsx scripts/backfill/backfill-benchmark-quotes.ts`。**已執行**：0050 已補 2020-01-02 ~ 今，約 1612 筆。
- **`update-shares-outstanding.ts`**：下載 MOPS 股本 CSV 更新 `Stock.sharesOutstanding`。**獨立手動執行，月頻，不進 daily pipeline**。`npx tsx scripts/backfill/update-shares-outstanding.ts`。

### `scripts/lib/` — 純函式庫

- **`http.ts`**：`daily-pipeline.ts` 三個抓取步驟共用的 HTTP 工具（無 Prisma/CLI）。匯出 `fetchJson<T>(url, options?)`：每次嘗試帶 `AbortSignal.timeout`（預設 30s），對網路層拋錯（`ECONNRESET`/`terminated`/timeout）與 5xx/429 自動退避重試（預設 3 次，2s→4s），對其他 4xx 不重試。存在理由：pipeline 無人值守執行，裸 fetch 遇一次 TLS 連線中斷就整條掛掉（2026-08-28 事故）。**回應內容判斷（非交易日 `stat`/`totalCount`/空陣列）仍留在各呼叫端**。`backfill-*.ts` 等手動腳本目前未接。
- **`breakout-shared.ts`**：`calculate-breakout-strength.ts` 與 `check-intraday-breakout.ts` 共用（無 CLI，但 import 了 `PrismaClient` 型別 + `fetchHistoryWindow` 會查 DB）。內容：`GATES`/`WEIGHTS`/`TRIGGER_VOLUME_RATIO` 等常數、`rankScore`/`clip`/`fetchHistoryWindow`，以及 `computeVolumeStrength`/`computeBreakoutMargin`/`computeFirstBar`/`computeBase`/`computeProximityToHigh`/`computeMarketWideReturns`/`computeCandleShape` 七項評分函式。目前 `computeBreakoutMargin` 為鐘型曲線（乖離 >3% 遞減）、`GATES.minMarketCap` 為 30 億。
- **`accumulation-shared.ts`**：`calculate-accumulation-score.ts` 的純函式庫（無 Prisma/CLI）。內容：視窗/門檻常數（`INSTITUTIONAL_WINDOW_DAYS=20`、`SQUEEZE_VOLUME_WINDOW_DAYS=5`、`MIN_AVG_VOLUME_SHARES`、`READINESS_FLOOR` 等）、待校準權重常數、`rankScore`/`clip`，以及 `computeTrustRawMetrics`/`computeOtherInstitutionRatio`/`computeQuietVolumeRatio`/`combineChipScore`/`combineTrustScore`/`computeReadinessCoefficient`/`combineFinalScore`。壓縮度分數直接沿用 `breakout-shared.ts` 的 `computeBase`。

### `scripts/archive/` — 已停用，不維護

- **`calculate-screen-score.ts`**：全市場九因子加權排序（value/size/liquidity/momentum/reversal/activity/stability/theme_heat/topic_alignment）。已由 breakout + accumulation 兩支取代，停用。
- **`run-screener.ts` + `screener-conditions.json`**：選股 v1（布林 `bollinger_breakout`/`volume_surge`/`bandwidth_squeeze` 條件式篩選）。已由 `calculate-breakout-strength.ts` 的三層邏輯取代，停用。
- **`fetch-candidate-details.ts`**：讀 v1 的 `data/screener-results/{date}.json` 候選股清單逐支抓籌碼/月營收/季報/新聞。輸入來源（v1 篩選器）已停用，一併封存；若日後要對 breakout/accumulation 候選股做深度抓取，改讀對應輸出重寫。
- **`top20-gainers.js`**：最早的一次性玩具，抓當日資料印漲幅前 20 名。功能已被 `calculate-breakout-strength.ts` 涵蓋。

各腳本的設計理由、實測數字、修正過程記錄在 [docs/PROGRESS.md](docs/PROGRESS.md)，這裡只列現況。

## docs/PROGRESS.md 維護

完成功能、修 bug、或做出設計調整後，順手更新 [docs/PROGRESS.md](docs/PROGRESS.md) 對應段落，不要留給使用者提醒才補。這份文件是「目前進度」的詳細記錄（逐次累積，含實測數字與驗證過程），跟 CLAUDE.md（穩定知識）、`docs/ROADMAP.md`（打勾式任務清單）、`docs/PLAN.md`（單一任務規格書，做完即被取代）角色不同，不要混用。

## README.md 維護

修改功能、新增腳本、調整環境需求或專案結構時，順手檢查 [README.md](README.md) 是否還反映目前狀態（尤其是「目前功能」與「使用方式」區塊），過時就一併更新，不要留給下次對話才發現。

## docs/ROADMAP.md 維護

完成 ROADMAP 上的某個 todo 項目後，順手把對應的 `- [ ]` 打勾成 `- [x]`，不要留給使用者自己對照勾選。若某個階段（如「1. 盤後選股 v2」）底下所有項目都打勾完成，在該次回覆裡明確提醒使用者這個階段已全部完成；若整份 ROADMAP 所有階段都完成，額外提醒使用者可以考慮規劃下一輪內容。這份文件是持續累積更新的（做完的項目打勾保留、不刪除），跟 `docs/PLAN.md`（單一任務的實作規格書，做完即被下一份取代）角色不同，不要混用或互相覆蓋內容。
