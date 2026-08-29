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
- **套件管理器是 pnpm**（2026-08-28 從 npm 轉換）。`package.json` 的 `packageManager` 欄位鎖 `pnpm@8.15.4`（corepack）。`.npmrc` 設 `node-linker=hoisted`——扁平 `node_modules` 佈局，讓 `generated/prisma` client、tsx 腳本、plist 的絕對路徑都能照舊解析，代價是放棄 pnpm 的嚴格 phantom-dependency 檢查。指令一律 `pnpm ...`（`pnpm dev` / `pnpm tsx scripts/...` / `pnpm prisma ...` / `pnpm exec tsc --noEmit`）。lockfile 是 `pnpm-lock.yaml`，`package-lock.json` 已刪。
- 新增/更新基礎資料（股票清單、產業別）用 `pnpm prisma db seed`（會執行 `prisma/seed.ts`），不要每次手寫新腳本。
- `.env` 的資料庫連線變數名稱是 Prisma 預設的 `DATABASE_URL`。
- **Prisma 版本為 7.9.1**（比原始規劃文件 `docs/PLAN.md` 假設的版本新），與舊版 Prisma 有以下差異，之後新增功能時要注意：
  - 連線字串不寫在 `schema.prisma` 的 `datasource.url`，而是在 `prisma.config.ts` 的 `datasource.url`（仍然讀取 `DATABASE_URL`）。
  - `PrismaClient` 需要搭配 driver adapter 初始化，本專案用 `@prisma/adapter-pg`：
    ```ts
    import { PrismaPg } from "@prisma/adapter-pg";
    import { PrismaClient } from "../generated/prisma/client";
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    ```
  - Prisma Client 產出位置是 `generated/prisma`（非預設的 `node_modules/@prisma/client`），且是 ESM-only（用了 `import.meta.url`），因此整個專案 `package.json` 設定為 `"type": "module"`。
  - **`schema.prisma` 的 `generator client` 設 `importFileExtension = ""`**（2026-08-28 加）：讓 generated client 內部的相對 import 不帶副檔名，這樣 tsx（`scripts/`，nodenext）與 Turbopack（`app/`，bundler resolution）都能解析。原本預設帶 `.js` 會讓 Turbopack 找不到 `./enums.ts` 等檔。**因此 import client 時也不要帶 `.js`**（`from "../generated/prisma/client"`，舊腳本裡殘留的 `.js` 仍能跑但不一致）。改 schema 後要 `pnpm prisma generate`。
  - TS 執行工具用 **tsx**，不是 `ts-node`（`ts-node` 與剛發布的 TypeScript 7 新架構不相容）。
  - Prisma seed 指令設定在 `prisma.config.ts` 的 `migrations.seed`，不是 `package.json` 的 `"prisma"` 欄位（後者在 Prisma 7 已不生效）。
  - `prisma.config.ts` 的 `datasource.url` 寫 `process.env["DATABASE_URL"] ?? ""`（`?? ""` 是為了滿足 `exactOptionalPropertyTypes`，否則 `next build` 的整專案 typecheck 會失敗）。

## 前端（Next.js + Prisma）

2026-08-28 建立的前端骨架（ROADMAP 第 2 節）。這階段只搭殼，業務頁面留給後續 PLAN。

- **技術棧**：Next.js 16.3.3（App Router，Turbopack）+ React 19 + Tailwind CSS v4 + Recharts 3。TS 7 / Prisma 7 / ESM 這組合實測直接可跑，沒有降版或改 webpack。
- **目錄**：前端在 repo 根目錄 `app/`（**不開 `web/` 子目錄、不做 monorepo**）——前端要 import 的 `generated/prisma`、`scripts/screening/*`、`scripts/lib/*` 都在根目錄，開子目錄只會讓 import path 變複雜。
- **`lib/`（根目錄，新）vs `scripts/lib/`（既有）**：`lib/` 放 **Next/React 世界**的共用碼（Prisma 單例、Server Actions、格式化 helper）；`scripts/lib/` 維持是**純 Node 函式庫**（`http.ts` / `breakout-shared.ts` / `accumulation-shared.ts` / `types.ts`），不 import React。兩個名字相近但職責分明。
- **Prisma 單例**：`lib/prisma.ts` 把 `PrismaClient` 掛 `globalThis` 快取（dev hot reload 不會爆連線池），保留 `PrismaPg` driver adapter 寫法。**檔頭 `import "server-only"`**——`scripts/lib/` 與 `lib/` 名字太像，這是唯一能在 build 時擋下「client component 誤 import `lib/prisma.ts`」的機制。只能在 Server Component / Server Action import。
- **Server Actions**（不建 REST/GraphQL）：檔案放 `lib/actions/*.ts`，檔頭 `"use server"`。action 只做「呼叫 Prisma / 純函式 → 回傳可序列化 plain object」。回傳 `Date` 要先轉字串、`Decimal` 要 `.toNumber()` / `.toString()`，在 action 邊界轉掉（`Decimal` 直接丟 client component 會壞）。
- **`app/page.tsx` 等會查 DB 的頁面檔頭加 `export const dynamic = "force-dynamic";`**——否則 `next build` 會試圖靜態預渲染、在 build time 連本機 Postgres（CI / 沒開 DB 時直接失敗）。
- **`*.css` import**：tsconfig 有 `noUncheckedSideEffectImports: true`，會擋 `import "./globals.css"`。對策是 `app/globals.css.d.ts` 內容 `declare module "*.css";`。**不要為此關掉該旗標**（`scripts/` 也吃這個旗標）。
- **`next.config.ts` 的 `serverExternalPackages`**：列 `@prisma/client` / `@prisma/adapter-pg` / `pg`，讓 Prisma 相關套件走 Node 原生 require 不進 bundler（generated client 用 `import.meta.url` 定位 engine，被打包會找不到路徑）。
- **背景任務**：模式是「Server Action `spawn` 一個 detached 子進程 → 子進程每步覆寫 `data/xxx/progress.json` → 另一個 Server Action 輪詢讀檔 → client component `setInterval` poll」。**`spawn` 用 `process.execPath` + `node_modules/tsx/dist/cli.mjs` 絕對路徑 + 目標腳本當參數**，不要用 `pnpm tsx` / `npx tsx`（detached 子進程解析 launcher 慢、PATH 依賴）。`.npmrc` 設 `node-linker=hoisted`，所以 `node_modules/tsx/dist/cli.mjs` 是扁平路徑、解析得到。（PoC 檔案 `scripts/_poc/` + `lib/actions/poc.ts` + `components/PocRunner.tsx` 已於 ROADMAP 3.1 刪除，模式如上記錄；真的 Layer 0 runner 待 3.3。）
- **指令**：`pnpm dev`（開發）、`pnpm build`、`pnpm start`。
- **tsconfig**：Next 首次 `dev` 會自動改 tsconfig（加 `moduleResolution: "bundler"`、`plugins: [{name:"next"}]`、`include` 等），已一併調 `module: "esnext"` 讓 scripts 與 app 共用同一份。`pnpm exec tsc --noEmit` 對 `scripts/` 維持乾淨。

## 目前進度

進度詳情記錄在 [docs/PROGRESS.md](docs/PROGRESS.md)，不寫在這裡。每次完成功能或做出重大調整，記得同步更新該檔案。

## 既有腳本

`scripts/` 依用途分子資料夾：`pipeline/`（每日自動跑）、`screening/`（要選股時手動跑）、`backtest/`（回測 Layer 0 引擎 + 資料完整性檢查）、`backfill/`（偶爾手動回補）、`lib/`（純函式庫 + 撈 DB helper，多處共用）、`archive/`（已停用、留著參考，不刪不維護）。移動腳本時記得一併更新這裡與 README 的路徑。

### `scripts/pipeline/` — 每日排程

- **`daily-pipeline.ts`**：每日排程主控腳本，五步：補今日 TWSE+TPEx 報價 → 抓今日籌碼 → 抓今日估值 → 算技術指標 → 算產業熱度。任一步驟失敗印錯誤並非 0 結束。**非當日資料防呆**：報價步驟後若 TWSE+TPEx 皆無當日資料，提前結束整支 pipeline 並印警告數。無 `isMain` guard，`import` 這支即會執行 `main()`。`pnpm tsx scripts/pipeline/daily-pipeline.ts`。搭配 `daily_pipeline.plist`（每天 17:00 觸發，**尚未部署到 launchd、檔案也尚未建立**）。
- **`fill-daily-quotes.ts`**：補齊全市場報價，自動新增 `Stock`、upsert `DailyQuote`。匯出 `fillOneDayTwse(date)`（`MI_INDEX`，可補任意歷史日）與 `fillTodayTpex(expectedIsoDate?)`（TPEx OpenAPI，只能拿「目前最新一天」，日期不符會跳過寫入並回傳 `isStaleDate: true`）。對外 fetch 走 `lib/http.ts` 的 `fetchJson`（3 次 retry + 30s timeout）。`pnpm tsx scripts/pipeline/fill-daily-quotes.ts --date=YYYY-MM-DD`。
- **`fill-institutional-trading.ts`**：抓指定日期 TWSE（`T86`，可查任意歷史日）+ TPEx（`tpex_3insti_daily_trading`，只能拿最新一天）三大法人買賣超寫入 `InstitutionalTrading`。只 upsert 已存在的一般股票，不新增股票。對外 fetch 走 `lib/http.ts` 的 `fetchJson`。匯出 `fillOneDayInstitutional(date)`。`pnpm tsx scripts/pipeline/fill-institutional-trading.ts --date=YYYY-MM-DD`。**尚無下游消費者**（`calculate-breakout-strength.ts` 不讀，`calculate-accumulation-score.ts` 有讀）。
- **`fill-gap-valuation.ts`**：抓指定日期 TWSE（`BWIBBU_d`）+ TPEx（`peQryDate`）估值寫入 `StockValuation`，兩邊皆可查任意歷史日期。對外 fetch 走 `lib/http.ts` 的 `fetchJson`。匯出 `fillOneDayValuation(date)`。`pnpm tsx scripts/pipeline/fill-gap-valuation.ts --date=YYYY-MM-DD`（不帶參數抓今天）。
- **`calculate-technical-indicators.ts`**：依 `DailyQuote` 算 MA5/10/20/60、布林通道、量能均線、`volatility20d`/`maxDrawdown20d`/`atr20`/`rsi14`/`macdStatus`，寫入 `TechnicalIndicator`（對每支股票的全部歷史 `DailyQuote` 逐日重算）。匯出 `calculateTechnicalIndicators(codes?: string[])`——傳代號陣列只重算那幾支，不傳跑全市場一般股票。`pnpm tsx scripts/pipeline/calculate-technical-indicators.ts`（全市場）或 `... 4104 2330`（指定股票）。
- **`calculate-industry-heat.ts`**：依 `DailyQuote` 算各產業每日等權熱度寫入 `IndustryHeatSnapshot`（純資料庫計算，零 API）。匯出 `calculateOneDayHeat(date)`。`pnpm tsx scripts/pipeline/calculate-industry-heat.ts`（最近交易日）或 `--backfill 20`。

### `scripts/screening/` — 選股（手動）

- **`calculate-breakout-strength.ts`**：篩出帶量帶價第一根突破布林的股票並依訊號強度排名（三層：觸發→資格門檻→強度評分，評分公式皆單調遞增，不用鐘型曲線）。共用邏輯在 `lib/breakout-shared.ts`。結果不寫資料庫，輸出至 `data/breakout-strength-results/{date}.json`。匯出 `calculateBreakoutStrength(date, { prisma?, config? })`——未傳 `prisma` 則自建並自行 `$disconnect`；`config` 為 `DeepPartial<BreakoutConfig>`，只覆蓋想改的欄位（見 `scripts/lib/` 段）。`pnpm tsx scripts/screening/calculate-breakout-strength.ts --date=YYYY-MM-DD`。
- **`calculate-accumulation-score.ts`**：盤後選股 v2「投信吃貨訊號」——找還沒出現第一根突破、但籌碼/技術面在醞釀的股票，與 `calculate-breakout-strength.ts`（找已發生的突破）互補。計分為**乘法結構**：`最終分數 = 籌碼分數 × 技術就緒係數`。籌碼分數（主排序依據）= 投信分數 × 0.7 + 其他法人分數 × 0.3；技術就緒係數 = 壓縮度/窒息量合成後線性映射到 `READINESS_FLOOR`~1.0（下限 0.5）。候選池先剔除「今日已站上布林上軌」（與突破清單互斥）與「近 20 日均量 < `MIN_AVG_VOLUME_SHARES`(=500 張)」（低流動性死股）。結果不寫資料庫，輸出至 `data/accumulation-score-results/{date}.json`（`code`+`date` 欄位格式對齊突破腳本，方便日後回測命中率；`params` 區塊輸出實際生效的 resolved config）。匯出 `calculateAccumulationScore(date, { prisma?, config? })`——未傳 `prisma` 則自建並自行 `$disconnect`；`config` 為 `DeepPartial<AccumulationConfig>`。`pnpm tsx scripts/screening/calculate-accumulation-score.ts --date=YYYY-MM-DD`。**獨立手動執行，不進 daily-pipeline**。待校準參數集中在 `lib/accumulation-shared.ts`，首版未校準（前段偏大型股）。
- **`check-intraday-breakout.ts`**：盤中一次性快照篩選，把 `calculate-breakout-strength.ts` 的三層邏輯套用在 `mis.twse.com.tw` 即時報價上（社群逆向工程端點，非官方文件）。**一次性手動執行，不排程、不接進 daily-pipeline**，不支援 `--date`。批次查詢（120 檔/批，1.5 秒節流），`elapsedRatio` 現算預估全天量。與 `calculate-breakout-strength.ts` 評分邏輯 100% 共用，但當日 close/volume/OHLC/布林上軌全是即時或估計值（vs 盤後版的定案值），比較基準日也差一天（即時價 vs T-1 上軌）。結果輸出至 `data/intraday-breakout-snapshots/{timestamp}.json`。匯出 `checkIntradayBreakout({ prisma?, config?, now? })`（`main()` 為薄殼；`now` 供回測注入時間，預設 `new Date()`），MIS 抓取常數（`BATCH_SIZE` 等）不進 config。`pnpm tsx scripts/screening/check-intraday-breakout.ts`。

### `scripts/backtest/` — 回測（手動 / 背景任務）

**四層資料流現況（ROADMAP 3.0）**：
- **Layer 0**（`run-layer0.ts`，慢、查 DB、落地）：逐交易日撈全市場每檔的門檻裸值 + rankScore 前原始聚合值 → `data/backtest-runs/{run-id}/raw-factors/{date}.jsonl`。
- **Layer 0.5**（`build-forward-returns.ts`，慢、查 DB、落地、**全域跨策略共用**）：每個 (date, code) 的 N 日報酬 + benchmark → `data/backtest-cache/forward-returns.jsonl`。與 run / 策略無關。
- **Layer 1 + 2**（`scripts/lib/backtest-replay.ts`，**純函式、記憶體、即時**）：讀某日 raw-factors 行 + resolved config → 套 `gate` 篩池 → 重跑 `rankScore` → 套 `score` 評分 → 加權排名，回傳跟 screening 腳本 `results` 同形狀的候選名單。
- **Layer 3**（`scripts/lib/backtest-stats.ts`，**純函式、記憶體、即時**）：Layer 2 候選名單 + Layer 0.5 cache → 命中率 / 報酬分布 / 穩定性 / 分層單調性 / train-valid 分段。
- **最小驗證入口**：`lib/actions/backtest.ts` 的 `runBacktestSummary(runId)`（同步、進程內：讀 `raw-factors/*.jsonl` + `forward-returns.jsonl` → `replayXxxRange` → `computeBacktestStats`）+ `ensureForwardReturns(range)`（spawn）；UI 在 `app/backtest/page.tsx` 的 run 清單「跑統計摘要」按鈕 + `components/BacktestSummary.tsx` / `ForwardReturnsBuilder.tsx`。滑桿 / 圖表 / 版本比較留 ROADMAP 3.6 / 3.7。

- **`check-data-completeness.ts`**：回測資料完整性檢查（ROADMAP 3.3）。給定區間，掃 `DailyQuote` / `TechnicalIndicator` / `InstitutionalTrading` 三張表的覆蓋率，抓「整段缺日期」（交易日母體 − 各表 distinct date）與「單股缺漏」（`thinStocks`：某股票實際筆數 / 應有筆數 < 0.9；應有筆數 = 該股第一筆 `DailyQuote` 之後、區間內的交易日數，所以區間中途上市的新股不會誤報）。回報但**不自動修**。`hardFailures` 非空即 exit 1：任一表覆蓋率 < 95%、暖身期（區間 start 前 60 交易日）後仍有整段缺日期、交易日母體 < 20（可由 `minTradingDays` 放寬，小區間驗證跑用）。匯出 `checkDataCompleteness(range, { prisma?, minTradingDays? })`。獨立可跑，也被 `run-layer0.ts` 開跑前呼叫。`pnpm tsx scripts/backtest/check-data-completeness.ts --start=YYYY-MM-DD --end=YYYY-MM-DD`。
- **`run-layer0.ts`**：Layer 0 批次歷史模擬引擎（ROADMAP 3.3）。對區間每個交易日，用選股純函式的「撈 DB + 組視窗序列」邏輯，撈全市場每檔的「門檻裸值 + rankScore 前的原始聚合值」，寫入 `data/backtest-runs/{run-id}/raw-factors/{date}.jsonl`（一行一檔）。**不套門檻、不算成品分數、不算 rankScore、不寫 DB**——留給後續 Layer 1/2/3。同時寫 `config.json`（range / strategy / git hash + dirty / `sharedLibHash` / `windowConfig`）與 `progress.json`（背景任務進度，原子寫：先 `.tmp` 再 rename）。開跑前呼叫 `checkDataCompleteness`，hard failure 即 `status=error` 中止。匯出 `runLayer0(options)`，`isMain` guard。`pnpm tsx scripts/backtest/run-layer0.ts --strategy=breakout|accumulation --start=... --end=... [--train-end=... --valid-start=...] [--run-id=...]`；`--resume=<run-id>` 從第一個缺的交易日續跑（掃 `raw-factors/` 已有的 `{date}.jsonl`），不重寫 range/strategy。
  - **`{run-id}` 格式**：`{strategy}-{YYYYMMDD-HHmmss}`。一次跑一個策略一個 run（兩策略 raw-factors schema 不同，不合併）。
  - **視窗緩衝**：Layer 0 抓歷史時每個視窗比 `DEFAULT_*_CONFIG` 預設多抓一截（`history` 240→260、`rsCloseSeries` 61→76、`firstBarSeries` 30→40、`institutional` 20→30、`recentVolumes` 5→15、`bandwidthHistory` 240→260），留給 Layer 2 微調視窗。緩衝值寫死在 `run-layer0.ts` 的 `LAYER0_WINDOW_BUFFER`，**不進 config 型別**（是抓取策略不是選股參數），實抓長度記進 `config.json.windowConfig`。Layer 2 若把某視窗調到超過 `windowConfig` 記錄值 → 需重跑 Layer 0。
  - **raw-factors 存「原始輸入值」不存 rankScore/成品分數**（ROADMAP 3.2 共通原則）：存「量比幾倍、乖離幾 %、bandwidth 陣列、近 N 日 close、三大法人淨買超序列」等曲線/rankScore 的**輸入**，Layer 2 才能在篩完候選池後重跑 rankScore、想改曲線不用重跑 Layer 0。`relativeStrength` 存 `rsCloseSeries` 原始陣列（不存報酬率、更不存 rank 後分數）。
  - **無損編碼（2026-08-29 定案）**：原 PLAN 的 `{key:val}` 物件陣列讓 breakout 6 年達 ~61 GB（估 3.4 GB 的 18 倍）。改用**位置對齊 tuple**（`history` = `[close, bandwidth]`、`firstBarSeries` = `[close, bollingerUpper]`、`institutional` = `[trustNetBuy, foreignPlusDealerNetBuy, volume]`）+ **浮點 round 到 6 位小數** + **`history`/`bandwidthHistory` 不存每筆 date**（序列是「從 `prevTradingDate` 起、新到舊、連續交易日」，純函式只按位置取值）。純編碼壓縮不損可重算能力，實測降到 breakout ~15 GB / accumulation ~9 GB（6 年）。**Layer 2 讀 raw-factors 時要先把緩衝陣列截到 config 視窗長度再算**（`_verify-layer0.ts` 印證：`computeBase` 對 260 筆 vs 240 筆的 percentile / p25 不同）。
  - **體積退路**（若日後又失控）：`history` / `bandwidthHistory` 退成只存 `computeBase` 前的兩個中間量（depth percentile + durationDays），代價是 Layer 2 不能再調 `computeBase` 內部（`depthWeight` / `durationWeight` / `durationCapDays` / p25）。目前不啟用。
  - **背景任務**：`lib/actions/backtest.ts` 的 `startLayer0Run` spawn `process.execPath` + `node_modules/tsx/dist/cli.mjs` 絕對路徑的 detached 子進程（`--run-id` 在 spawn 前決定，action 立刻回傳）；子進程自己 `makePrisma()`，與 Next.js 連線池無關。`getLayer0Progress` / `listBacktestRuns` 讀檔。UI 在 `app/backtest/page.tsx` + `components/BacktestRunner.tsx`（`setInterval` 2s 輪詢進度條）。
  - **`data/backtest-runs/` 需手動清**（本批不做 GC）。已進 `.gitignore`。
- **`build-forward-returns.ts`**：Layer 0.5 forward-returns cache（ROADMAP 3.4）。對區間每個 (交易日 d, 全市場一般股票) 用 d 之後的 `DailyQuote.close` 算 N 日報酬（預設 `[5,10,20]`，`FORWARD_RETURN_HORIZONS`，`--horizons` 可覆蓋）+ 0050 同期報酬，寫入 `data/backtest-cache/forward-returns.jsonl`（**全域、非 run 專屬、跨策略共用**）。匯出 `buildForwardReturns(options)`，`isMain` guard，`pnpm tsx scripts/backtest/build-forward-returns.ts --start=YYYY-MM-DD --end=YYYY-MM-DD [--horizons=5,10,20] [--codes=2330,2454] [--force]`。要點：
  - **「第 N 天」用該股自己的報價序列數**（撈 `date > d` 的 `DailyQuote` 升冪取第 N 筆）——停牌 / 暫停交易股不會因日曆缺天誤算。不足 N 筆（近期上市 / 已下市）→ 該 `retN` 記 `null`，不跳過整行。`benchmarkRetN` 則用**全市場交易日曆**的「d 之後第 N 個交易日」（0050 不停牌）；0050 剛好缺該日則往後找第一個有值、記 `benchmarkGapDays`（通常 null）。
  - **每行**：`{date, code, entryClose, ret5/10/20, benchmarkRet5/10/20, benchmarkGapDays}`，round 6 位（與 raw-factors 一致）。**不存命中旗標、不存停損停利**——命中判定（`retN > benchmarkRetN`）留給 `computeBacktestStats`。
  - **去重**：key 是 `(date, code)`，算過的跳過（`rowsSkipped`）；`--force` 才把該區間的 `(date, code)` 從舊檔濾掉再重算。中斷後重跑靠去重自然續跑。每 50 個基準日 flush 一次（臨時檔 + rename），避免中途中斷留半行。
  - **效能**：每個基準日一次 range query 撈「d 之後 40 日曆日內、全市場 close」在記憶體分組取前 N（不足才對該檔補一次單獨 query）→ 6 年約 1476 個 query。體積：每行約 150 bytes，6 年約 288 萬行 ≈ 450 MB（`.gitignore` 的 `data/backtest-cache/`，與 `data/backtest-runs/` 同為手動清）。
  - **0050 除息誤差**：0050 未還原股價，除息日 `close` 含假跌幅（N=5/10/20 對單次除息不敏感，約 1~2%）——本階段接受；要更準改抓 `TaiwanStockPriceAdj` 或加 006208 對照。
  - `forward-returns.meta.json`：`horizons` / `benchmarkCode` / `coveredDateRange` / `rowCount` / `lastBuiltAt` / `note`。
  - **獨立可跑**，不綁進 `run-layer0.ts`（forward-returns 與 run / 策略無關）。`lib/actions/backtest.ts` 的 `ensureForwardReturns(range)` spawn 這支 detached 子進程供 UI 觸發。
- **`load-forward-returns.ts`**：`loadForwardReturns(cachePath?)` → `ForwardReturnLookup`（`get(date, code)`）。讀 `forward-returns.jsonl` 建 `Map`。可被 CLI / Server Action / 測試共用（這支可讀檔，`backtest-stats.ts` 不行）。

### `scripts/backfill/` — 歷史回補（偶爾手動）

- **`backfill-daily-quotes.ts`**：FinMind 逐支回補歷史報價至 `DailyQuote`（只跑 `securityType=stock`）。回補區間為 `BACKFILL_START_DATE`（預設 `2020-01-01`）到執行當天，實測 FinMind 單支查詢 6 年不會被截斷。`pnpm tsx scripts/backfill/backfill-daily-quotes.ts`（`BACKFILL_LIMIT` 限制測試支數；`BACKFILL_START_DATE=YYYY-MM-DD` 覆蓋起始日）。
- **`backfill-institutional-trading.ts`**：逐支一般股票用 FinMind 回補歷史三大法人買賣超至 `InstitutionalTrading`（TWSE 可回補任意歷史，TPEx 受端點限制效果有限）。回補區間同上。單支失敗不中斷。`pnpm tsx scripts/backfill/backfill-institutional-trading.ts`（`BACKFILL_LIMIT=10` 小量測試）。**已執行完成（6 年回補）**：2026-08-28 實測 `InstitutionalTrading` 涵蓋 **2020-01-02 → 2026-08-28、約 1476 個交易日、2,662,485 筆、每年 1808~1983 檔**（逐年筆數：2020=349,547／2021=376,427／2022=388,570／2023=392,978／2024=429,336／2025=432,544／2026(至 08-28)=293,083）。與 `DailyQuote`（3,066,466 筆）、`TechnicalIndicator`（3,060,066 筆）同為 2020-01-02 起，可支撐 accumulation 回測拉滿 6 年區間。（舊紀錄「2025-05-02 起 324 個交易日」已過時，是 2026-08-27 6 年回補前的狀態。）
- **`backfill-benchmark-quotes.ts`**：FinMind 回補回測用大盤基準標的的 `DailyQuote`（目前 `BENCHMARK_CODES = ["0050"]`，要加 006208／其他改陣列）。**只寫 `DailyQuote`，不碰 `TechnicalIndicator` / `InstitutionalTrading`**——基準只需要收盤價算報酬。0050 為未還原股價，除息日 `close` 含假跌幅；若基準報酬對除息敏感，日後改抓 `TaiwanStockPriceAdj`。`pnpm tsx scripts/backfill/backfill-benchmark-quotes.ts`。**已執行**：0050 已補 2020-01-02 ~ 今，約 1612 筆。
- **`update-shares-outstanding.ts`**：下載 MOPS 股本 CSV 更新 `Stock.sharesOutstanding`。**獨立手動執行，月頻，不進 daily pipeline**。`pnpm tsx scripts/backfill/update-shares-outstanding.ts`。

### `scripts/lib/` — 純函式庫

- **`http.ts`**：`daily-pipeline.ts` 三個抓取步驟共用的 HTTP 工具（無 Prisma/CLI）。匯出 `fetchJson<T>(url, options?)`：每次嘗試帶 `AbortSignal.timeout`（預設 30s），對網路層拋錯（`ECONNRESET`/`terminated`/timeout）與 5xx/429 自動退避重試（預設 3 次，2s→4s），對其他 4xx 不重試。存在理由：pipeline 無人值守執行，裸 fetch 遇一次 TLS 連線中斷就整條掛掉（2026-08-28 事故）。**回應內容判斷（非交易日 `stat`/`totalCount`/空陣列）仍留在各呼叫端**。`backfill-*.ts` 等手動腳本目前未接。
- **`types.ts`**：純型別工具，目前只有 `DeepPartial<T>`（遞迴可選，`resolve*Config(override?)` 與回測引擎共用）。
- **config 三件組（兩個 shared 檔各一套，回測參數化前置，ROADMAP 3.1）**：`breakout-shared.ts` / `accumulation-shared.ts` 各匯出 `XxxConfig` 型別（分 `gate` 門檻類 + `score` 加權/曲線/視窗類兩子物件）、`DEFAULT_XXX_CONFIG`（從既有 `export const` 常數組出來，舊常數全保留當單一數值來源）、`resolveXxxConfig(override?: DeepPartial<XxxConfig>)`（手寫 2 層展開合併）。**門檻類走 `gate`**（`minMarketCap` / `minVolumeShares` / `triggerVolumeRatio` / `minAvgVolumeShares`，決定誰進候選池）、**加權/曲線/視窗/degraded 門檻走 `score`**（不剔除股票，只改分數怎麼組）。純函式一律吃「該函式需要的最小 config 片段」，不讀 module-level 常數。
- **`breakout-shared.ts`**：`calculate-breakout-strength.ts` / `check-intraday-breakout.ts` / `run-layer0.ts` 共用（無 CLI，但 import 了 `PrismaClient` 型別 + 多個查 DB 的 helper）。內容：舊 `GATES`/`WEIGHTS`/`TRIGGER_VOLUME_RATIO` 等常數（保留）、`BreakoutConfig`/`DEFAULT_BREAKOUT_CONFIG`/`resolveBreakoutConfig`、`rankScore`/`clip`，以及 `computeVolumeStrength`/`computeBreakoutMargin`/`computeFirstBar`/`computeBase`/`computeProximityToHigh`/`computeMarketWideReturns`/`computeCandleShape` 七項評分函式。**撈 DB helper**（2026-08-29 從 `calculate-breakout-strength.ts` 抽入，Layer 0 與正式跑共用）：`fetchTodayQuotes` / `fetchIndicatorsForDate` / `fetchHistoryWindow` / `fetchBreakoutRawInputs(prisma, date, windows, codes?)`（回傳每股 `{ quote, indicator, prevTradingDate, firstBarSeries, history, rsCloseSeries }`；`codes` 省略 = 全市場，Layer 0 用；`windows` 帶視窗長度，正式跑傳預設、Layer 0 傳加緩衝值）。**已抽進 `config.score.curves` 的曲線轉折點**：`computeVolumeStrength`（2×→40/6×→100）、`computeBreakoutMargin`（3% 轉折 + 每 1% 扣 5 分 + 下限 60）、`computeBase`（0.6/0.4 權重 + duration 封頂 40 天）。`computeCandleShape`/`computeProximityScale`/`computeFirstBar`/`computeBase` 的 p25 門檻維持寫死。`GATES.minMarketCap` 為 30 億。
- **`accumulation-shared.ts`**：`calculate-accumulation-score.ts` 與 `run-layer0.ts` 共用。純評分函式無 Prisma；2026-08-29 起追加的 `fetchAccumulationRawInputs` import `PrismaClient` 型別且查 DB（比照 `breakout-shared.ts`）。內容：舊視窗/門檻/權重常數（保留，`INSTITUTIONAL_WINDOW_DAYS=20`、`SQUEEZE_VOLUME_WINDOW_DAYS=5`、`MIN_AVG_VOLUME_SHARES`、`READINESS_FLOOR` 等）、`AccumulationConfig`/`DEFAULT_ACCUMULATION_CONFIG`/`resolveAccumulationConfig`、`rankScore`/`clip`、`computeTrustRawMetrics`/`computeOtherInstitutionRatio`/`computeQuietVolumeRatio`/`combineChipScore`/`combineTrustScore`/`computeReadinessCoefficient`/`combineFinalScore`，以及 `fetchAccumulationRawInputs(prisma, date, codes, volumeMa20ByCode, windows)`（從 `buildFactorInputs` 抽出、去掉門檻篩選；回傳每股 `{ trustNetBuyNewestFirst, foreignPlusDealerNewestFirst, instVolumeNewestFirst, recentVolumesNewestFirst, quietVolumeRatioNewestFirst, bandwidthHistoryNewestFirst }`；正式跑用 `quietVolumeRatioNewestFirst`，Layer 0 存 `recentVolumesNewestFirst` 原始 volume 以免鎖死 volumeMa20 口徑）。壓縮度分數沿用 `breakout-shared.ts` 的 `computeBase`，曲線參數取 `DEFAULT_BREAKOUT_CONFIG.score.curves.base`。

- **`backtest-replay.ts`**：Layer 1 + Layer 2 記憶體重算（ROADMAP 3.0 / PLAN §3）。**純函式庫，不 import Prisma、不讀檔**——輸入是「已讀進記憶體的 `raw-factors` 行陣列」。匯出 `replayBreakout(rows, config)` / `replayAccumulation(rows, config)`（回傳跟 `calculateBreakoutStrength` / `calculateAccumulationScore` 的 `results` 同形狀的候選名單：`{date, code, name, scores/chipScore/…, totalScore/finalScore, rank, degraded}`）+ `*Range(Map<date, rows>, config)` 批次版 + `parseBreakoutRow` / `parseAccumulationRow`（tuple → 具名）。
  - **唯二的「格式適配」邏輯**：(1) `parse*Row` 把 Layer 0 的位置對齊 tuple 還原成評分函式期望的具名形狀；(2) `sliceWindows` 把 Layer 0 多抓的緩衝陣列先截到 resolved config 視窗長度再算（`history`→`baseMaxWindowDays`、`rsCloseSeries`→`rsWindowDays+1`、`firstBarSeries`→`firstBarLookbackDays`、`institutional`→`institutionalWindowDays`、`recentVolumes`→`squeezeVolumeWindowDays`、`bandwidthHistory`→`bandwidthHistoryMaxDays`）。其餘直接呼叫 shared 檔函式。
  - **replay 在「套完 `gate` 篩池」之後才重跑 `rankScore`**（3.0 的 rankScore 穿透核心）：breakout 的 `relativeStrength` 例外——母體是全市場（`rows` 全部），不是候選池。accumulation 的四分項 rankScore 跨候選池。
  - **逐位元對齊 screening 腳本（PLAN §6.2，`_verify-replay.ts` 一次性驗完刪）**：對「DEFAULT config」跑 breakout `2026-08-27` / accumulation `2026-08-26`，`rank` / `degraded` 與（現行程式碼重跑的）golden **100% 相同**；`totalScore` / `finalScore` 誤差 ≤ ~1e-5（breakout）/ ~0.03（accumulation 2 檔）——**純粹是 Layer 0 無損編碼把 `bollingerBandwidth` round 到 6 位小數、讓 `computeBase` 的低帶寬持續天數計數在 p25 門檻附近翻一格**，不是 replay bug，不影響 rank。
- **`backtest-stats.ts`**：Layer 3 統計純函式（ROADMAP 3.5 / PLAN §4）。**不碰 DB、不讀檔、不 import React / Prisma**。匯出 `computeBacktestStats(picks, forwardReturns, options)` → `BacktestStats`：`overall`（每 horizon 一組 `HorizonStats`）、`byTopN`（分數分層切點 → horizon → stats，切點預設 `[10,30,Infinity]`）、`byQuarter`（`"2025Q1"` → …）、`bySplit`（`options.split` 給 `trainEnd`/`validStart` → train / valid 各一組）。`HorizonStats` 含 `n` / `hitRate`（`ret > benchmarkRet`，benchmarkRet 為 null 不計入分母）/ `avgReturn` / `medianReturn` / `avgExcessReturn` / `winRate` / `profitFactor`（Σ正/|Σ負|，無負→Infinity、無正→0）/ `maxDrawdown`（**等權、不重疊部位的粗估**：picks 按 date 升冪、retN 視為獨立部位報酬相加的累積曲線 peak-to-trough，不是資金加權）。命中判定放這裡算（cache 不存）。`forwardReturns` 由 `scripts/backtest/load-forward-returns.ts` 從 jsonl 建成 `ForwardReturnLookup`。
- **`backtest-stats.test.ts`**：專案**首個單測檔**（`node:test` + tsx，零新依賴）。`pnpm tsx --test scripts/lib/backtest-stats.test.ts`。7 組手算案例（hitRate/avg/median/winRate/profitFactor、null 處理、maxDrawdown、byTopN 切點、split 分段、byQuarter、profitFactor 邊界）。

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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
