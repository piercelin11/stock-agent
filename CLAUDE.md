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
- **WatchlistItem**：手動維護的正式觀察名單，一支股票最多一筆。除 `stockCode`/`addedAt`/`notes` 外，另有買入狀態欄位：`isPurchased`（Boolean，預設 false）、`buyPrice`/`targetPrice`/`stopLossPrice`（`Decimal(10,2)`，nullable）、`buyDate`（`@db.Date`，nullable）、`source`（`"breakout"`/`"accumulation"`/`"manual"`/null，記錄從哪個策略加入）。
- **AnalysisResult**：AI 產出的分析結果歷史紀錄（screener / watchlist_summary / sector_ranking 等）。
- **StockValuation**：個股每日估值（本益比/股價淨值比/殖利率/收盤價），依 `stockCode + date` 唯一。TPEx 來源沒有收盤價（`closePrice` 為 null）；虧損公司 `peRatio` 為 null。
- **IndustryHeatSnapshot**：產業熱度每日快照（等權平均漲跌幅、漲跌家數、當日排名），依 `sectorId + date` 唯一。**不存 heatScore**——熱度分數要用時從原始欄位現算，避免公式調整後需要重刷歷史。
- **MarginTrading**：個股信用交易餘額（融資、融券），來源 TWSE `MI_MARGN` / TPEx `margin/balance`，依 `stockCode + date` 唯一。**單位一律「股」**（原始資料源以「張」計，入庫 ×1000）。`marginBalance`/`marginBalancePrev`/`shortBalance`/`shortBalancePrev` non-null（沒信用交易的股票是 `0` 不是缺值）；`marginQuota`（融資限額）/`offsetting`（資券互抵）nullable。`*Prev`（前日餘額）直接取 API 回應的「前日餘額」欄，不自己 join。**不存 change（今日−前日）**（同 `heatScore` 理由，要用時現算）；**不存「融資金額（仟元）」**（那是全市場彙總列的東西，個股要金額用 `marginBalance × 當日 close` 現算）。涵蓋一般股票 + 特別股。**下游**：`run-signal-scan.ts` 的 `margin-chasing` 警示（`computeMarginSurgePercentile`（融資餘額近 5 日累積變化率 vs 自己 40 天歷史百分位）→ `computeInstitutionalFlow` 回 `marginChasing` → `SignalResult.warnings`）。**只在 `breakout-day`/`extended` 階段、且突破當日三大法人淨賣超時觸發，只標記不動分數**。
- **Stock 的股本欄位**：`sharesOutstanding`（已發行普通股數）與 `sharesOutstandingUpdatedAt`。市值不落地存欄位，要用時以 `sharesOutstanding × 當日收盤價` 現算。
- **`SecurityType.index` / `TAIEX` 這筆特殊 `Stock`**：`SecurityType` enum 有 `index` 值，目前唯一一筆是 `Stock{ code: "TAIEX", name: "發行量加權股價指數", market: "TWSE", securityType: "index", sectorId: null }`（由 `backfill-index-quotes.ts` upsert 自建，不在 seed 清單裡）。**只給大盤濾網（`market-regime.ts`）算 MA60 / 帶寬用，不是個股、不進任何選股候選池**——`calculate-breakout-strength.ts` / `calculate-accumulation-score.ts` / `runScreening` / `getDbHealth` 等都篩 `securityType="stock"` 天然排除它；唯一例外是 `calculate-technical-indicators.ts` 的 `where` 用 `OR: [{ securityType: "stock" }, { code: "TAIEX" }]` 特意把它納入。`DailyQuote.volume` 存的是 FinMind 回的全市場成交量（對 TAIEX 無意義但無害）。
- **數量單位一律「股」**：`DailyQuote.volume`、`Stock.sharesOutstanding`、`InstitutionalTrading.*NetBuy`、`TechnicalIndicator.volumeMa20`，以及日後任何「數量」欄位，統一存「股」。原始資料源若以「張」計（1 張 = 1000 股，如融資融券的 TWSE `MI_MARGN` / TPEx `margin/balance`），入庫時 ×1000 轉「股」，並在該 model 的欄位註解標明「原始為張，入庫 ×1000」。這樣跨欄位計算（如「融資餘額 ÷ volumeMa20」）不需再換算。

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
- **TWSE 融資融券 API `MI_MARGN`**（`www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=YYYYMMDD&selectType=ALL`）：全上市個股信用交易餘額，`date` 傳西元 `YYYYMMDD`，**支援任意歷史日期**（2026-08-31 實測）。回應 `{ stat, date, tables }`，`stat === "OK"` 且有 `tables` 才是交易日；非交易日 `stat` 為「很抱歉，沒有符合條件的資料!」、無 `tables`。`body.date` 回西元 `YYYYMMDD` 可核對。**個股明細在 `tables[1]`**（`tables[0]` 是全市場彙總「信用交易統計」）；`tables[1].fields` 16 欄，重點欄位 index：`[0]代號 [1]名稱 [5]融資前日餘額 [6]融資今日餘額 [7]融資次一營業日限額 [11]融券前日餘額 [12]融券今日餘額 [14]資券互抵`。數字含千分位逗號，單位是**張**（入庫 ×1000）。`tables[1].data` 混 ETF（`00` 開頭，實測有 `00400A` 主動式 ETF）/ 特別股 / 一般股票，套過濾規則。
- **TPEx 融資融券 API `margin/balance`**（`www.tpex.org.tw/www/zh-tw/margin/balance?date=YYYY/MM/DD&id=&response=json`）：`date` 收西元斜線格式，**支援任意歷史日期**（與 TPEx 行情端點不同，比照估值端點）。回應 `{ date, tables: [{ date: "115/08/28", totalCount, fields, data }] }`，`tables[0].date` 是民國年斜線格式要 `+1911` 核對；非交易日 `totalCount` 為 0 / `data` 空。`tables[0].fields` 20 欄，重點欄位 index：`[0]代號 [1]名稱 [2]前資餘額(張) [6]資餘額 [9]資限額 [10]前券餘額(張) [14]券餘額 [18]資券相抵(張)`。數字含千分位逗號，單位是**張**（入庫 ×1000）。`data` 同樣混 ETF（`00679B` 債券 ETF 等）/ 一般股票，套過濾規則。
- **MOPS 股本 CSV**（`mopsfin.twse.com.tw/opendata/t187ap03_L.csv` 上市 / `t187ap03_O.csv` 上櫃）：UTF-8 含 BOM，最後一欄「已發行普通股數或TDR原股發行股數」直接就是股數。**絕對不要用「實收資本額 ÷ 面額」推算**——面額不是每家都 10 元（實測案例：國巨 2327 面額 2.5 元）。CSV 只涵蓋現存上市/上櫃公司，`Stock` 表裡的已下市/KY 等標的不在其中（約 TWSE 135 檔、TPEx 34 檔），跳過不動原值。

## 開發慣例

- **分支只是習慣、不追求 PR**：功能寫好、驗證過，就可以直接 merge 進 `main`（`git merge` 即可，不需要開 PR、不需要 code review 流程）。「提交並合併」= commit + merge to main。
- **每個新任務開始前先 `git branch --show-current` 確認分支**：
  - 分支名跟新任務主題**明顯不符**（例如在 `feat/watchlist-flow-4` 上要開始做「盤中提醒」）→ 停下來問使用者要哪一種，得到答覆才動手：
    (A) 從當前分支直接切新分支（`git checkout -b feat/xxx`，新工作疊在現有未合併的工作上）；
    (B) 先把當前分支 merge 回 `main`，再從 `main` 開新分支；
    (C) 就在當前分支繼續改。
  - 分支名還算相符、或使用者已說「就在這改」→ 直接做，不用每次問。
  - **merge 時機是使用者才能下的決定**——不要在使用者沒說的情況下自己 merge；但使用者一說「合併 / merge / 提交並合併」就直接做，不用再追問「PR 還是 merge」。
  - **在 `main` 上絕不直接改**——一定先開 feature 分支（既有規範，這裡重申）。
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

2026-08-28 建立的前端骨架（ROADMAP 第 2 節）。2026-08-30 加上首批業務頁面（ROADMAP 第 4 節：選股 → 挑股 → 觀察清單）。2026-08-31 整站切固定深色 + 重寫 Dashboard。

- **技術棧**：Next.js 16.3.3（App Router，Turbopack）+ React 19 + Tailwind CSS v4 + Recharts 3（目前僅 `package.json` 保留、Dashboard 已不用）。TS 7 / Prisma 7 / ESM 這組合實測直接可跑，沒有降版或改 webpack。
- **全站固定深色（無 light/dark toggle）**：`app/globals.css` `:root { color-scheme: dark }` + `body` `bg-slate-950 text-slate-100`。配色基準 = Tailwind slate 系（卡片 / 側欄底 `bg-slate-900`、邊框 `border-slate-800`、次級文字 `text-slate-400/500`、hover `hover:bg-slate-800`）；`Button` `primary` = `bg-blue-600`、選中列 / tab 底線用 `blue-*`。台股漲跌色在深色底提亮一階（漲 `text-rose-400` / 跌 `text-emerald-400`）。日後要主題切換再開 PLAN。
- **目錄**：前端在 repo 根目錄 `app/`（**不開 `web/` 子目錄、不做 monorepo**）——前端要 import 的 `generated/prisma`、`scripts/screening/*`、`scripts/lib/*` 都在根目錄，開子目錄只會讓 import path 變複雜。
- **`lib/`（根目錄，新）vs `scripts/lib/`（既有）**：`lib/` 放 **Next/React 世界**的共用碼（Prisma 單例、Server Actions、格式化 helper）；`scripts/lib/` 維持是**純 Node 函式庫**（`http.ts` / `breakout-shared.ts` / `accumulation-shared.ts` / `types.ts`），不 import React。兩個名字相近但職責分明。
- **Prisma 單例**：`lib/prisma.ts` 把 `PrismaClient` 掛 `globalThis` 快取（dev hot reload 不會爆連線池），保留 `PrismaPg` driver adapter 寫法。**檔頭 `import "server-only"`**——`scripts/lib/` 與 `lib/` 名字太像，這是唯一能在 build 時擋下「client component 誤 import `lib/prisma.ts`」的機制。只能在 Server Component / Server Action import。
- **Server Actions**（不建 REST/GraphQL）：檔案放 `lib/actions/*.ts`，檔頭 `"use server"`。action 只做「呼叫 Prisma / 純函式 → 回傳可序列化 plain object」。回傳 `Date` 要先轉字串、`Decimal` 要 `.toNumber()` / `.toString()`、`BigInt`（`volume` / `*NetBuy`）要 `Number(...)`，在 action 邊界轉掉（`Decimal` 直接丟 client component 會壞）。現有：`health.ts`（`getDbHealth` → `DbHealth`：`today`（Asia/Taipei）/ `latestQuoteDate` / `quoteFresh` / `stockCount`（`securityType="stock"` 檔數）/ `coverage.{quote,institutional,technical,margin}.{count,pct}`。燈號 = `latestQuoteDate === today`；覆蓋率基準日 = DB 最新交易日、分母 = `stockCount`（`margin` 另含約十幾檔特別股，pct 微幅偏高 <1%，可接受））、`signal-scan.ts`（`getScanMode` / `runSignalScanEod` / `startSignalScan` / `getSignalScanProgress` / `getSignalScanResult`——ROADMAP 4.5.3 統一選股，取代舊 `screening.ts` + `intraday.ts`。eod 模式同步 import `runSignalScan` 跑、realtime 模式 spawn `_run-signal-scan.ts` 背景任務）、`watchlist.ts`（`listWatchlist` / `addToWatchlist` / `removeFromWatchlist` / `updateWatchlistItem`，mutation 後 `revalidatePath("/watchlist")`）、`dashboard.ts`（`getWatchlistPerformance` → `WatchlistPerfRow[]`：對 watchlist 每檔用 `breakout-shared.ts` 的 `computeCandleShape` / `computeVolumeStrength` / `computeBase` 現算 K棒 / 力道 / 位階分數 + 當日動能 / 籌碼 + `spark: SparkPoint[]`（60 日走勢，見下方 Dashboard 頁）。**不重跑 `calculateBreakoutStrength`**——它的 gate 會濾掉未突破的觀察股，交集太少。`computeBase` 吃布林帶寬序列（`TechnicalIndicator.bollingerBandwidth`）不是 close 序列；走勢圖另撈 `bollingerMid` 對每日 close 算偏離比例）、`market-regime.ts`（`getMarketRegime` → `MarketRegimeView`：**純讀檔不碰 DB**——讀 `data/market-regime/` 最新 `{date}.json`、組三段部位建議文字 `advice`。只 `import type`，不 import `scripts/lib/market-regime.ts` 本體）、`pipeline.ts`（`runDailyPipeline` / `getDailyPipelineStatus` → `DailyPipelineStatus`：首頁「立即更新資料」按鈕。spawn 未改造的 `daily-pipeline.ts` 本體、`stdio` 落 `data/daily-pipeline-runs/{stamp}.log`、`progress.json` 粗粒度狀態、parent `child.on("exit")` 寫終態、`STALE_MS`(20 分) 兜底 hot-reload 丟 listener。純檔案 IO + spawn，不 import 任何 `scripts/` 東西。`tailLines` 只吃 log 基本檔名並 `join(RUN_DIR, ...)`（靜態 scope，否則 Turbopack build 追蹤整個專案報 warning））。
- **`/` Dashboard 頁**：`<h1>` 下先一條 `<RegimeBanner regime={getMarketRegime()} />`（大盤濾網橫幅，見下），再兩張 Card。①「資料狀態」= `getDbHealth()` 的三欄（今日行情燈號：`quoteFresh` 綠 / 否紅 + DB 最新日 vs Asia/Taipei 今日；一般股票檔數；當日四表覆蓋率 `{pct}% ({count}/{stockCount})`，`<50` 紅 / `<90` 黃）+ 卡片底部 `<PipelineRunner />`（client component：「立即更新資料」按鈕 → `runDailyPipeline()` spawn 背景 pipeline → `setInterval(3s)` 輪詢 `getDailyPipelineStatus()` 顯示「已 N 秒」+ log 尾 → `done` 時 `window.location.reload()`。切走停輪詢不中斷子進程、切回若還 `running` 接管。`progress.json` 單檔鎖，同時只一個）。②「觀察類股今日表現」= `<WatchlistPerfTable />`（Server Component，`await getWatchlistPerformance()`，純展示無互動）：**卡片式 grid**（`sm:2 / xl:3` 欄）。每張卡左側一張 **60 日走勢 SVG**（200×88 viewBox，`h-22 w-50`；Y 軸 = 收盤相對當日布林中軌的偏離比例 `(close − bollingerMid)/bollingerMid`，固定夾 ±`SPARK_CLIP`(=0.25)，所有卡共用同一刻度 → 用布林帶寬正規化，盤整期線壓中線窄帶、噴出頂到邊界，卡跟卡之間絕對起伏可比、不被個股絕對振幅誤導；`PAD=8` 讓夾邊的點不貼框；線色依當日漲跌 `rose-400`/`emerald-400` + 線下漸層；有效點 < 2 顯示「資料不足」）；右側 `代號(text-3xl) 漲跌% [突破pill] / 名稱 收盤 refDate` + 底排 K棒·力道·位階三分數（`>=70` emerald / `40~70` slate-200 / `<40` slate-500，null 顯「—」+ degraded 加「不足」tag）+ 籌碼合計/投信（張）。`SPARK_CLIP` / `SPARK_WINDOW` / `SparkPoint` 型別在 `lib/dashboard-spark.ts`（**`lib/actions/dashboard.ts` 檔頭 `"use server"` 不能匯出 const / 值，只能匯出 async function**——常數要抽獨立非-server 檔給 action 與元件共用）。空清單有提示文案。
- **`components/ui/Card.tsx` 的 `<FieldLabel>`**：全站「次級說明文字」（卡片欄位名 / 燈號 label / 分數 label…）的**單一出處**，`text-sm text-slate-400` + 可選 `className` 覆蓋顏色。`Stat` 內部用它，`app/page.tsx` 資料狀態卡、`WatchlistPerfTable` 分數 / 籌碼 label 都用它。要整體調這類字級只改這個元件。
- **`components/dashboard/RegimeBanner.tsx`**：大盤濾網（市場狀態燈號）橫幅，Server Component 純顯示。`variant="banner"`（首頁：完整橫幅 + `<details>` 三維度明細，`bearish` 時 Card `border-rose-500/40`）／`variant="strip"`（`/screening` 頁頂：圓點 + `大盤：偏空` + `advice` 一行）。**配色 = 通用號誌色**（綠 `emerald-500`=偏多 / 琥珀 `amber-500`=中性 / 紅 `rose-500`=偏空 / 灰=無資料），刻意跟個股漲跌色（台股漲紅跌綠）**不同語意**（不同區塊不混淆，元件註解寫明）。資料來源 `getMarketRegime()`（`data/market-regime/{date}.json`，盤後 pipeline 每日一次；盤中看到的是上一交易日收盤定案值）。
- **`/screening` 頁（ROADMAP 4.5.3：單頁 + 階段 filter，三分頁已收斂）**：Server Component 外殼 `async`，頁面標題下、`ScreeningPanel` 之上放 `<RegimeBanner variant="strip" />`。`ScreeningPanel` 一顆「跑掃描」按鈕，`getScanMode()`（`lib/actions/signal-scan.ts`）決定文案 / 行為：
  - **eod 模式**（今天有 `DailyQuote`）→「跑盤後掃描」，按 = `runSignalScanEod()`（同步在 Next 進程內 import `runSignalScan` 跑 DB 最新交易日，傳前端 prisma 單例、`source: "eod"`；秒級）。
  - **realtime 模式**（今天還沒有 `DailyQuote`）→「開始盤中掃描」，按 = `startSignalScan()` spawn detached `_run-signal-scan.ts` → 逐批寫 `data/signal-scan-results/progress.json` → client `setInterval(2s)` 輪詢 `getSignalScanProgress()` 進度條 → `done` 時 `getSignalScanResult()` 讀最新 `{timestamp}.json`。同時只一個掃描（`progress.json` 單檔、`STALE_MS`(90s) 判死）。切走停輪詢不中斷子進程、切回若 `running` 接管。
  - **階段 filter tab**（全部 / 醞釀中 / 今日突破 / 已延伸）= 純前端 `results.filter(r => f === "all" || r.stage === f)`。一張可排序表格（`stage` 是其中一欄）+ 點列展開評分明細（by-stage：`pre-breakout` 醞釀分項 + 原始指標 / `breakout-day`·`extended` 8 分項）+ 勾選加入。「全部」filter 預設依 `totalScore` 降冪 + UI 標註「不同階段分數語意不同、不可直接比較」（rank 是同階段內名次）。
  - `priceSource === "estimated"`（realtime 缺成交價、`h` 代入）列尾「估」badge（`text-amber-400`）+ row 淡色 + 展開多一行提示。
  - `SignalResult.warnings` 含 `"margin-chasing"` → 列尾**紅** badge「追」（`text-rose-400`，跟琥珀「估」、灰字 `degraded` 三者顏色分明）+ 展開最上方紅框提示。**`warnings` 與 `degraded` 語意分開**：`degraded` = 因資料不足所以不確定；`warnings` = 資料充足、系統明確發現的風險訊號。只有 `breakout-day`/`extended` 的 `SignalResult` 會有非空 `warnings`（pre-breakout 恆 `[]`）。與 `SignalScanOutput.warnings`（管線層級警語）是不同層級。
  - 勾選加入：每列按自己的 stage 映射 `WatchlistItem.source`（`pre-breakout` → `"accumulation"`、`breakout-day`/`extended` → `"breakout"`；混階段逐 source 分組呼叫 `addToWatchlist`）。schema `source` enum 不動。
- **三階段 + 按階段不同合併方式（設計理由）**：`run-signal-scan.ts` 對全市場算「同一份因子分」，但**最後合成總分的公式按階段不同**——不只是換權重數字。`pre-breakout`（還沒站上上軌）用**乘法**`籌碼分 × 技術就緒係數`（就緒係數下限 0.5）：這是「籌碼強 ∧ 技術收斂」的 AND 關係，加權和會讓「籌碼極高但股價亂噴沒收斂」的股票靠籌碼分硬拉出高總分，正是乘法 + 保底要擋的。`breakout-day` / `extended`（已站上上軌）用**8 分項加權和**（沿用 breakout 結構 + 新 `institutionalFlow`）。三階段由「連續站上布林上軌天數」互斥判定（`consecutiveAboveBand`：≤ 0 → pre-breakout；1~2 → breakout-day；> 2 → extended），一支股票只落一個階段。**排名為同階段內名次**（三階段各 1..N），前端「全部」filter 時跨階段分數不可直接比較（UI 已標註）。統一 gate（市值 + 當日量 + 均量）比舊 accumulation 候選池嚴（多了市值下限 + 當日量下限），pre-breakout 候選數因此明顯少於舊 `calculate-accumulation-score.ts`。**`margin-chasing` 警示（融資融券修正因子）**：`breakout-day`/`extended` 階段，若「突破當日三大法人（投信＋外資）淨賣超 ∧ 這檔融資餘額近期增速排在自己 40 天歷史前 20%」→ `SignalResult.warnings` push `"margin-chasing"`。**刻意只標記不動分數**（既有 `sellCapScore` 封頂上再疊動態調整 = 特例規則互相牽扯難除錯；標記取代動態調整，跟 `degraded` 哲學一致）。realtime 當日融資餘額拿不到 → 恆不觸發。
- **`/watchlist` 頁**：`listWatchlist` 讀 `WatchlistItem` + 對每檔三表（`DailyQuote` / `TechnicalIndicator` / `InstitutionalTrading`）各 `findFirst` 最新一筆（3N 查詢，清單 < 50 檔可接受；三表日期不對齊，各標各自資料日期）。可切換 `isPurchased`、填買入價 / 買入日 / 目標價 / 停損價 / 備註（`onBlur` 存）、移除。漲跌色台股慣例（漲紅跌綠）。
- **`app/page.tsx` 等會查 DB 的頁面檔頭加 `export const dynamic = "force-dynamic";`**——否則 `next build` 會試圖靜態預渲染、在 build time 連本機 Postgres（CI / 沒開 DB 時直接失敗）。
- **`*.css` import**：tsconfig 有 `noUncheckedSideEffectImports: true`，會擋 `import "./globals.css"`。對策是 `app/globals.css.d.ts` 內容 `declare module "*.css";`。**不要為此關掉該旗標**（`scripts/` 也吃這個旗標）。
- **`next.config.ts` 的 `serverExternalPackages`**：列 `@prisma/client` / `@prisma/adapter-pg` / `pg`，讓 Prisma 相關套件走 Node 原生 require 不進 bundler（generated client 用 `import.meta.url` 定位 engine，被打包會找不到路徑）。
- **背景任務**：模式是「Server Action `spawn` 一個 detached 子進程 → 子進程每步覆寫 `data/xxx/progress.json` → 另一個 Server Action 輪詢讀檔 → client component `setInterval` poll」。**`spawn` 用 `process.execPath` + `node_modules/tsx/dist/cli.mjs` 絕對路徑 + 目標腳本當參數**，不要用 `pnpm tsx` / `npx tsx`（detached 子進程解析 launcher 慢、PATH 依賴）。`.npmrc` 設 `node-linker=hoisted`，所以 `node_modules/tsx/dist/cli.mjs` 是扁平路徑、解析得到。原子寫 `progress.json`（先寫 `.tmp` 再 `renameSync`）避免輪詢讀到寫一半。**已有正式使用者**：(1) `lib/actions/signal-scan.ts` 的 `startSignalScan()`（`/screening` realtime 模式）+ `scripts/screening/_run-signal-scan.ts` runner——`runSignalScan` 內部 MIS 抓取逐批自寫 `progress.json`，runner 只寫終態。(2) `lib/actions/pipeline.ts`（首頁「立即更新資料」按鈕）——spawn 的是**未改造的 `daily-pipeline.ts` 本體**（該檔要保持給 launchd 用、不加 progress callback），所以沒有子進程自寫進度：`stdio` 導到 `data/daily-pipeline-runs/{stamp}.log`，**parent（Next 進程）監聽 `child.on("exit")` 覆寫 `progress.json` 終態**，進度只有粗粒度（`status` + 存活秒數 + log 檔尾 12 行）。dev hot-reload 會丟這個 exit listener → `getDailyPipelineStatus()` 用 `STALE_MS`(20 分) 判定 running 逾時回報 `error` 兜底。`PipelineRunner.tsx` 完成後 `window.location.reload()` 刷新覆蓋率（`app/page.tsx` 是 `force-dynamic`）。（PoC 檔案 `scripts/_poc/` + `lib/actions/poc.ts` + `components/PocRunner.tsx` 已於 ROADMAP 3.1 刪除。）
- **指令**：`pnpm dev`（開發）、`pnpm build`、`pnpm start`。
- **⚠️ 不要自己起 / 殺 dev server**：使用者平常自己開著 `pnpm dev`（port 3000）。要驗證 runtime 渲染時，**直接 `curl http://localhost:3000/...` 打使用者那隻**；打不通就跟使用者說「請開 dev server」或改用 `pnpm build` + `tsc --noEmit` 靜態驗證，**不要自己 `pnpm dev` 起一隻**。**絕對不要 `pkill -f "next dev"` / `pkill -f next-server`**——那會連使用者的 server 一起砍掉（字串比對不分你我）。真的非得自己起，用獨立 port（`PORT=3123 pnpm dev`）且收尾只 `kill` 自己記下的那個 PID。
- **tsconfig**：Next 首次 `dev` 會自動改 tsconfig（加 `moduleResolution: "bundler"`、`plugins: [{name:"next"}]`、`include` 等），已一併調 `module: "esnext"` 讓 scripts 與 app 共用同一份。`pnpm exec tsc --noEmit` 對 `scripts/` 維持乾淨。

## 目前進度

進度詳情記錄在 [docs/PROGRESS.md](docs/PROGRESS.md)，不寫在這裡。每次完成功能或做出重大調整，記得同步更新該檔案。

## 既有腳本

`scripts/` 依用途分子資料夾：`pipeline/`（每日自動跑）、`screening/`（要選股時手動跑）、`backfill/`（偶爾手動回補）、`lib/`（純函式庫 + 撈 DB helper，多處共用）、`archive/`（已停用、留著參考，不刪不維護）。移動腳本時記得一併更新這裡與 README 的路徑。（`scripts/backtest/` 已隨回測系統放棄移除，見下方「回測系統 — 已放棄」段。）

### `scripts/pipeline/` — 每日排程

- **`daily-pipeline.ts`**：每日排程主控腳本，七步：補今日 TWSE+TPEx 報價 → 抓今日籌碼 → 抓今日估值 → **抓今日融資融券（第 3.5 步）** → 算技術指標（`mode: "latest"`，只算當天，秒級）→ **算大盤濾網（市場狀態燈號）** → 算產業熱度。報價/籌碼/估值任一失敗印錯誤並非 0 結束；第 3.5 步（融資融券，證交所通常傍晚才出）與大盤濾網為**非關鍵路徑**，失敗只印警告 + `warningCount++`，不中斷。**非當日資料防呆**：報價步驟後若 TWSE+TPEx 皆無當日資料，提前結束整支 pipeline 並印警告數。無 `isMain` guard，`import` 這支即會執行 `main()`（`lib/actions/pipeline.ts` 靠這點 spawn 它跑首頁「立即更新資料」按鈕）。整支實測 ~21 秒。`pnpm tsx scripts/pipeline/daily-pipeline.ts`。搭配 `daily_pipeline.plist`（每天 17:00 觸發，**尚未部署到 launchd、檔案也尚未建立**）。
- **`fill-daily-quotes.ts`**：補齊全市場報價，自動新增 `Stock`、upsert `DailyQuote`。匯出 `fillOneDayTwse(date)`（`MI_INDEX`，可補任意歷史日）與 `fillTodayTpex(expectedIsoDate?)`（TPEx OpenAPI，只能拿「目前最新一天」，日期不符會跳過寫入並回傳 `isStaleDate: true`）。對外 fetch 走 `lib/http.ts` 的 `fetchJson`（3 次 retry + 30s timeout）。`pnpm tsx scripts/pipeline/fill-daily-quotes.ts --date=YYYY-MM-DD`。
- **`fill-institutional-trading.ts`**：抓指定日期 TWSE（`T86`，可查任意歷史日）+ TPEx（`tpex_3insti_daily_trading`，只能拿最新一天）三大法人買賣超寫入 `InstitutionalTrading`。只 upsert 已存在的一般股票，不新增股票。對外 fetch 走 `lib/http.ts` 的 `fetchJson`。匯出 `fillOneDayInstitutional(date)`。`pnpm tsx scripts/pipeline/fill-institutional-trading.ts --date=YYYY-MM-DD`。**尚無下游消費者**（`calculate-breakout-strength.ts` 不讀，`calculate-accumulation-score.ts` 有讀）。
- **`fill-gap-valuation.ts`**：抓指定日期 TWSE（`BWIBBU_d`）+ TPEx（`peQryDate`）估值寫入 `StockValuation`，兩邊皆可查任意歷史日期。對外 fetch 走 `lib/http.ts` 的 `fetchJson`。匯出 `fillOneDayValuation(date)`。`pnpm tsx scripts/pipeline/fill-gap-valuation.ts --date=YYYY-MM-DD`（不帶參數抓今天）。
- **`fill-margin-trading.ts`**：抓指定日期 TWSE（`MI_MARGN`，`tables[1]` 個股明細）+ TPEx（`margin/balance`，`tables[0]`）個股信用交易餘額寫入 `MarginTrading`，兩邊皆可查任意歷史日期（回傳日期不符即 throw，無 `isStaleDate` 邏輯）。單位換算 ×1000（張→股）。套過濾規則只留一般股票 + 特別股，只 upsert 已存在的 `Stock`。對外 fetch 走 `lib/http.ts` 的 `fetchJson`。`daily-pipeline.ts` 第 3.5 步（非關鍵路徑）。匯出 `fillOneDayMargin(date)`。`pnpm tsx scripts/pipeline/fill-margin-trading.ts --date=YYYY-MM-DD`（不帶參數抓今天）／`--backfill=N`（往回抓、跳非交易日，實得約 N 個交易日；日曆日上限 `max(n+6, n*2)`，大 N 不提早停）。**下游**：`run-signal-scan.ts` 的 `margin-chasing` 警示（見上方 `MarginTrading` 條）。
- **`calculate-technical-indicators.ts`**：依 `DailyQuote` 算 MA5/10/20/60、布林通道、量能均線、`volatility20d`/`maxDrawdown20d`/`atr20`/`rsi14`/`macdStatus`，寫入 `TechnicalIndicator`。匯出 `calculateTechnicalIndicators(codes?: string[], options?: { mode?: "full" | "latest" })`——傳代號陣列只重算那幾支，不傳跑全市場一般股票 + TAIEX。**`mode` 預設 `"full"`**（每支全部歷史 `DailyQuote` 逐日重算並 upsert，回補報價後手動重算 / debug 用，~2149 支約 10 分鐘）；**`"latest"`**（`daily-pipeline.ts` 第 5 步用）每支只撈最近 250 筆當輸入（足夠算 MA60 / MACD EMA 暖身）、只 upsert 最新一筆日期，秒級。**代價**：pipeline 漏跑那天的技術指標不會自動補，需手動 `calculate-technical-indicators.ts <code>` 全歷史重算。CLI 與不帶 `options` 時一律 `full`。`pnpm tsx scripts/pipeline/calculate-technical-indicators.ts`（全市場）或 `... 4104 2330`（指定股票）。
- **`calculate-market-regime.ts`**：大盤濾網（市場狀態燈號）pipeline 薄殼。`calculateOneDayRegime(date, prisma)` → 呼叫 `scripts/lib/market-regime.ts` 的 `calculateMarketRegime` → 原子寫 `data/market-regime/{date}.json`（**不進 DB**：整個市場每天一標籤、資訊量小、盤中多次取允許一天多筆覆寫、不做回測 → 建表不划算）。`daily-pipeline.ts` 第 5 步（非關鍵路徑），CLI `pnpm tsx scripts/pipeline/calculate-market-regime.ts`（無參數跑 DB 最新交易日）／`--date=YYYY-MM-DD`（補算）。**三維度合成三段式已全部上線**（Step 1 breadth + Step 2 indexPosition / ma60Slope），`stage` 由 `hasTaiexIndicatorForDate()` 自動判定（TAIEX 指標補到該日 → `step2-full`；沒有 → 降級 `step1-breadth-only`）。
- **`calculate-industry-heat.ts`**：依 `DailyQuote` 算各產業每日等權熱度寫入 `IndustryHeatSnapshot`（純資料庫計算，零 API）。匯出 `calculateOneDayHeat(date)`。`daily-pipeline.ts` 第 6 步。`pnpm tsx scripts/pipeline/calculate-industry-heat.ts`（最近交易日）或 `--backfill 20`。

### `scripts/screening/` — 選股（手動）

- **`run-signal-scan.ts`（ROADMAP 4.5.3 統一評分管線，取代下方舊三支的角色）**：跑全市場一般股票 → 單一 gate（`minMarketCap` 30 億 + 當日 `volume` ≥ 1M 股 + `volumeMa20` ≥ 500k 股）→ 依「連續站上布林上軌天數」打階段標籤（`pre-breakout` / `breakout-day` / `extended`）→ 同一份因子分、階段套**不同合併方式**（`pre-breakout` = 乘法「籌碼分 × 就緒係數」，下限 0.5；`breakout-day`·`extended` = 8 分項加權和）→ **各階段各自排名** → 落地 `data/signal-scan-results/{date}.json`（eod）/ `{timestamp}.json`（realtime）+ `params`。**資料源自動切換**：查「今天（Asia/Taipei）有 `DailyQuote` 嗎」→ 有 `source: "eod"`（讀 DB）/ 沒有 `source: "realtime"`（打 `mis.twse.com.tw`，缺成交價用當日最高價 `h` 代入、`candleShape` 走 degraded、`priceSource: "estimated"`；`z`/`h` 皆缺跳過）。「觸發量比 ≥ 2」只對 breakout 階段當進榜門檻。匯出 `runSignalScan(date, { prisma?, config?, source?, now? })`（傳 `prisma` 不 `$disconnect`；`config` 為 `DeepPartial<SignalScanConfig>`）。CLI：`pnpm tsx scripts/screening/run-signal-scan.ts`（自動判斷）／`--date=YYYY-MM-DD`（強制 eod）／`--source=realtime|eod`。**獨立手動執行，不進 daily-pipeline**。**三處偏離舊 breakout 預設**：`baseCurve` 深度/時長 = 0.4/0.6（舊 0.6/0.4）、`breakoutMargin` 改單調遞增（> 3% 封頂 100 不倒扣）、7 分項各 ×0.90 勻出 `institutionalFlow: 0.10`。
- **`_run-signal-scan.ts`**：被 `lib/actions/signal-scan.ts` 的 `startSignalScan()` spawn 的內部 runner（底線前綴）。建 `prisma` → `runSignalScan(new Date(), { prisma, source: "realtime" })` → 最外層覆寫 `progress.json` 終態（逐批進度由 `runSignalScan` 內部 MIS 抓取負責）。只跑 realtime。
- **`calculate-breakout-strength.ts` / `calculate-accumulation-score.ts` / `check-intraday-breakout.ts`（舊三支，已由 `run-signal-scan.ts` 統一）**：**保留可跑、退役待下一批 PLAN**（先讓 `run-signal-scan.ts` 肉眼比對排名穩定後再決定移除）。目前無 `lib/` / `app/` import 者（`lib/actions/screening.ts` / `intraday.ts` 已刪）。`check-intraday-breakout.ts` 這批改成 import `scripts/lib/mis-quotes.ts`（MIS 抓取抽出，行為不變）。`_run-intraday-scan.ts` 因 `intraday.ts` 刪除成孤兒（仍可 CLI 跑），一併留。
  - `calculate-breakout-strength.ts`：帶量帶價第一根突破布林，三層（觸發→資格門檻→強度評分）。共用邏輯 `lib/breakout-shared.ts`。輸出 `data/breakout-strength-results/{date}.json`。匯出 `calculateBreakoutStrength(date, { prisma?, config? })`。
  - `calculate-accumulation-score.ts`：盤後選股 v2「投信吃貨訊號」——還沒突破、籌碼/技術在醞釀。乘法結構 `籌碼分 × 技術就緒係數`。候選池剔除「已站上上軌」+「近 20 日均量 < 500 張」。輸出 `data/accumulation-score-results/{date}.json`。匯出 `calculateAccumulationScore(date, { prisma?, config? })`。
  - `check-intraday-breakout.ts`：盤中一次性快照，把 breakout 三層套在 `mis.twse.com.tw` 即時報價（社群逆向端點）。輸出 `data/intraday-breakout-snapshots/{timestamp}.json`。匯出 `checkIntradayBreakout({ prisma?, config?, now? })`。`pnpm tsx scripts/screening/check-intraday-breakout.ts`。

### 回測系統 — 已放棄（2026-08-31）

回測系統（ROADMAP 第 3 節，Layer 0～Layer 3 + 訓練/驗證切分 + 完整儀表板 UI）**已從 `main` 移除，且不再撿回**。2026-08-30 曾因效能問題擱置，2026-08-31 決定直接放棄這條路——參數校準改用「肉眼看單日排名 + 實盤觀察」。完整實作凍結在 `feat/backtest-ui-3.6-3.7` 分支（回測第 4 批做完的狀態），僅供參考。移除的檔案：`scripts/backtest/*`、`scripts/lib/backtest-{replay,stats,stats.test,config-hash}.ts`、`lib/actions/backtest.ts`、`app/backtest/*`、`components/{BacktestRunner,BacktestSummary,ForwardReturnsBuilder}.tsx` 及 `components/backtest/*`。

放棄原因：`runBacktestSummary` 進儀表板時把整個 run 的 `raw-factors/*.jsonl` 一次 `JSON.parse` 進記憶體，即使「一年 breakout」也讓 Next dev server heap OOM（8 GB 打滿）。要修得把 Layer 0 讀取整個改成逐日串流，投入產出比不划算。

**留在 `main` 的殘留物**（都是回測前置抽出的，選股腳本正式跑不用，但留著無害、不要刪）：
- `scripts/lib/{breakout,accumulation}-shared.ts` 的 config 三件組（`XxxConfig` / `DEFAULT_XXX_CONFIG` / `resolveXxxConfig`）與 `fetchXxxRawInputs` helper。
- `scripts/lib/types.ts` 的 `DeepPartial<T>`。
- 這些讓「用 config 覆蓋參數跑一次比對排名」這種輕量校準仍可行。

### `scripts/backfill/` — 歷史回補（偶爾手動）

- **`backfill-daily-quotes.ts`**：FinMind 逐支回補歷史報價至 `DailyQuote`（只跑 `securityType=stock`）。回補區間為 `BACKFILL_START_DATE`（預設 `2020-01-01`）到執行當天，實測 FinMind 單支查詢 6 年不會被截斷。`pnpm tsx scripts/backfill/backfill-daily-quotes.ts`（`BACKFILL_LIMIT` 限制測試支數；`BACKFILL_START_DATE=YYYY-MM-DD` 覆蓋起始日）。
- **`backfill-institutional-trading.ts`**：逐支一般股票用 FinMind 回補歷史三大法人買賣超至 `InstitutionalTrading`（TWSE 可回補任意歷史，TPEx 受端點限制效果有限）。回補區間同上。單支失敗不中斷。`pnpm tsx scripts/backfill/backfill-institutional-trading.ts`（`BACKFILL_LIMIT=10` 小量測試）。**已執行完成（6 年回補）**：2026-08-28 實測 `InstitutionalTrading` 涵蓋 **2020-01-02 → 2026-08-28、約 1476 個交易日、2,662,485 筆、每年 1808~1983 檔**（逐年筆數：2020=349,547／2021=376,427／2022=388,570／2023=392,978／2024=429,336／2025=432,544／2026(至 08-28)=293,083）。與 `DailyQuote`（3,066,466 筆）、`TechnicalIndicator`（3,060,066 筆）同為 2020-01-02 起，可支撐 accumulation 回測拉滿 6 年區間。（舊紀錄「2025-05-02 起 324 個交易日」已過時，是 2026-08-27 6 年回補前的狀態。）
- **`backfill-benchmark-quotes.ts`**：FinMind 回補回測用大盤基準標的的 `DailyQuote`（目前 `BENCHMARK_CODES = ["0050"]`，要加 006208／其他改陣列）。**只寫 `DailyQuote`，不碰 `TechnicalIndicator` / `InstitutionalTrading`**——基準只需要收盤價算報酬。0050 為未還原股價，除息日 `close` 含假跌幅；若基準報酬對除息敏感，日後改抓 `TaiwanStockPriceAdj`。`pnpm tsx scripts/backfill/backfill-benchmark-quotes.ts`。**已執行**：0050 已補 2020-01-02 ~ 今，約 1612 筆。
- **`backfill-index-quotes.ts`**：FinMind `TaiwanStockPrice?data_id=TAIEX` 回補加權指數日線至 `DailyQuote`（開頭 upsert `Stock{ code:"TAIEX", securityType:"index" }`）。照抄 `backfill-benchmark-quotes.ts` 結構（`REQUEST_DELAY_MS`、`BACKFILL_START_DATE` 覆蓋、upsert `DailyQuote`），**只寫 `DailyQuote`**。給大盤濾網算 MA60/帶寬用，不進選股。`pnpm tsx scripts/backfill/backfill-index-quotes.ts`（`BACKFILL_START_DATE=YYYY-MM-DD` 覆蓋，預設 `2020-01-01`）。**已執行**：TAIEX 已補 2020-01-02 ~ 今，1618 筆。
- **`update-shares-outstanding.ts`**：下載 MOPS 股本 CSV 更新 `Stock.sharesOutstanding`。**獨立手動執行，月頻，不進 daily pipeline**。`pnpm tsx scripts/backfill/update-shares-outstanding.ts`。

### `scripts/lib/` — 純函式庫

- **`signal-factors.ts`（ROADMAP 4.5.3 統一因子庫）**：`run-signal-scan.ts` 的單一 import 點。**只 re-export + 新增，不搬評分邏輯本體**（舊 `breakout-shared.ts` / `accumulation-shared.ts` 零改動，舊三支不受影響）。新增：`computeInstitutionalFlow()`（三大法人流向：近 5 日投信+外資淨買超各 ÷ `volumeMa20` → clip `[0,0.5]` 線性 0~100 → 投信 0.6/外資 0.4；突破當日淨賣超 → `min(score, 40)`；當日法人 null → 不封頂但 degraded。**另收 `marginSurgePercentile` 輸入、回 `marginChasing` 布林**——`marginSurgePercentile !== null && > surgePercentileThreshold(80) && 突破當日法人淨賣超` → true。**不動 score**，只給呼叫端掛 `SignalResult.warnings`）、`computeMarginSurgePercentile()`（純函式：融資餘額近 `lookbackDays`(5) 日累積變化率，對「這檔過去 `historyWindowDays`(40) 天各自的同種變化率」母體取百分位，**用嚴格小於**避免平盤誤觸發；母體有效樣本 < `minHistoryDays`(20) → null）、`computeBreakoutMarginMonotone()`（§2.5：> 3% 封頂 100 不倒扣，只讀 `kneePct`；舊 `computeBreakoutMargin` 不動）、`consecutiveAboveBand()`（階段判定 helper，回 `{ ok, latestAboveBand, consecutiveDays }`；`computeFirstBar` 本體不動）、`SignalScanConfig` / `DEFAULT_SIGNAL_CONFIG` / `resolveSignalConfig`（三處偏離舊 breakout：`baseCurve` 0.4/0.6、`breakoutMargin` monotone、7 項各 ×0.90 勻出 `institutionalFlow: 0.10`；`breakout.institutionalFlow.marginChasing` 子區塊 = `margin-chasing` 觸發參數，首版拍腦袋待校準）。單測 `signal-factors.test.ts`（`node:test` + `pnpm tsx --test`，31 案）。
- **`mis-quotes.ts`（MIS 即時報價抓取，純 Node 函式庫）**：2026-09-01 從 `check-intraday-breakout.ts` 抽出，`run-signal-scan.ts` realtime 路徑與 `check-intraday-breakout.ts` 共用。`fetchMisBatch` / `fetchAllMisQuotes(stocks, onBatch?)` / `parseMisDate` / `computeElapsedRatio` / `MisQuote` 型別 / `BATCH_SIZE`(120) / `BATCH_DELAY_MS`(1500)。**行為變更**：缺成交價（`z` 為 `-`/缺）的 row **不再跳過**、`price: null` 保留，由呼叫端決定代入（`run-signal-scan.ts` 用 `h`；`check-intraday-breakout.ts` 自己 `if (quote.price === null) continue`）。
- **`http.ts`**：`daily-pipeline.ts` 三個抓取步驟共用的 HTTP 工具（無 Prisma/CLI）。匯出 `fetchJson<T>(url, options?)`：每次嘗試帶 `AbortSignal.timeout`（預設 30s），對網路層拋錯（`ECONNRESET`/`terminated`/timeout）與 5xx/429 自動退避重試（預設 3 次，2s→4s），對其他 4xx 不重試。存在理由：pipeline 無人值守執行，裸 fetch 遇一次 TLS 連線中斷就整條掛掉（2026-08-28 事故）。**回應內容判斷（非交易日 `stat`/`totalCount`/空陣列）仍留在各呼叫端**。`backfill-*.ts` 等手動腳本目前未接。
- **`types.ts`**：純型別工具，目前只有 `DeepPartial<T>`（遞迴可選，`resolve*Config(override?)` 與回測引擎共用）。
- **config 三件組（兩個 shared 檔各一套，回測參數化前置，ROADMAP 3.1）**：`breakout-shared.ts` / `accumulation-shared.ts` 各匯出 `XxxConfig` 型別（分 `gate` 門檻類 + `score` 加權/曲線/視窗類兩子物件）、`DEFAULT_XXX_CONFIG`（從既有 `export const` 常數組出來，舊常數全保留當單一數值來源）、`resolveXxxConfig(override?: DeepPartial<XxxConfig>)`（手寫 2 層展開合併）。**門檻類走 `gate`**（`minMarketCap` / `minVolumeShares` / `triggerVolumeRatio` / `minAvgVolumeShares`，決定誰進候選池）、**加權/曲線/視窗/degraded 門檻走 `score`**（不剔除股票，只改分數怎麼組）。純函式一律吃「該函式需要的最小 config 片段」，不讀 module-level 常數。
- **`breakout-shared.ts`**：`calculate-breakout-strength.ts` / `check-intraday-breakout.ts` / `signal-factors.ts`（re-export 用）共用（無 CLI，但 import 了 `PrismaClient` 型別 + 多個查 DB 的 helper）。內容：舊 `GATES`/`WEIGHTS`/`TRIGGER_VOLUME_RATIO` 等常數（保留）、`BreakoutConfig`/`DEFAULT_BREAKOUT_CONFIG`/`resolveBreakoutConfig`、`rankScore`/`clip`，以及 `computeVolumeStrength`/`computeBreakoutMargin`/`computeFirstBar`/`computeBase`/`computeProximityToHigh`/`computeMarketWideReturns`/`computeCandleShape` 七項評分函式。**撈 DB helper**（2026-08-29 為回測 Layer 0 抽入，選股腳本正式跑也可用）：`fetchTodayQuotes` / `fetchIndicatorsForDate` / `fetchHistoryWindow` / `fetchBreakoutRawInputs(prisma, date, windows, codes?)`（回傳每股 `{ quote, indicator, prevTradingDate, firstBarSeries, history, rsCloseSeries }`；`codes` 省略 = 全市場；`windows` 帶視窗長度）。**已抽進 `config.score.curves` 的曲線轉折點**：`computeVolumeStrength`（2×→40/6×→100）、`computeBreakoutMargin`（3% 轉折 + 每 1% 扣 5 分 + 下限 60）、`computeBase`（0.6/0.4 權重 + duration 封頂 40 天）。`computeCandleShape`/`computeProximityScale`/`computeFirstBar`/`computeBase` 的 p25 門檻維持寫死。`GATES.minMarketCap` 為 30 億。
- **`accumulation-shared.ts`**：`calculate-accumulation-score.ts` 用。純評分函式無 Prisma；2026-08-29 起追加的 `fetchAccumulationRawInputs`（為回測 Layer 0 抽入）import `PrismaClient` 型別且查 DB（比照 `breakout-shared.ts`）。內容：舊視窗/門檻/權重常數（保留，`INSTITUTIONAL_WINDOW_DAYS=20`、`SQUEEZE_VOLUME_WINDOW_DAYS=5`、`MIN_AVG_VOLUME_SHARES`、`READINESS_FLOOR` 等）、`AccumulationConfig`/`DEFAULT_ACCUMULATION_CONFIG`/`resolveAccumulationConfig`、`rankScore`/`clip`、`computeTrustRawMetrics`/`computeOtherInstitutionRatio`/`computeQuietVolumeRatio`/`combineChipScore`/`combineTrustScore`/`computeReadinessCoefficient`/`combineFinalScore`，以及 `fetchAccumulationRawInputs(prisma, date, codes, volumeMa20ByCode, windows)`（從 `buildFactorInputs` 抽出、去掉門檻篩選）。壓縮度分數沿用 `breakout-shared.ts` 的 `computeBase`，曲線參數取 `DEFAULT_BREAKOUT_CONFIG.score.curves.base`。
- **`market-regime.ts`**：大盤濾網（市場狀態燈號）純函式庫（無 CLI，允許查 DB，比照 `breakout-shared.ts`）。`calculateMarketRegime(date, { prisma, config? })` → `MarketRegimeResult`（`label: "bullish"|"neutral"|"bearish"` / `totalScore` / `dimensions.{indexPosition,ma60Slope,breadth}` 各為 `DimensionScore | null` / `stage`）。三維度各投 `-1|0|1`：**breadth** = 該日全市場 `securityType="stock"` 有 `DailyQuote` 的股票中 `close > 當日 TechnicalIndicator.ma60` 佔比，`>55%` +1 / `<45%` -1 / 分母 <500 → `degraded`；**indexPosition** = TAIEX 收盤 vs 自己 MA60，連 `indexPosBufferDays`(=3) 日都在上／下才 ±1，混合則 0（過濾 whipsaw）；**ma60Slope** = TAIEX 的 MA60 近 `ma60SlopeLookbackDays`(=5) 交易日斜率 `(今−N日前)/N日前`，`>±0.5%` → ±1。`stage` 由 `hasTaiexIndicatorForDate()` 自動判定（有 TAIEX 該日 `ma60` → `step2-full` 三票合成、`totalScore >= ±2` → bullish/bearish；沒有 → `step1-breadth-only` 只看 `breadth.score`，優雅降級）。門檻集中在 `DEFAULT_REGIME_CONFIG`（首版未校準）。查 DB helper 同檔：`fetchBreadthInputs` / `fetchTaiexCloseVsMa60` / `fetchTaiexMa60Series` / `hasTaiexIndicatorForDate`。**三維度已全部上線。**

（`backtest-replay.ts` / `backtest-stats.ts` / `backtest-stats.test.ts` / `backtest-config-hash.ts` 隨回測系統放棄移出 `main`，見上方「回測系統 — 已放棄」段。）

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
