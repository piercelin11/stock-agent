# Stock Agent

台股觀察/分析 agent 的後端資料層 + 前端介面。抓取證交所（TWSE）與櫃買中心（TPEx）公開資料與 FinMind API，存進 PostgreSQL，透過 Claude Code 互動式地做篩選、族群分析、新聞整合等工作；前端（Next.js App Router）提供日常操作的介面殼。

> **歷史回測系統已擱置**（2026-08-30）：Layer 0～Layer 3 + 訓練/驗證切分 + 完整儀表板 UI 已從 `main` 移除，完整實作保留在 `feat/backtest-ui-3.6-3.7` 分支。擱置原因見 `docs/PROGRESS.md`（進儀表板時整個 run 的 raw-factors 一次讀進記憶體 → Next dev server OOM，要改成逐日串流才可用）。`git checkout feat/backtest-ui-3.6-3.7` 可撿回。

## 目前功能

### 資料層（`scripts/`）

`scripts/` 依用途分子資料夾：`pipeline/`（每日自動）、`screening/`（選股，手動）、`backfill/`（歷史回補，偶爾手動）、`lib/`（純函式庫 + 撈 DB helper）、`archive/`（已停用，不維護）。（`scripts/backtest/` 隨回測系統擱置移除。）

### `scripts/pipeline/`

- `daily-pipeline.ts`：每日排程主控腳本，只做「當日資料獲取 + 核心指標計算」七步：補齊今日 TWSE+TPEx 報價 → 抓今日三大法人籌碼 → 抓今日估值（本益比/股價淨值比/殖利率）→ 抓今日融資融券餘額（非關鍵路徑，證交所通常傍晚才出）→ 算技術指標 → 算大盤濾網（市場狀態燈號，非關鍵路徑，失敗只警告）→ 算產業熱度。歷史缺漏回補、跑選股皆為個別手動執行。抓取步驟的對外請求走 `scripts/lib/http.ts` 的 `fetchJson`（3 次 retry + 30s timeout），單一暫時性網路錯誤不會讓整條 pipeline 中斷。
- `fill-daily-quotes.ts`：補齊全市場報價——TWSE 用證交所 `MI_INDEX` 報表 API，支援指定任意單一天（可補歷史缺漏）；TPEx 用櫃買中心 OpenAPI，不支援指定日期，只能補「目前最新一天」。皆會自動新增資料庫沒有的股票記錄。
- `fill-institutional-trading.ts`：抓取指定日期的 TWSE（`T86`）+ TPEx（`tpex_3insti_daily_trading`）三大法人買賣超寫入 `InstitutionalTrading`。TWSE 支援任意歷史日期，TPEx 不支援日期參數、永遠回傳「目前最新一天」。
- `fill-gap-valuation.ts`：抓取指定日期的個股估值（本益比/股價淨值比/殖利率）寫入 `StockValuation`，TWSE 與 TPEx 皆支援任意歷史日期。
- `fill-margin-trading.ts`：抓取指定日期的個股信用交易餘額（融資、融券）寫入 `MarginTrading`，來源 TWSE `MI_MARGN` + TPEx `margin/balance`，兩邊皆支援任意歷史日期。單位一律存「股」（原始為張，入庫 ×1000）。`--date=YYYY-MM-DD`（不帶抓今天）/ `--backfill=N`（往回抓、跳非交易日，實得約 N 個交易日）。`daily-pipeline.ts` 第 3.5 步（非關鍵路徑）。下游：`run-signal-scan.ts` 的 `margin-chasing` 警示（突破當日法人淨賣超 + 這檔融資近期暴增 → 標記，不動分數）。
- `calculate-technical-indicators.ts`：計算 MA5/10/20/60、布林通道、量能均線、波動度、最大回撤、ATR、RSI、MACD 狀態等技術指標（全市場一般股票 + TAIEX；傳代號陣列只重算指定幾支）。`mode: "full"`（預設 / CLI）= 全歷史重算；`mode: "latest"`（`daily-pipeline.ts` 用）= 每支只算並寫入最新一天，秒級。
- `calculate-market-regime.ts`：大盤濾網（市場狀態燈號）——三維度（市場寬度、TAIEX 指數位置、TAIEX MA60 斜率）各投 ±1 合成 `bullish` / `neutral` / `bearish` 三段標籤，寫 `data/market-regime/{date}.json`（不進 DB）。TAIEX 指標未備妥時自動降級為「只用市場寬度」單維度。`daily-pipeline.ts` 第 5 步（非關鍵路徑）。
- `calculate-industry-heat.ts`：依每日報價計算各產業等權熱度（平均漲跌幅、漲跌家數、排名）寫入 `IndustryHeatSnapshot`，支援回補多個交易日。

### `scripts/screening/`

- `run-signal-scan.ts`：**統一選股引擎**（三路線收斂）。跑全市場一般股票 → 單一 gate（30 億市值 + 當日量 1000 張 + 近 20 日均量 500 張）→ 依「連續站上布林上軌天數」打階段標籤 `pre-breakout`（醞釀中）/ `breakout-day`（今日突破）/ `extended`（已延伸）→ 同一份因子分、階段套不同合併方式（醞釀 = 乘法「籌碼分 × 就緒係數」；突破 = 8 分項加權和）→ 各階段各自排名 → 落地 `data/signal-scan-results/`。**資料源自動切換**：今天有 `DailyQuote` → 讀 DB（盤後定案）；沒有 → 打 `mis.twse.com.tw` 即時報價（缺成交價用當日最高價代入、標 `estimated`）。匯出 `runSignalScan(date, { prisma?, config?, source?, now? })`。CLI：不帶參數自動判斷 / `--date=YYYY-MM-DD`（強制盤後補算）/ `--source=realtime|eod`。不接進 `daily-pipeline.ts`。
- `_run-signal-scan.ts`：被選股頁 `startSignalScan()` spawn 的內部 runner（非手動執行入口），只跑 realtime，最外層覆寫 `progress.json` 終態。
- （舊三支 `calculate-breakout-strength.ts` / `calculate-accumulation-score.ts` / `check-intraday-breakout.ts` + 孤兒 runner `_run-intraday-scan.ts` 已於 4.5.4（2026-09-01）退役刪除，功能全由 `run-signal-scan.ts` 涵蓋。）
- `scripts/lib/`：純函式庫。`http.ts`（retry/timeout fetch）、`signal-factors/`（統一因子庫目錄：`index.ts` barrel + `util.ts`（`clip`/`rankScore`）+ `breakout.ts` / `accumulation.ts`（常數 + `XxxConfig` 三件組 + 評分純函式 + `fetchXxxRawInputs` 撈 DB helper）+ `institutional.ts`（`computeInstitutionalFlow` / `computeMarginSurgePercentile`）+ `staging.ts`（`consecutiveAboveBand` / `computeBreakoutMarginMonotone`）+ `config.ts`（`SignalScanConfig` / `DEFAULT_SIGNAL_CONFIG` / `resolveSignalConfig`）；單測 `signal-factors/factors.test.ts`）、`mis-quotes.ts`（MIS 即時報價抓取）、`market-regime.ts`（大盤濾網）、`types.ts`（`DeepPartial`）。

### `scripts/backfill/`

- `backfill-daily-quotes.ts`：用 FinMind API 逐支股票回補歷史報價至 `DailyQuote`，回補區間預設 `2020-01-01` 起（`BACKFILL_START_DATE` 覆蓋）到執行當天。
- `backfill-institutional-trading.ts`：用 FinMind API 逐支股票回補歷史三大法人買賣超至 `InstitutionalTrading`（回補區間同上），補上 `fill-institutional-trading.ts` 只能抓當天資料的歷史缺口。
- `backfill-benchmark-quotes.ts`：用 FinMind API 回補回測用大盤基準標的（目前 0050）的 `DailyQuote`，只寫報價、不碰技術指標/籌碼。
- `backfill-index-quotes.ts`：用 FinMind `TaiwanStockPrice?data_id=TAIEX` 回補加權指數日線至 `DailyQuote`（開頭自建 `Stock` 記錄 `code="TAIEX"`、`securityType="index"`）。只寫報價，給大盤濾網算 MA60/帶寬用，不進選股。
- `update-shares-outstanding.ts`：從 MOPS 公開 CSV 更新各股票已發行普通股數（月頻手動執行；市值用「股數 × 收盤價」現算，不落地存欄位）。

### 前端（`app/` + `lib/` + `components/`）

Next.js 16（App Router，Turbopack）+ React 19 + Tailwind CSS v4 + `clsx` / `tailwind-merge` / `class-variance-authority`。**全站固定深色**（無 light/dark 切換）。

- 配色：`app/globals.css` 的**角色化** semantic color token（`bg-background` / `bg-card` / `bg-muted` / `text-foreground` / `text-muted-foreground` / `border-border` / `bg-primary` / `text-up` / `text-warning` / `text-destructive`…）為單一出處，值為 HEX；token 代表「用途」不是「色階深淺」，要更淡的字用 `text-foreground/80` 這類透明度修飾。元件不直接寫 `slate-*` / `blue-*` 等色階。`lib/cn.ts` 的 `cn()` = `clsx` + `tailwind-merge`；`Button.tsx` 用 `cva` 定義 variant。
- `app/`：`layout.tsx`（側邊欄）、`page.tsx`（Dashboard：資料狀態卡 + 觀察類股今日表現表）、`screening/`（選股頁）、`watchlist/`（觀察清單頁）。
- `lib/prisma.ts`：`PrismaClient` 單例（`globalThis` 快取，dev hot reload 不爆連線池），檔頭 `import "server-only"`。**只能在 Server Component / Server Action import。**
- `lib/actions/`：Server Actions（不建 REST/GraphQL API），檔頭 `"use server"`——`health.ts` / `signal-scan.ts`（統一選股：`getScanMode` + eod 同步跑 + realtime 背景任務）/ `watchlist.ts` / `dashboard.ts`（觀察類股今日表現）/ `market-regime.ts`（大盤濾網燈號，純讀 `data/market-regime/` 檔）/ `pipeline.ts`（首頁「立即更新資料」）。
- `components/`：`ui/`（手刻基礎元件）、`screening/`、`watchlist/`、`dashboard/`。

**Dashboard `/`**：頂部一條大盤濾網橫幅（市場狀態燈號：偏多綠 / 中性琥珀 / 偏空紅 + 三段對應的部位建議文字，可展開看維度明細）。下方 ①「資料狀態」卡＝今日行情燈號（DB 最新交易日 vs Asia/Taipei 今日，綠 / 紅）＋ 一般股票檔數 ＋ 當日四表（報價 / 籌碼 / 技術指標 / 融資融券）覆蓋率百分比 ＋「立即更新資料」按鈕（背景跑整個 daily pipeline，可離開頁面、切回接上進度，跑完自動刷新覆蓋率）。②「觀察類股今日表現」＝觀察清單每檔一張卡片（grid 2–4 欄），左側 60 日走勢圖（Y 軸用布林帶寬正規化＝收盤相對布林中軌的偏離比例，所有卡同刻度 → 盤整期線壓中線、噴出頂到邊界，卡跟卡之間絕對起伏可比；線色依當日漲跌紅綠 + 線下漸層），右側代號 / 漲跌% / 突破 pill + K 棒·力道（量能）·位階（打底深度）三分數 + 三大法人 / 投信淨買超。全部用 `scripts/lib/signal-factors/` 的評分函式現算，不重跑全市場選股。

**選股頁 `/screening`**：頁頂一條精簡大盤濾網燈號（同 Dashboard 資料源）。**單一「跑掃描」按鈕**——自動判斷資料源：今天有盤後資料 → 同步跑「盤後掃描」（秒級）；還沒有 → 「盤中掃描」背景任務（spawn 子進程對 `mis.twse.com.tw` 即時報價跑全市場快照約 20–30 秒 → 進度條輪詢；可切走再回來看進度）。跑完一張表格 + 三個階段 tab（今日突破 / 已延伸 / 醞釀中，預設「今日突破」）→ 點列展開明細（突破階段三欄：60 日走勢圖 / 法人籌碼 diverging bar + 結論 chip / 突破因子長條；醞釀中只有走勢圖）→ 勾選一鍵加入觀察清單。表格欄位含狀態 pill、量增倍數（`x2.5`）、籌碼結論 chip。盤中缺成交價的檔用最高價代入、列尾標「估」。突破階段若「突破當日法人淨賣超 + 這檔融資餘額近期暴增」籌碼 chip 轉紅「融資追價」（`margin-chasing` 警示，僅提示不影響分數）。結果不寫資料庫（落地 `data/signal-scan-results/`）。

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
#   /screening：選股頁（單一掃描按鈕，自動判斷盤後/盤中資料源；階段 filter；勾選加入觀察清單）
#   /watchlist：觀察清單頁（買入狀態編輯、當日三表快照）

# --- 資料層 ---

# 初次建置資料庫（股票清單 + 產業別）
pnpm prisma db seed

# 每日主流程（補齊今日 TWSE+TPEx 報價 → 抓今日籌碼 → 抓今日估值 → 抓今日融資融券 → 算技術指標 → 算大盤濾網 → 算產業熱度）
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
```

## 專案規劃

詳見 [docs/PLAN.md](docs/PLAN.md)。
