# Stock Agent

台股觀察/分析 agent 的後端資料層 + 前端介面。抓取證交所（TWSE）與櫃買中心（TPEx）公開資料與 FinMind API，存進 PostgreSQL，透過 Claude Code 互動式地做篩選、族群分析、新聞整合等工作；前端（Next.js App Router）提供日常操作的介面殼。

> **歷史回測系統已擱置**（2026-08-30）：Layer 0～Layer 3 + 訓練/驗證切分 + 完整儀表板 UI 已從 `main` 移除，完整實作保留在 `feat/backtest-ui-3.6-3.7` 分支。擱置原因見 `docs/PROGRESS.md`（進儀表板時整個 run 的 raw-factors 一次讀進記憶體 → Next dev server OOM，要改成逐日串流才可用）。`git checkout feat/backtest-ui-3.6-3.7` 可撿回。

## 目前功能

### 資料層（`scripts/`）

`scripts/` 依用途分子資料夾：`pipeline/`（每日自動）、`screening/`（選股，手動）、`backfill/`（歷史回補，偶爾手動）、`lib/`（純函式庫 + 撈 DB helper）、`archive/`（已停用，不維護）。（`scripts/backtest/` 隨回測系統擱置移除。）

### `scripts/pipeline/`

- `daily-pipeline.ts`：每日排程主控腳本，只做「當日資料獲取 + 核心指標計算」五步：補齊今日 TWSE+TPEx 報價 → 抓今日三大法人籌碼 → 抓今日估值（本益比/股價淨值比/殖利率）→ 算技術指標 → 算產業熱度。歷史缺漏回補、跑選股皆為個別手動執行。三個抓取步驟的對外請求走 `scripts/lib/http.ts` 的 `fetchJson`（3 次 retry + 30s timeout），單一暫時性網路錯誤不會讓整條 pipeline 中斷。
- `fill-daily-quotes.ts`：補齊全市場報價——TWSE 用證交所 `MI_INDEX` 報表 API，支援指定任意單一天（可補歷史缺漏）；TPEx 用櫃買中心 OpenAPI，不支援指定日期，只能補「目前最新一天」。皆會自動新增資料庫沒有的股票記錄。
- `fill-institutional-trading.ts`：抓取指定日期的 TWSE（`T86`）+ TPEx（`tpex_3insti_daily_trading`）三大法人買賣超寫入 `InstitutionalTrading`。TWSE 支援任意歷史日期，TPEx 不支援日期參數、永遠回傳「目前最新一天」。
- `fill-gap-valuation.ts`：抓取指定日期的個股估值（本益比/股價淨值比/殖利率）寫入 `StockValuation`，TWSE 與 TPEx 皆支援任意歷史日期。
- `calculate-technical-indicators.ts`：計算 MA5/10/20/60、布林通道、量能均線、波動度、最大回撤、ATR、RSI、MACD 狀態等技術指標。
- `calculate-industry-heat.ts`：依每日報價計算各產業等權熱度（平均漲跌幅、漲跌家數、排名）寫入 `IndustryHeatSnapshot`，支援回補多個交易日。

### `scripts/screening/`

- `calculate-breakout-strength.ts`：篩出帶量帶價第一根突破布林的股票並依訊號強度排名（觸發 → 資格門檻 → 七項強度評分，含 K 棒型態）。核心常數與評分函式抽在 `scripts/lib/breakout-shared.ts`，與 `check-intraday-breakout.ts` 共用。匯出 `calculateBreakoutStrength(date, { prisma?, config? })`（未傳 `prisma` 則自建並自行關閉；回傳含 `results` 候選名單陣列，供前端選股頁直接取用）。
- `calculate-accumulation-score.ts`：盤後選股 v2「投信吃貨訊號」——找還沒突破、但籌碼/技術面在醞釀的股票，與 `calculate-breakout-strength.ts` 互補。乘法計分：`籌碼分數（投信動能×0.7 + 排除投信的外資/自營商集中度×0.3）× 技術就緒係數（布林壓縮度/窒息量合成，下限 0.5）`。候選池先排除「已站上布林上軌」與「近 20 日均量 < 500 張」。待校準參數集中在 `scripts/lib/accumulation-shared.ts`。匯出 `calculateAccumulationScore(date, { prisma?, config? })`（回傳含 `results` 候選名單陣列）。不接進 `daily-pipeline.ts`。
- `check-intraday-breakout.ts`：盤中一次性快照篩選，把 `calculate-breakout-strength.ts` 的邏輯提前套用在 `mis.twse.com.tw` 即時報價上，手動執行看收盤前該注意哪些股票。匯出 `checkIntradayBreakout({ prisma?, config?, now? })`（回傳 `IntradaySnapshotOutput`；執行時逐批寫 `data/intraday-breakout-snapshots/progress.json`）。不排程、不接進 `daily-pipeline.ts`。也是選股頁「盤中即時掃描」tab 的後端（背景任務模式）。
- `_run-intraday-scan.ts`：被選股頁 `startIntradayScan()` spawn 的內部 runner（非手動執行入口），最外層覆寫 `progress.json` 的 `done` / `error`。
- `scripts/lib/`：純函式庫。`http.ts`（retry/timeout fetch）、`breakout-shared.ts` / `accumulation-shared.ts`（各含常數 + `XxxConfig` 型別 + `DEFAULT_XXX_CONFIG` + `resolveXxxConfig` + 評分純函式 + `fetchXxxRawInputs` 撈 DB helper）、`types.ts`（`DeepPartial`）。

### `scripts/backfill/`

- `backfill-daily-quotes.ts`：用 FinMind API 逐支股票回補歷史報價至 `DailyQuote`，回補區間預設 `2020-01-01` 起（`BACKFILL_START_DATE` 覆蓋）到執行當天。
- `backfill-institutional-trading.ts`：用 FinMind API 逐支股票回補歷史三大法人買賣超至 `InstitutionalTrading`（回補區間同上），補上 `fill-institutional-trading.ts` 只能抓當天資料的歷史缺口。
- `backfill-benchmark-quotes.ts`：用 FinMind API 回補回測用大盤基準標的（目前 0050）的 `DailyQuote`，只寫報價、不碰技術指標/籌碼。
- `update-shares-outstanding.ts`：從 MOPS 公開 CSV 更新各股票已發行普通股數（月頻手動執行；市值用「股數 × 收盤價」現算，不落地存欄位）。

### 前端（`app/` + `lib/` + `components/`）

Next.js 16（App Router，Turbopack）+ React 19 + Tailwind CSS v4。**全站固定深色**（無 light/dark 切換）。

- `app/`：`layout.tsx`（側邊欄）、`page.tsx`（Dashboard：資料狀態卡 + 觀察類股今日表現表）、`screening/`（選股頁）、`watchlist/`（觀察清單頁）。
- `lib/prisma.ts`：`PrismaClient` 單例（`globalThis` 快取，dev hot reload 不爆連線池），檔頭 `import "server-only"`。**只能在 Server Component / Server Action import。**
- `lib/actions/`：Server Actions（不建 REST/GraphQL API），檔頭 `"use server"`——`health.ts` / `screening.ts` / `watchlist.ts` / `intraday.ts`（盤中掃描背景任務）/ `dashboard.ts`（觀察類股今日表現）。
- `components/`：`ui/`（手刻基礎元件）、`screening/`、`watchlist/`、`dashboard/`。

**Dashboard `/`**：①「資料狀態」卡＝今日行情燈號（DB 最新交易日 vs Asia/Taipei 今日，綠 / 紅）＋ 一般股票檔數 ＋ 當日三表（報價 / 籌碼 / 技術指標）覆蓋率百分比。②「觀察類股今日表現」＝觀察清單每檔一張卡片（grid 2–4 欄），左側 60 日走勢圖（Y 軸用布林帶寬正規化＝收盤相對布林中軌的偏離比例，所有卡同刻度 → 盤整期線壓中線、噴出頂到邊界，卡跟卡之間絕對起伏可比；線色依當日漲跌紅綠 + 線下漸層），右側代號 / 漲跌% / 突破 pill + K 棒·力道（量能）·位階（打底深度）三分數 + 三大法人 / 投信淨買超。全部用 `breakout-shared.ts` 的評分函式現算，不重跑全市場選股。

**選股頁 `/screening`**：三個分頁。「第一根突破」/「冷水區醞釀」按鈕觸發 Server Action 同步跑最新交易日的盤後選股。「盤中即時掃描」走背景任務模式（spawn 子進程對 `mis.twse.com.tw` 即時報價跑全市場快照約 20–30 秒 → 進度條輪詢 → 跑完看候選表格；可切走再回來看進度）。三者跑完都是可排序表格 → 點列看評分明細 → 勾選一鍵加入觀察清單。結果不寫資料庫。

**觀察清單頁 `/watchlist`**：列出清單、切換買入狀態、填買入價 / 買入日 / 目標價 / 停損價 / 備註、移除；每檔顯示當日報價 + 技術指標（MA / 布林 / RSI / MACD）+ 三大法人淨買超（讀三表最新一筆）。

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
#   /screening：選股頁（三分頁：兩盤後策略同步跑 + 盤中即時掃描背景任務，勾選加入觀察清單）
#   /watchlist：觀察清單頁（買入狀態編輯、當日三表快照）

# --- 資料層 ---

# 初次建置資料庫（股票清單 + 產業別）
pnpm prisma db seed

# 每日主流程（補齊今日 TWSE+TPEx 報價 → 抓今日籌碼 → 抓今日估值 → 算技術指標 → 算產業熱度）
pnpm tsx scripts/pipeline/daily-pipeline.ts

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

# 計算產業熱度（不帶參數算最近一個交易日；--backfill N 往回補 N 個交易日）
pnpm tsx scripts/pipeline/calculate-industry-heat.ts --backfill 20

# --- 選股（手動）---

# 篩出帶量突破候選股並依強度排名（不帶 --date 則用最新交易日）
pnpm tsx scripts/screening/calculate-breakout-strength.ts --date=2026-08-18

# 盤後選股 v2：投信吃貨訊號排名（不帶 --date 則用最新交易日）
pnpm tsx scripts/screening/calculate-accumulation-score.ts --date=2026-08-26

# 盤中一次性快照篩選（無參數，本質是「現在」的快照）
pnpm tsx scripts/screening/check-intraday-breakout.ts

# 回測系統已擱置，指令見 feat/backtest-ui-3.6-3.7 分支的 README

# --- 歷史回補（偶爾手動）---

# 逐支股票回補歷史報價（預設 2020-01-01 起；BACKFILL_START_DATE 覆蓋起始日）
pnpm tsx scripts/backfill/backfill-daily-quotes.ts

# 回補歷史三大法人籌碼（逐支股票，預設 2020-01-01 起，可用 BACKFILL_LIMIT 限制測試）
pnpm tsx scripts/backfill/backfill-institutional-trading.ts

# 回補大盤基準標的報價（目前 0050，回測用）
pnpm tsx scripts/backfill/backfill-benchmark-quotes.ts

# 更新已發行股數（月頻手動執行）
pnpm tsx scripts/backfill/update-shares-outstanding.ts
```

## 專案規劃

詳見 [docs/PLAN.md](docs/PLAN.md)。
