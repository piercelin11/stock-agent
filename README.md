# Stock Agent

台股觀察/分析 agent 的後端資料層 + 前端介面。抓取證交所（TWSE）與櫃買中心（TPEx）公開資料與 FinMind API，存進 PostgreSQL，透過 Claude Code 互動式地做篩選、族群分析、新聞整合等工作；前端（Next.js App Router）提供回測與日常操作的介面殼。

## 目前功能

### 資料層（`scripts/`）

`scripts/` 依用途分子資料夾：`pipeline/`（每日自動）、`screening/`（選股，手動）、`backtest/`（回測四層：Layer 0 因子引擎 + Layer 0.5 forward-returns cache + 資料完整性檢查；Layer 1/2/3 純函式在 `lib/`）、`backfill/`（歷史回補，偶爾手動）、`lib/`（純函式庫 + 撈 DB helper）、`archive/`（已停用，不維護）。

### `scripts/pipeline/`

- `daily-pipeline.ts`：每日排程主控腳本，只做「當日資料獲取 + 核心指標計算」五步：補齊今日 TWSE+TPEx 報價 → 抓今日三大法人籌碼 → 抓今日估值（本益比/股價淨值比/殖利率）→ 算技術指標 → 算產業熱度。歷史缺漏回補、跑選股皆為個別手動執行。三個抓取步驟的對外請求走 `scripts/lib/http.ts` 的 `fetchJson`（3 次 retry + 30s timeout），單一暫時性網路錯誤不會讓整條 pipeline 中斷。
- `fill-daily-quotes.ts`：補齊全市場報價——TWSE 用證交所 `MI_INDEX` 報表 API，支援指定任意單一天（可補歷史缺漏）；TPEx 用櫃買中心 OpenAPI，不支援指定日期，只能補「目前最新一天」。皆會自動新增資料庫沒有的股票記錄。
- `fill-institutional-trading.ts`：抓取指定日期的 TWSE（`T86`）+ TPEx（`tpex_3insti_daily_trading`）三大法人買賣超寫入 `InstitutionalTrading`。TWSE 支援任意歷史日期，TPEx 不支援日期參數、永遠回傳「目前最新一天」。
- `fill-gap-valuation.ts`：抓取指定日期的個股估值（本益比/股價淨值比/殖利率）寫入 `StockValuation`，TWSE 與 TPEx 皆支援任意歷史日期。
- `calculate-technical-indicators.ts`：計算 MA5/10/20/60、布林通道、量能均線、波動度、最大回撤、ATR、RSI、MACD 狀態等技術指標。
- `calculate-industry-heat.ts`：依每日報價計算各產業等權熱度（平均漲跌幅、漲跌家數、排名）寫入 `IndustryHeatSnapshot`，支援回補多個交易日。

### `scripts/screening/`

- `calculate-breakout-strength.ts`：篩出帶量帶價第一根突破布林的股票並依訊號強度排名（觸發 → 資格門檻 → 七項強度評分，含 K 棒型態）。核心常數與評分函式抽在 `scripts/lib/breakout-shared.ts`，與 `check-intraday-breakout.ts` 共用。匯出 `calculateBreakoutStrength(date, { prisma?, config? })`（回測用；未傳 `prisma` 則自建並自行關閉）。
- `calculate-accumulation-score.ts`：盤後選股 v2「投信吃貨訊號」——找還沒突破、但籌碼/技術面在醞釀的股票，與 `calculate-breakout-strength.ts` 互補。乘法計分：`籌碼分數（投信動能×0.7 + 排除投信的外資/自營商集中度×0.3）× 技術就緒係數（布林壓縮度/窒息量合成，下限 0.5）`。候選池先排除「已站上布林上軌」與「近 20 日均量 < 500 張」。待校準參數集中在 `scripts/lib/accumulation-shared.ts`。匯出 `calculateAccumulationScore(date, { prisma?, config? })`。不接進 `daily-pipeline.ts`。
- `check-intraday-breakout.ts`：盤中一次性快照篩選，把 `calculate-breakout-strength.ts` 的邏輯提前套用在 `mis.twse.com.tw` 即時報價上，手動執行看收盤前該注意哪些股票。匯出 `checkIntradayBreakout({ prisma?, config?, now? })`。不排程、不接進 `daily-pipeline.ts`。
- `scripts/lib/`：純函式庫。`http.ts`（retry/timeout fetch）、`breakout-shared.ts` / `accumulation-shared.ts`（各含常數 + `XxxConfig` 型別 + `DEFAULT_XXX_CONFIG` + `resolveXxxConfig` + 評分純函式 + `fetchXxxRawInputs` 撈 DB helper，供 Layer 0 與正式跑共用）、`types.ts`（`DeepPartial`）。

### `scripts/backtest/`

- `check-data-completeness.ts`：給定回測區間，掃 `DailyQuote` / `TechnicalIndicator` / `InstitutionalTrading` 三表覆蓋率，抓「整段缺日期」與「單股缺漏」（`thinStocks`：實際筆數 / 應有筆數 < 0.9；區間中途上市的新股不誤報）。回報但不自動修，有 hard failure（覆蓋率 < 95% 等）時 exit 1。獨立可跑，也被 `run-layer0.ts` 開跑前呼叫。
- `run-layer0.ts`：Layer 0 批次歷史模擬引擎。對區間每個交易日，用選股純函式撈全市場每檔的「門檻裸值 + rankScore 前的原始聚合值」寫入 `data/backtest-runs/{run-id}/raw-factors/{date}.jsonl`（一行一檔，不套門檻/不算分數/不寫 DB）。同時寫 `config.json`（range / strategy / git hash / `sharedLibHash` / `windowConfig`）與 `progress.json`（背景任務進度，原子寫）。`--resume=<run-id>` 從斷點續跑。搭配前端 `/backtest` 頁的按鈕觸發（`lib/actions/backtest.ts` spawn detached 子進程）。`data/backtest-runs/` 已進 `.gitignore`，需手動清。
- `build-forward-returns.ts`：Layer 0.5 forward-returns cache。對區間每個 (交易日, 全市場一般股票) 用之後的 `DailyQuote` 算 5/10/20 日報酬 + 0050 同期報酬，寫入 `data/backtest-cache/forward-returns.jsonl`（全域、跨策略共用，算過的 (date, code) 跳過；`--force` 重算）。「第 N 天」用該股自己的報價序列數，不足 N 筆記 `null`。命中判定不寫進 cache。
- `load-forward-returns.ts`：`loadForwardReturns()` → `ForwardReturnLookup`，供統計模組 / Server Action 讀 cache。

`scripts/lib/` 的回測純函式：`backtest-replay.ts`（Layer 1/2 記憶體重算 `replayBreakout` / `replayAccumulation` + `*Range`，逐位元對齊 screening 腳本）、`backtest-stats.ts`（Layer 3 `computeBacktestStats` → 命中率 / 平均·中位數報酬 / 勝率 / 賺賠比 / 最大回撤 / 按季 / 分數分層 / train-valid 分段）、`backtest-stats.test.ts`（`pnpm tsx --test`）。

### `scripts/backfill/`

- `backfill-daily-quotes.ts`：用 FinMind API 逐支股票回補歷史報價至 `DailyQuote`，回補區間預設 `2020-01-01` 起（`BACKFILL_START_DATE` 覆蓋）到執行當天。
- `backfill-institutional-trading.ts`：用 FinMind API 逐支股票回補歷史三大法人買賣超至 `InstitutionalTrading`（回補區間同上），補上 `fill-institutional-trading.ts` 只能抓當天資料的歷史缺口。
- `backfill-benchmark-quotes.ts`：用 FinMind API 回補回測用大盤基準標的（目前 0050）的 `DailyQuote`，只寫報價、不碰技術指標/籌碼。
- `update-shares-outstanding.ts`：從 MOPS 公開 CSV 更新各股票已發行普通股數（月頻手動執行；市值用「股數 × 收盤價」現算，不落地存欄位）。

### 前端（`app/` + `lib/` + `components/`）

Next.js 16（App Router，Turbopack）+ React 19 + Tailwind CSS v4 + Recharts。目前只有骨架：

- `app/`：`layout.tsx`（側邊欄殼）、`page.tsx`（dashboard，顯示 DB 連通性卡片 + Recharts smoke 圖）、`backtest/page.tsx`（Layer 0 基準跑：策略/日期輸入 + 觸發鈕 + 進度條 + run 清單；每個完成的 run 有「跑統計摘要」按鈕顯示 hitRate / 平均報酬 / byTopN 等數字；另有「補 forward-returns cache」按鈕）。
- `lib/prisma.ts`：`PrismaClient` 單例（`globalThis` 快取，dev hot reload 不爆連線池），檔頭 `import "server-only"`。**只能在 Server Component / Server Action import。**
- `lib/actions/`：Server Actions（不建 REST/GraphQL API），檔頭 `"use server"`。
- `components/`：`ui/`（手刻基礎元件）、`ChartSmoke.tsx`。

完整回測 UI（參數滑桿即時回饋、儀表板圖表、個股檢視、版本比較）與選股 / 觀察清單頁尚未實作——`/backtest` 目前只有 Layer 0 觸發 + 統計摘要的最小驗證入口。

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

# --- 回測 ---

# 資料完整性檢查（Layer 0 開跑前確認三表覆蓋率；有 hard failure exit 1）
pnpm tsx scripts/backtest/check-data-completeness.ts --start=2024-01-02 --end=2026-05-30

# Layer 0 基準跑（全市場原始因子落地 JSONL，一次一個策略）
pnpm tsx scripts/backtest/run-layer0.ts --strategy=breakout --start=2024-01-02 --end=2026-05-30
pnpm tsx scripts/backtest/run-layer0.ts --strategy=accumulation --start=2024-01-02 --end=2026-05-30
# 斷點續跑
pnpm tsx scripts/backtest/run-layer0.ts --resume=breakout-20260830-143012
# 或從前端 /backtest 頁按鈕觸發（背景子進程 + 進度條輪詢）

# Layer 0.5 forward-returns cache（全域、跨策略共用；算過的 (date, code) 跳過）
pnpm tsx scripts/backtest/build-forward-returns.ts --start=2024-01-02 --end=2026-05-30
# 改了報酬定義時重算：--force / 自訂 horizon：--horizons=5,10,20,60

# 統計純函式單測
pnpm tsx --test scripts/lib/backtest-stats.test.ts

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
