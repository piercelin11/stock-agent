# Stock Agent

台股觀察/分析 agent 的後端資料層 + 前端介面。抓取證交所（TWSE）與櫃買中心（TPEx）公開資料與 FinMind API，存進 PostgreSQL，透過 Claude Code 互動式地做篩選、族群分析、新聞整合等工作；前端（Next.js App Router）提供日常操作的介面殼。

> **歷史回測系統已擱置**（2026-08-30）：Layer 0～Layer 3 + 訓練/驗證切分 + 完整儀表板 UI 已從 `main` 移除，完整實作保留在 `feat/backtest-ui-3.6-3.7` 分支。擱置原因見 `docs/PROGRESS.md`（進儀表板時整個 run 的 raw-factors 一次讀進記憶體 → Next dev server OOM，要改成逐日串流才可用）。`git checkout feat/backtest-ui-3.6-3.7` 可撿回。

## 目前功能

### 資料層（`scripts/`）

`scripts/` 依用途分子資料夾：`pipeline/`（每日自動）、`screening/`（選股，手動）、`backfill/`（歷史回補，偶爾手動）、`lib/`（純函式庫 + 撈 DB helper）、`archive/`（已停用，不維護）。（`scripts/backtest/` 隨回測系統擱置移除。）

### `scripts/pipeline/`

- `intraday-scan.ts`：盤中掃描薄殼（launchd 觸發，非 daily-pipeline 的一步）。內部判「台北平日 09:00–13:30？」否則靜默 exit 0；是則跑 `run-signal-scan.ts` 的 realtime 路徑，寫 `data/signal-scan-results/{台北今日}-intraday.json`（**不寫資料庫**；單一檔每 30 分原子覆蓋，不再累積時間戳檔）。搭配 `com.piercelin.intradayscan.plist`（台北平日 10:00–13:30 整點 + 半點觸發，週末靠腳本內部 skip）。下游：選股頁 / 觀察清單頁 `intraday` 模式進頁讀這份（選股頁若該份缺失 > 10% 會同步重抓）。
- `daily-pipeline.ts`：每日排程主控腳本，只做「當日資料獲取 + 核心指標計算」八步：補齊今日報價（TWSE 關鍵路徑；TPEx 非關鍵路徑，失敗只警告、隔天再抓）→ 補今日加權指數 TAIEX 行情（FinMind，關鍵路徑）→ 抓今日三大法人籌碼 → 抓今日估值（本益比/股價淨值比/殖利率）→ 抓今日融資融券餘額（非關鍵路徑，證交所通常傍晚才出）→ 算技術指標 → 算大盤濾網（市場狀態燈號，非關鍵路徑，失敗只警告）→ 算產業熱度。跑完無致命錯誤時寫 `data/daily-pipeline-runs/{date}.ok` 標記，同日重跑會秒退（供 launchd 17:00 / 17:30 / 18:00 三次觸發的補跑機制用）。歷史缺漏回補、跑選股皆為個別手動執行。抓取步驟的對外請求走 `scripts/lib/http.ts` 的 `fetchJson`（pipeline 對政府端點用 5 次 retry + 冷連線預熱），單一暫時性網路錯誤不會讓整條 pipeline 中斷。
- `fill-daily-quotes.ts`：補齊全市場報價——TWSE 用證交所 `MI_INDEX` 報表 API，支援指定任意單一天（可補歷史缺漏）；TPEx 用櫃買中心 OpenAPI，不支援指定日期，只能補「目前最新一天」。皆會自動新增資料庫沒有的股票記錄。
- `fill-institutional-trading.ts`：抓取指定日期的 TWSE（`T86`）+ TPEx（`tpex_3insti_daily_trading`）三大法人買賣超寫入 `InstitutionalTrading`。TWSE 支援任意歷史日期，TPEx 不支援日期參數、永遠回傳「目前最新一天」。
- `fill-gap-valuation.ts`：抓取指定日期的個股估值（本益比/股價淨值比/殖利率）寫入 `StockValuation`，TWSE 與 TPEx 皆支援任意歷史日期。
- `fill-margin-trading.ts`：抓取指定日期的個股信用交易餘額（融資、融券）寫入 `MarginTrading`，來源 TWSE `MI_MARGN` + TPEx `margin/balance`，兩邊皆支援任意歷史日期。單位一律存「股」（原始為張，入庫 ×1000）。`--date=YYYY-MM-DD`（不帶抓今天）/ `--backfill=N`（往回抓、跳非交易日，實得約 N 個交易日）。`daily-pipeline.ts` 第 3.5 步（非關鍵路徑）。下游：`run-signal-scan.ts` 的 `margin-chasing` 警示（突破當日法人淨賣超 + 這檔融資近期暴增 → 標記，不動分數）。
- `calculate-technical-indicators.ts`：計算 MA5/10/20/60、布林通道、量能均線、波動度、最大回撤、ATR、RSI、MACD 狀態等技術指標（全市場一般股票 + TAIEX；傳代號陣列只重算指定幾支）。`mode: "full"`（預設 / CLI）= 全歷史重算；`mode: "latest"`（`daily-pipeline.ts` 用）= 每支只算並寫入最新一天，秒級。
- `calculate-market-regime.ts`：大盤濾網（市場狀態燈號）——三維度（市場寬度、TAIEX 指數位置、TAIEX MA60 斜率）各投 ±1 合成 `bullish` / `neutral` / `bearish` 三段標籤，寫 `data/market-regime/{date}.json`（不進 DB）。TAIEX 指標未備妥時自動降級為「只用市場寬度」單維度。`daily-pipeline.ts` 第 5 步（非關鍵路徑）。
- `calculate-industry-heat.ts`：依每日報價計算各產業等權熱度（平均漲跌幅、漲跌家數、排名）寫入 `IndustryHeatSnapshot`，支援回補多個交易日。

### `scripts/screening/`

- `run-signal-scan.ts`：**統一選股引擎**（三路線收斂）。跑全市場一般股票 → 單一 gate（30 億市值 + 當日量 1000 張 + 近 20 日均量 500 張）→ 依「連續站上布林上軌天數」打階段標籤 `pre-breakout`（醞釀中）/ `breakout-day`（今日突破）/ `extended`（已延伸）→ 同一份因子分、階段套不同合併方式（醞釀 = 乘法「籌碼分 × 就緒係數」；突破 = 8 分項加權和）→ 各階段各自排名 → 落地 `data/signal-scan-results/`。**資料源自動切換**：今天有 `DailyQuote` → 讀 DB（盤後定案）；沒有 → 打 `mis.twse.com.tw` 即時報價（缺成交價用當日最高價代入、標 `estimated`）。**觀察清單成員豁免 gate**（帶 `fromWatchlist` 標記、`stats.watchlistExempt`）——被市值/量門檻篩掉的觀察股仍帶完整評分結果；另輸出 `watchlistQuotes`（所有觀察股即時報價）。匯出 `runSignalScan(date, { prisma?, config?, source?, now? })`。CLI：不帶參數自動判斷 / `--date=YYYY-MM-DD`（強制盤後補算）/ `--source=realtime|eod`。不接進 `daily-pipeline.ts`。
- （`_run-signal-scan.ts` 已於 PLAN 4（2026-09-01）刪除——選股頁不再前端 spawn realtime 掃描。盤中 realtime 掃描的背景執行者只剩 `scripts/pipeline/intraday-scan.ts`（launchd 每 30 分）。）
- （舊三支 `calculate-breakout-strength.ts` / `calculate-accumulation-score.ts` / `check-intraday-breakout.ts` + 孤兒 runner `_run-intraday-scan.ts` 已於 4.5.4（2026-09-01）退役刪除，功能全由 `run-signal-scan.ts` 涵蓋。）
- `scripts/lib/`：純函式庫。`http.ts`（retry/timeout fetch）、`signal-factors/`（統一因子庫目錄：`index.ts` barrel + `util.ts`（`clip`/`rankScore`）+ `breakout.ts` / `accumulation.ts`（常數 + `XxxConfig` 三件組 + 評分純函式 + `fetchXxxRawInputs` 撈 DB helper）+ `institutional.ts`（`computeInstitutionalFlow` / `computeMarginSurgePercentile`）+ `staging.ts`（`consecutiveAboveBand` / `computeBreakoutMarginMonotone`）+ `config.ts`（`SignalScanConfig` / `DEFAULT_SIGNAL_CONFIG` / `resolveSignalConfig`）；單測 `signal-factors/factors.test.ts`）、`mis-quotes.ts`（MIS 即時報價抓取）、`market-regime.ts`（大盤濾網）、`types.ts`（`DeepPartial`）。

### `scripts/backfill/`

- `backfill-daily-quotes.ts`：用 FinMind API 逐支股票回補歷史報價至 `DailyQuote`，回補區間預設 `2020-01-01` 起（`BACKFILL_START_DATE` 覆蓋）到執行當天。
- `backfill-institutional-trading.ts`：用 FinMind API 逐支股票回補歷史三大法人買賣超至 `InstitutionalTrading`（回補區間同上），補上 `fill-institutional-trading.ts` 只能抓當天資料的歷史缺口。
- `backfill-benchmark-quotes.ts`：用 FinMind API 回補回測用大盤基準標的（目前 0050）的 `DailyQuote`，只寫報價、不碰技術指標/籌碼。
- `backfill-index-quotes.ts`：用 FinMind `TaiwanStockPrice?data_id=TAIEX` 回補加權指數日線至 `DailyQuote`（自建 `Stock` 記錄 `code="TAIEX"`、`securityType="index"`）。只寫報價（完整 OHLC），給大盤濾網算 MA60/帶寬用，不進選股。另匯出 `fillTodayIndex(isoDate, prisma?)` 供 `daily-pipeline.ts` 第 1.5 步補當日 TAIEX。
- `update-shares-outstanding.ts`：從 MOPS 公開 CSV 更新各股票已發行普通股數（月頻手動執行；市值用「股數 × 收盤價」現算，不落地存欄位）。
- `mark-delisted.ts`：維護 `Stock.delistedAt` 下市標記（月頻手動執行）——最後行情距 DB 最新交易日超過 60 天（或從無行情）標記為下市，復牌自動清除；覆蓋率分母與 FinMind 回補清單會排除已下市股票。

### 前端（`app/` + `lib/` + `components/`）

Next.js 16（App Router，Turbopack）+ React 19 + Tailwind CSS v4 + `clsx` / `tailwind-merge` / `class-variance-authority`。**全站固定深色**（無 light/dark 切換）。

- 配色：`app/globals.css` 的**角色化** semantic color token（`bg-background` / `bg-card` / `bg-muted` / `text-foreground` / `text-muted-foreground` / `border-border` / `bg-primary` / `text-up` / `text-warning` / `text-destructive`…）為單一出處，值為 HEX；token 代表「用途」不是「色階深淺」，要更淡的字用 `text-foreground/80` 這類透明度修飾。元件不直接寫 `slate-*` / `blue-*` 等色階。`lib/cn.ts` 的 `cn()` = `clsx` + `tailwind-merge`；`Button.tsx` 用 `cva` 定義 variant。
- `app/`：`layout.tsx`（側邊欄）、`page.tsx`（Dashboard：資料狀態卡 + 觀察類股今日表現表）、`screening/`（選股頁）、`watchlist/`（觀察清單頁）。
- `lib/prisma.ts`：`PrismaClient` 單例（`globalThis` 快取，dev hot reload 不爆連線池），檔頭 `import "server-only"`。**只能在 Server Component / Server Action import。**
- `lib/actions/`：Server Actions（不建 REST/GraphQL API），檔頭 `"use server"`——`health.ts` / `signal-scan.ts`（統一選股：`getScreeningContext` + `getScreeningResult({force?})` 單一入口，依 `resolveDataContext().mode` 回結果——eod 同步跑、intraday/stale 讀最新 realtime JSON）/ `watchlist.ts` / `dashboard.ts`（觀察類股今日表現）/ `market-regime.ts`（大盤濾網燈號，純讀 `data/market-regime/` 檔）/ `pipeline.ts`（首頁「立即更新資料」）。
- `lib/data-context.ts` / `lib/latest-scan.ts`（非 `"use server"`，供多個 action import）：前者 `resolveDataContext()` 是「盤中該用資料庫昨收還是 MIS 即時」判斷的單一真相來源（`eod` / `intraday` / `stale` 三態）；後者 `readLatestScan()` 是選股結果 JSON 的唯一讀取入口。
- `components/`：`ui/`（手刻基礎元件）、`screening/`、`watchlist/`、`dashboard/`。

**Dashboard `/`**：頂部一條大盤濾網橫幅（市場狀態燈號：偏多綠 / 中性琥珀 / 偏空紅 + 三段對應的部位建議文字，可展開看維度明細）。下方 ①「資料狀態」卡＝今日行情燈號（DB 最新交易日 vs Asia/Taipei 今日，綠 / 紅）＋ 一般股票檔數 ＋ 當日四表（報價 / 籌碼 / 技術指標 / 融資融券）覆蓋率百分比 ＋「立即更新資料」按鈕（背景跑整個 daily pipeline，可離開頁面、切回接上進度，跑完自動刷新覆蓋率）。②「觀察類股今日表現」＝觀察清單每檔一張卡片（grid 2–4 欄），左側 60 日走勢圖（Y 軸用布林帶寬正規化＝收盤相對布林中軌的偏離比例，所有卡同刻度 → 盤整期線壓中線、噴出頂到邊界，卡跟卡之間絕對起伏可比；線色依當日漲跌紅綠 + 線下漸層），右側代號 / 漲跌% / 突破 pill + K 棒·力道（量能）·位階（打底深度）三分數 + 三大法人 / 投信淨買超。全部用 `scripts/lib/signal-factors/` 的評分函式現算，不重跑全市場選股。

**選股頁 `/screening`**：頁頂一條精簡大盤濾網燈號（同 Dashboard 資料源）。**進頁自動顯示結果**（跟觀察清單頁同一心智模型——`resolveDataContext()` 決定用哪份，讀一次就定住）：今天有盤後資料 → 進頁即同步跑一次「盤後掃描」（秒級，不用按任何按鈕）；還沒有 → 讀背景排程（`intraday-scan.ts`，launchd 每 30 分）產出的最新盤中掃描。**一顆按鈕手動重跑**：盤後模式「重跑盤後掃描」（秒級）；盤中模式「立即掃描」（Server Action 內同步對 `mis.twse.com.tw` 跑全市場快照，卡 UI 約 20–30 秒）。**無自動輪詢**——要看 launchd 產出的新掃描得手動重整頁面。跑完一張表格 + 三個階段 tab（首次突破 / 延續爆發 / 醞釀中，預設「首次突破」）→ 點列展開明細（突破階段三欄：60 日走勢圖 / 法人籌碼 diverging bar + 結論 chip / 突破因子長條；醞釀中兩欄：走勢圖 / 20 格投信買超日曆 + 投信、外資自營兩條全市場百分位進度條）→ 勾選一鍵加入觀察清單。表格欄位含狀態 pill、量增倍數（`x2.5`）、籌碼結論 chip。盤中缺成交價的檔用最高價代入、列尾標「估」。突破階段若「突破當日法人淨賣超 + 這檔融資餘額近期暴增」籌碼 chip 轉紅「融資追價」（`margin-chasing` 警示，僅提示不影響分數）。結果不寫資料庫（落地 `data/signal-scan-results/`）。

**觀察清單頁 `/watchlist`**：卡片 gallery（一列 1–4 張，依螢幕寬度）+ 階段分頁（首次突破 / 延續爆發 / 醞釀中，依「連續站上布林上軌天數」即時分類，預設「首次突破」）。每張卡：左上資料新鮮度標示（資料庫有當日資料 ⚡ / 盤中或昨收 🕐）、代號 / 漲跌% / stage pill / 籌碼結論 chip、60 日走勢圖、法人籌碼區塊（突破階段 = 近 5 日淨買超 diverging bar；醞釀階段 = 20 格投信買超日曆 + 投信 / 外資自營兩條全市場百分位進度條 + ⓘ 說明）、底排「量增 / 距年高 / 強度 PR / 突破幅度」（突破階段）或「量增」（醞釀中）。**資料源三分支**（統一走 `resolveDataContext()`，進頁不再打 MIS）：資料庫最新交易日 == 今日 → 用資料庫（⚡）；盤中且有夠新的盤中掃描結果 → 讀 `intraday-scan.ts` 產出的即時報價（🕐，「盤中 {日期}」）；盤外 → 用資料庫昨收（🕐，標「收盤定案 {日期}」）。強度 PR 與醞釀階段的投信/外資百分位讀最近一次掃描結果。移除鈕。

回測 UI 已擱置（見開頭說明）。

## 環境需求

- Node.js 22+（開發時實測 v22.16）
- pnpm（`package.json` 的 `packageManager` 鎖 `pnpm@8.15.4`，可 `corepack enable` 自動取得）
- PostgreSQL
- TypeScript 7（`^7.0.2`）——與 Next.js 16 / Prisma 7 / ESM 相容，無需降版

## 環境變數

在專案根目錄建立 `.env`：

```
DATABASE_URL="postgresql://<user>:<password>@localhost:5432/stock_agent?schema=public"
FINMIND_API_KEY="<可選，未設定則使用未註冊額度 300次/小時>"
```

可參考 [.env.example](.env.example)。

## 使用方式

```bash
# 安裝依賴
pnpm install

# --- 前端 ---

pnpm dev      # 開發伺服器（http://localhost:3000）
pnpm build    # 正式打包
pnpm start    # 跑打包後的正式伺服器
#   /          ：Dashboard（資料狀態卡 + 觀察類股今日表現表）
#   /screening：選股頁（單一掃描按鈕，自動判斷盤後/盤中資料源；階段 filter；勾選加入觀察清單）
#   /watchlist：觀察清單頁（卡片 gallery + 階段分頁；資料庫當日資料 ⚡ / 盤中或昨收 🕐）

# --- 資料層 ---

# 初次建置資料庫（股票清單 + 產業別）
pnpm prisma db seed

# 每日主流程（補齊今日報價 → 補 TAIEX → 抓今日籌碼 → 抓今日估值 → 抓今日融資融券 → 算技術指標 → 算大盤濾網 → 算產業熱度）
# 由 launchd（com.piercelin.dailypipeline.plist）每天 17:00 / 17:30 / 18:00 觸發；當日已成功則補跑秒退
pnpm tsx scripts/pipeline/daily-pipeline.ts

# 盤中掃描（launchd com.piercelin.intradayscan.plist 台北平日 10:00–13:30 整點+半點觸發；非交易時段跑會靜默 exit 0）
pnpm tsx scripts/pipeline/intraday-scan.ts

# --- pipeline 各步驟也可單獨執行 ---

# 補齊指定單一天的全市場報價（TWSE 可指定任意歷史日期，TPEx 固定補「目前最新一天」）
pnpm tsx scripts/pipeline/fill-daily-quotes.ts --date=2026-08-14

# 計算技術指標（全市場；或帶股票代號只重算那幾支）
pnpm tsx scripts/pipeline/calculate-technical-indicators.ts
pnpm tsx scripts/pipeline/calculate-technical-indicators.ts 4104

# 抓取指定日期的個股估值（不帶 --date 則抓今天）
pnpm tsx scripts/pipeline/fill-gap-valuation.ts --date=2026-08-18

# 抓取指定日期的三大法人籌碼（不帶 --date 則抓今天；TPEx 端不支援指定日期，永遠回傳最新一天）
pnpm tsx scripts/pipeline/fill-institutional-trading.ts --date=2026-08-21

# 抓取指定日期的個股融資融券餘額（不帶 --date 則抓今天；兩端皆支援歷史日期。--backfill=N 往回補約 N 個交易日）
pnpm tsx scripts/pipeline/fill-margin-trading.ts --date=2026-08-28
pnpm tsx scripts/pipeline/fill-margin-trading.ts --backfill=10

# 計算大盤濾網（市場狀態燈號；不帶參數算 DB 最新交易日，--date=YYYY-MM-DD 補算）
pnpm tsx scripts/pipeline/calculate-market-regime.ts

# 計算產業熱度（不帶參數算最近一個交易日；--backfill N 往回補 N 個交易日）
pnpm tsx scripts/pipeline/calculate-industry-heat.ts --backfill 20

# --- 選股（手動）---

# 統一選股引擎：跑全市場 → 階段標籤（醞釀中 / 今日突破 / 已延伸）→ 各階段各自排名
pnpm tsx scripts/screening/run-signal-scan.ts                  # 自動判斷盤後 / 盤中
pnpm tsx scripts/screening/run-signal-scan.ts --date=2026-08-31 # 強制盤後補算指定日
pnpm tsx scripts/screening/run-signal-scan.ts --source=realtime # 強制打 MIS 即時報價

# 因子庫單測
pnpm tsx --test scripts/lib/signal-factors/factors.test.ts

# 回測系統已擱置，指令見 feat/backtest-ui-3.6-3.7 分支的 README

# --- 歷史回補（偶爾手動）---

# 逐支股票回補歷史報價（預設 2020-01-01 起；BACKFILL_START_DATE 覆蓋起始日）
pnpm tsx scripts/backfill/backfill-daily-quotes.ts

# 回補歷史三大法人籌碼（逐支股票，預設 2020-01-01 起，可用 BACKFILL_LIMIT 限制測試）
pnpm tsx scripts/backfill/backfill-institutional-trading.ts

# 回補大盤基準標的報價（目前 0050，回測用）
pnpm tsx scripts/backfill/backfill-benchmark-quotes.ts

# 回補加權指數（TAIEX）日線（大盤濾網用；預設 2020-01-01 起）
pnpm tsx scripts/backfill/backfill-index-quotes.ts

# 更新已發行股數（月頻手動執行）
pnpm tsx scripts/backfill/update-shares-outstanding.ts

# 維護下市標記（月頻手動執行；標記 + 復牌清除雙向）
pnpm tsx scripts/backfill/mark-delisted.ts
```

## 專案規劃

詳見 [docs/PLAN.md](docs/PLAN.md)。
