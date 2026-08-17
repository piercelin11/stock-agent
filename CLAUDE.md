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

尚未開始：新聞抓取與情緒分析、三大法人籌碼（`InstitutionalTrading`）抓取、月營收/財報（`MonthRevenue`/`FinancialStatement`）抓取、Tag/StockTag 篩選邏輯、WatchlistItem 操作介面、AnalysisResult 產出流程、`daily-pipeline.ts` 的 cron 排程設定（腳本已可手動執行，但還沒排程）。

（每次進度更新，麻煩幫我一併更新這個區塊。）

## 既有腳本

- **`top20-gainers.js`**（專案根目錄，非 TypeScript，尚未整合進 `/scripts` 或資料庫）：抓取當日 TWSE + TPEx 收盤資料，篩選出一般股票（排除 ETF、權證、特別股等），依漲幅排序印出前 20 名。執行方式：`node top20-gainers.js`。之後若要整合進資料庫流程，需改寫成 TypeScript 並搬進 `/scripts`，把結果寫入 `DailyQuote` 而非只印出。
- **`scripts/backfill-daily-quotes.ts`**：用 FinMind API 逐支股票回補近 120 天歷史報價至 `DailyQuote`。執行：`npx tsx scripts/backfill-daily-quotes.ts`（可用 `BACKFILL_LIMIT` 環境變數限制處理支數，測試用）。
- **`scripts/calculate-technical-indicators.ts`**：依 `DailyQuote` 計算 MA5/10/20/60、布林通道、量能均線，寫入 `TechnicalIndicator`。匯出 `calculateTechnicalIndicators()` 供其他腳本 import 使用。執行：`npx tsx scripts/calculate-technical-indicators.ts`。
- **`scripts/run-screener.ts`**：讀取 `scripts/screener-conditions.json` 的條件（目前支援 `bollinger_breakout`、`volume_surge`），對最新交易日跑全市場篩選，結果印出並寫入 `data/screener-results/{date}.json`。匯出 `runScreener()` 供其他腳本 import 使用。執行：`npx tsx scripts/run-screener.ts`。
- **`scripts/fill-daily-quotes.ts`**（2026-08-17 由 `fill-gap-mi-index.ts` + `fill-today-tpex.ts` 合併而成）：補齊全市場報價，自動新增資料庫沒有的 `Stock` 記錄並 upsert `DailyQuote`。匯出兩個函式：
  - `fillOneDayTwse(date)`：用證交所 `MI_INDEX` 報表 API 補齊「指定單一天」的全上市（TWSE）市場報價，可補任意歷史日期。
  - `fillTodayTpex()`：用 TPEx OpenAPI `tpex_mainboard_daily_close_quotes` 補齊全上櫃（TPEx）市場報價；該端點不支援日期參數，永遠回傳「目前最新一天」，無法補歷史缺漏。
  執行：`npx tsx scripts/fill-daily-quotes.ts --date=YYYY-MM-DD`（CLI 模式會依序呼叫 `fillOneDayTwse(date)` 和 `fillTodayTpex()`）。
- **`scripts/daily-pipeline.ts`**：每日排程主控腳本，串接上述腳本：檢查 `DailyQuote` 最新日期與今天的差距→依序（非平行）呼叫 `fillOneDayTwse` 補齊每個缺漏日期（僅 TWSE，TPEx 無法補歷史）→呼叫 `fillOneDayTwse(today)` + `fillTodayTpex()` 確保今天 TWSE、TPEx 都是最新→呼叫 `calculateTechnicalIndicators()`→呼叫 `runScreener()`→印出總結。任何步驟失敗會印出清楚的步驟/日期/錯誤訊息並以非 0 狀態碼結束。執行：`npx tsx scripts/daily-pipeline.ts`。**目前僅能手動執行，尚未設定 cron 排程。**

## README.md 維護

修改功能、新增腳本、調整環境需求或專案結構時，順手檢查 [README.md](README.md) 是否還反映目前狀態（尤其是「目前功能」與「使用方式」區塊），過時就一併更新，不要留給下次對話才發現。
