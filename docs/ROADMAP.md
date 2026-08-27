# Roadmap

近期要做的事、順序、跟為什麼這樣排。跟 `PLAN.md`（單一任務的實作規格書，做完即被下一份取代）不同，這份是持續累積更新的「目前打算怎麼走」，做完的項目打勾保留，不刪除，方便回顧。

## 依賴關係

```
盤後選股 v2 ──✓ 已完成（待參數校準）
      │
      ▼
前端 scaffolding（Next.js + Prisma Server Actions）
      │
      ▼
歷史回測系統  ◄── 優先
  ├─ 腳本參數化（前置）
  ├─ 批次模擬 + 效果評估 + 訓練/驗證期切分
  └─ 回測儀表板（版本比較、個股檢視）
      │
      ▼
選股 → 挑股 → 觀察清單流程（日常操作殼）
      │
      ▼
盤中提醒
  └─ 依賴：觀察清單存在 + 資料庫可從外部連線
```

實作順序：**scaffolding → 回測系統 → 日常選股/觀察清單流程 → 盤中提醒**。回測優先——「調參數、驗證訊號有沒有預測力」是現在最需要的（第 1 階段的參數校準就卡在沒有回測框架）。scaffolding 得先做（回測 UI 也要用），但日常用的「選股→挑股→觀察清單」流程排在回測之後。盤中提醒放最後，依賴觀察清單有內容、也依賴資料庫能被 GitHub Actions 連到。

---

## 1. 盤後選股 v2（投信吃貨訊號）— ✅ 程式碼完成，待參數校準

找「還沒出現第一根突破，但籌碼/技術面有醞釀跡象」的股票，跟 `calculate-breakout-strength.ts`（找已發生的突破事件）互補。

- [x] 四因子 + 乘法計分結構：`最終分數 = 籌碼分數(投信動能 ×0.7 + 排除投信的外資/自營商集中度 ×0.3) × 技術就緒係數(布林壓縮度/窒息量合成，下限 0.5)`。實作於 `scripts/calculate-accumulation-score.ts` + `scripts/accumulation-shared.ts`，輸出 `data/accumulation-score-results/{date}.json`。設計細節見 `docs/PROGRESS.md`（2026-08-27 段落）。
- [ ] **參數校準**：首版前 30 名偏大型股（「其他法人集中度」子項對權值股外資穩定流入給高分所致）。需肉眼看實際排名，調整 `accumulation-shared.ts` 的 `CHIP_WEIGHTS` / `READINESS_FLOOR` / `MIN_AVG_VOLUME_SHARES` 等常數。**併入第 3 階段（回測）一起做**——用訓練/驗證期框架校準，比單看一天的前 30 名更有說服力。

## 2. 前端 scaffolding（Next.js + Prisma）

回測 UI 與後續日常操作介面共用的殼。這階段只搭骨架、不做業務頁面。

- [ ] 在既有 repo 內建 Next.js（App Router）。專案目前零前端（`package.json` 無 next/react，`src/` 空）——決定放 `app/` 還是 `web/` 子目錄、與 `scripts/` 共用 `generated/prisma` client
- [ ] **Next.js + Prisma 單例**：dev hot reload 會重複建立 connection pool，用 `globalThis` 快取 `PrismaClient`（搭配既有的 `PrismaPg` driver adapter 寫法）
- [ ] 不另建 REST/GraphQL API，一律用 **Server Actions** 直接呼叫 Prisma 與選股純函式
- [ ] 圖表庫定案（傾向 Recharts）、基本版面/導覽/樣式方案
- [ ] 背景任務機制：回測會跑幾百個交易日，需要「Server Action 觸發 → 背景 worker → UI 輪詢進度」的模式，先確立怎麼做（獨立 node 進程 / worker、進度寫 DB）

## 3. 歷史回測系統 ◄── 優先

驗證選股訊號有沒有預測力，並提供「調參數 → 看訓練期表現 → 用驗證期確認」的閉環。優先回測兩個策略：**冷水區選股（accumulation）** 與 **第一根突破（breakout-strength / intraday-breakout）**。交易策略測試（停損停利、進出場規則）不列進 ROADMAP，僅在 3.4 備註為未來可能擴充。

### 3.1 腳本參數化（前置）

- [ ] `calculateAccumulationScore(date, config?)` — `config` 可覆蓋 `accumulation-shared.ts` 的所有常數（`CHIP_WEIGHTS` / `TRUST_SUB_WEIGHTS` / `TECH_WEIGHTS` / `READINESS_FLOOR` / 視窗天數 / `MIN_AVG_VOLUME_SHARES`），不傳則回退現有預設。輸出 JSON 已內嵌 `params` 區塊，格式沿用
- [ ] `calculateBreakoutStrength(date, config?)` — `config` 可覆蓋 `breakout-shared.ts` 的 `GATES` / `WEIGHTS` / `TRIGGER_VOLUME_RATIO` / 各視窗常數，不傳則回退
- [ ] `breakout-shared.ts` 內嵌的 magic number（`computeVolumeStrength` 的 2×→40/6×→100、`computeBreakoutMargin` 的 3% 轉折、`computeBase` 的 0.6/0.4 權重等）評估哪些值得抽成 config、哪些維持寫死
- [ ] 從 `check-intraday-breakout.ts` 的私有 `main()` 抽出可呼叫的純函式（目前完全沒匯出），供回測用歷史資料模擬盤中快照——**注意**：TPEx 盤中/歷史端點限制（見 CLAUDE.md），盤中訊號的歷史回測可能只能對 TWSE 或只能用收盤資料近似
- [ ] 確認參數化沒改變預設行為：對同一天用「不傳 config」與「傳等於預設值的 config」跑，輸出需完全一致

### 3.2 回測資料表（新增 Prisma model）

- [ ] `ParamVersion` — 具名參數版本（`name` 如 "v1-保守" / "v2-投信為主"、`strategy` enum、`config Json`、`createdAt`、`notes`）。可存多版並排比較，不互相覆蓋
- [ ] `BacktestRun` — 一次回測執行（`paramVersionId`、`strategy`、`trainStart`/`trainEnd`/`validStart`/`validEnd`、`status`、`progress`、`startedAt`/`finishedAt`、彙總統計 `summary Json`）
- [ ] `BacktestCandidate` — 回測期內每個交易日每檔候選股（`backtestRunId`、`date`、`stockCode`、`score`、`rank`、`factorBreakdown Json`、以及事後算出的 `returnN Json`（5/10/20 日報酬）、`hitBenchmark Boolean`、`period` train/valid）。量大，這張表要加好 index
- [ ] migration

### 3.3 批次歷史模擬引擎

- [ ] 對回測期內每個交易日，用給定 `config` 跑一次選股純函式，產生當天候選名單，寫入 `BacktestCandidate`（不只存記憶體——要反覆比對）
- [ ] 背景任務執行（可能跑幾百個交易日）：Server Action 觸發 → 背景 worker 逐日跑 → 更新 `BacktestRun.progress`，UI 輪詢進度
- [ ] 資料完整性檢查：回測期需要的 `DailyQuote` / `TechnicalIndicator` / `InstitutionalTrading` 是否齊全（目前 `InstitutionalTrading` 有 2025-05-02 起 324 個交易日；`TechnicalIndicator` 歷史視窗看 `backfill-daily-quotes` 補到哪）

### 3.4 效果評估模組（與選股邏輯分離）

- [ ] 對每筆候選股，用訊號日之後的 `DailyQuote` OHLC 獨立計算：訊號後 N 日（5/10/20，可設定）報酬率
- [ ] 對照組：同期大盤報酬（加權指數）或同期隨機挑股，作為 benchmark
- [ ] `hitBenchmark` = 該候選股 N 日報酬是否贏過 benchmark
- [ ] （選配）簡單停損停利規則模擬：用後續 OHLC 判斷先觸發停利還是停損，算實際報酬——**優先度低，先做「訊號有沒有預測力」，這塊之後再擴充**

### 3.5 統計匯總模組

- [ ] 彙總每次 `BacktestRun`：命中率（贏過 benchmark 比例）、平均/中位數報酬、勝率、賺賠比、最大回撤
- [ ] 按時間分段的穩定性（避免只在某段市況特別準）——例如每季一個 bucket
- [ ] 訓練期與驗證期分開統計、同一組參數跑

### 3.6 訓練/驗證期切分

- [ ] `BacktestRun` 明確記錄「這組參數是在哪段訓練期調出來的」
- [ ] 驗證期結果與訓練期分開顯示，用同一組參數跑
- [ ] UI 視覺警示：不要用驗證期資料回頭調參數（那樣驗證期就失去意義）

### 3.7 回測 UI

- [ ] **設定頁**：參數輸入面板（`GATES` / `WEIGHTS` / 各因子轉折點常數）、日期範圍（訓練/驗證分開選、視覺警示）、版本命名與存檔
- [ ] **執行頁**：觸發批次、進度條、跑完後的原始候選名單表
- [ ] **結果儀表板頁**：命中率/平均報酬/勝率/賺賠比等關鍵指標卡片 + 圖表（報酬分布直方圖、命中率隨時間折線圖、訓練 vs 驗證並排）
- [ ] **個股檢視頁**：單一候選股當天完整評分明細 + 後續實際走勢圖 + 是否命中，方便肉眼校準時對照
- [ ] **版本比較頁**：至少兩組參數版本並排顯示各項統計，這是「肉眼校準權重」最實際會用到的功能
- [ ] 用回測框架回頭完成第 1 階段的「參數校準」待辦

## 4. 選股 → 挑股 → 觀察清單流程（日常操作殼）

回測驗證過訊號後，做日常實際會用的介面：手動觸發選股 → 挑合適的股 → 加入觀察清單（含買入狀態）。

### 4.1 選股 → 挑股

- [ ] 選股頁：按鈕觸發（Server Action 同步在 Next.js 進程內直接 import 呼叫 `calculateAccumulationScore(date)` / `calculateBreakoutStrength(date)`，跑最新交易日）→ 表格呈現候選股（可依因子分數/欄位排序）→ 點單檔看完整評分明細
- [ ] 兩種策略分頁：「第一根突破」（breakout-strength）與「冷水區醞釀」（accumulation）
- [ ] 從候選股表格勾選 → 一鍵加入觀察清單

### 4.2 觀察清單升級

- [ ] `WatchlistItem` schema 加欄位：`isPurchased Boolean @default(false)`、`buyPrice Decimal?`、`buyDate DateTime?`、`targetPrice Decimal?`、`stopLossPrice Decimal?`（欄位名待實作時定；直接加在 `WatchlistItem` 即可，不另建 model——一支股票最多一筆的語意不變）
- [ ] migration + 既有資料相容（現有 `WatchlistItem` 只有 `stockCode`/`addedAt`/`notes`）
- [ ] 觀察清單頁：列出清單、可切換買入狀態、填買入價、加備註、移除
- [ ] 每檔顯示當日報價 + 關鍵技術/籌碼欄位（讀 `DailyQuote` / `TechnicalIndicator` / `InstitutionalTrading` 最新一筆）

> Note：「尾盤 LLM 分析（依買入狀態判斷該買/該賣）」暫不排進 ROADMAP，等 UI 與回測穩定後再評估要不要做、怎麼做。

## 5. 盤中提醒

定期檢查觀察股，依「是否已買入」決定提醒時機，出現大跌大漲或不確定訊號時推播。細節等第 4 階段做完、實際盯盤有手感後再細訂。

### 5.1 基礎建設

- [ ] **資料庫外部連線**：目前是本機 Postgres（`localhost:5432`），GitHub Actions 連不到。決定：(a) 搬到雲端 Postgres（Supabase/Neon/RDS），或 (b) 開本機 Postgres 的外部連線（動態 IP / 安全性顧慮較多）。這決定整個盤中提醒的排程方式走不走得通
- [ ] **通知管道定案**：傾向 Telegram（設定最快、免費無額度限制、手機即時推播），Discord/Email 為備選。實作發送模組（目前 repo 零通知程式碼與依賴）
- [ ] **排程方式定案**：
  - launchd / 本地伺服器：依賴本機在跑，跟「人不在電腦前也要收到」對不上
  - GitHub Actions cron：不依賴本機，方向較對，但需 5.1 的資料庫外部連線先解決；cron 最小 5 分鐘、不保證準點

### 5.2 提醒邏輯

- [ ] 盤中即時報價來源：沿用 `check-intraday-breakout.ts` 用的 `mis.twse.com.tw` 端點（社群逆向工程、非官方）
- [ ] 對觀察清單逐檔判斷：
  - 未買入：出現「第一根突破」訊號 / 接近設定的目標買價 → 提醒「可考慮進場」
  - 已買入：跌破停損價 / 觸及停利價 / 單日大跌 → 提醒「注意風險」
- [ ] 定義「大跌大漲或不確定訊號」的具體判斷邏輯（門檻、用哪些指標）——等實際盯盤有手感再定
- [ ] 提醒去重（同一檔同一訊號一天只提醒一次）
