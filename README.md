# Stock Agent

台股觀察/分析 agent 的後端資料層 + 前端介面。抓取證交所（TWSE）與櫃買中心（TPEx）公開資料與 FinMind API，存進 PostgreSQL，透過 Claude Code 互動式地做篩選、族群分析、新聞整合等工作；前端（Next.js App Router）提供回測與日常操作的介面殼。

## 目前功能

### 資料層（`scripts/`）

`scripts/` 依用途分子資料夾：`pipeline/`（每日自動）、`screening/`（選股，手動）、`backfill/`（歷史回補，偶爾手動）、`lib/`（純函式庫）、`archive/`（已停用，不維護）。

### `scripts/pipeline/`

- `daily-pipeline.ts`：每日排程主控腳本，只做「當日資料獲取 + 核心指標計算」五步：補齊今日 TWSE+TPEx 報價 → 抓今日三大法人籌碼 → 抓今日估值（本益比/股價淨值比/殖利率）→ 算技術指標 → 算產業熱度。歷史缺漏回補、跑選股皆為個別手動執行。三個抓取步驟的對外請求走 `scripts/lib/http.ts` 的 `fetchJson`（3 次 retry + 30s timeout），單一暫時性網路錯誤不會讓整條 pipeline 中斷。
- `fill-daily-quotes.ts`：補齊全市場報價——TWSE 用證交所 `MI_INDEX` 報表 API，支援指定任意單一天（可補歷史缺漏）；TPEx 用櫃買中心 OpenAPI，不支援指定日期，只能補「目前最新一天」。皆會自動新增資料庫沒有的股票記錄。
- `fill-institutional-trading.ts`：抓取指定日期的 TWSE（`T86`）+ TPEx（`tpex_3insti_daily_trading`）三大法人買賣超寫入 `InstitutionalTrading`。TWSE 支援任意歷史日期，TPEx 不支援日期參數、永遠回傳「目前最新一天」。
- `fill-gap-valuation.ts`：抓取指定日期的個股估值（本益比/股價淨值比/殖利率）寫入 `StockValuation`，TWSE 與 TPEx 皆支援任意歷史日期。
- `calculate-technical-indicators.ts`：計算 MA5/10/20/60、布林通道、量能均線、波動度、最大回撤、ATR、RSI、MACD 狀態等技術指標。
- `calculate-industry-heat.ts`：依每日報價計算各產業等權熱度（平均漲跌幅、漲跌家數、排名）寫入 `IndustryHeatSnapshot`，支援回補多個交易日。

### `scripts/screening/`

- `calculate-breakout-strength.ts`：篩出帶量帶價第一根突破布林的股票並依訊號強度排名（觸發 → 資格門檻 → 七項強度評分，含 K 棒型態）。核心常數與評分函式抽在 `scripts/lib/breakout-shared.ts`，與 `check-intraday-breakout.ts` 共用。
- `calculate-accumulation-score.ts`：盤後選股 v2「投信吃貨訊號」——找還沒突破、但籌碼/技術面在醞釀的股票，與 `calculate-breakout-strength.ts` 互補。乘法計分：`籌碼分數（投信動能×0.7 + 排除投信的外資/自營商集中度×0.3）× 技術就緒係數（布林壓縮度/窒息量合成，下限 0.5）`。候選池先排除「已站上布林上軌」與「近 20 日均量 < 500 張」。待校準參數集中在 `scripts/lib/accumulation-shared.ts`。不接進 `daily-pipeline.ts`。
- `check-intraday-breakout.ts`：盤中一次性快照篩選，把 `calculate-breakout-strength.ts` 的邏輯提前套用在 `mis.twse.com.tw` 即時報價上，手動執行看收盤前該注意哪些股票。不排程、不接進 `daily-pipeline.ts`。

### `scripts/backfill/`

- `backfill-daily-quotes.ts`：用 FinMind API 逐支股票回補歷史報價至 `DailyQuote`，回補區間預設 `2020-01-01` 起（`BACKFILL_START_DATE` 覆蓋）到執行當天。
- `backfill-institutional-trading.ts`：用 FinMind API 逐支股票回補歷史三大法人買賣超至 `InstitutionalTrading`（回補區間同上），補上 `fill-institutional-trading.ts` 只能抓當天資料的歷史缺口。
- `backfill-benchmark-quotes.ts`：用 FinMind API 回補回測用大盤基準標的（目前 0050）的 `DailyQuote`，只寫報價、不碰技術指標/籌碼。
- `update-shares-outstanding.ts`：從 MOPS 公開 CSV 更新各股票已發行普通股數（月頻手動執行；市值用「股數 × 收盤價」現算，不落地存欄位）。

### 前端（`app/` + `lib/` + `components/`）

Next.js 16（App Router，Turbopack）+ React 19 + Tailwind CSS v4 + Recharts。目前只有骨架：

- `app/`：`layout.tsx`（側邊欄殼）、`page.tsx`（dashboard，顯示 DB 連通性卡片 + Recharts smoke 圖 + 背景任務 PoC）。
- `lib/prisma.ts`：`PrismaClient` 單例（`globalThis` 快取，dev hot reload 不爆連線池），檔頭 `import "server-only"`。**只能在 Server Component / Server Action import。**
- `lib/actions/`：Server Actions（不建 REST/GraphQL API），檔頭 `"use server"`。
- `components/`：`ui/`（手刻基礎元件）、`ChartSmoke.tsx`、`PocRunner.tsx`。
- `scripts/_poc/` + `lib/actions/poc.ts` + `components/PocRunner.tsx`：背景任務機制 PoC（子進程 + 進度寫檔 + Server Action 輪詢），回測系統開發時會刪除換成正式 runner。

業務頁面（回測 UI、選股、觀察清單）尚未實作。

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
