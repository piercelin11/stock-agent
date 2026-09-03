# Roadmap

近期要做的事、順序、跟為什麼這樣排。跟 `PLAN.md`（單一任務的實作規格書，做完即被下一份取代）不同，這份是持續累積更新的「目前打算怎麼走」。

## 已完成（2026-08 ~ 2026-09）

盤後選股 v2、前端 scaffolding（Next.js + Prisma）、選股 → 挑股 → 觀察清單流程、籌碼面 / 大盤濾網強化（大盤燈號 4.5.1 / 融資融券資料層 4.5.2 / 選股引擎統一 4.5.3 / 舊三支退役 4.5.4）皆已完成。**歷史回測系統**做到「訓練/驗證切分 + 完整 UI」後因效能問題（進儀表板 OOM）於 2026-08-31 放棄，程式碼凍結在 `feat/backtest-ui-3.6-3.7` 分支，不再撿回。

**資料源統一 + 盤中即時性（四份 PLAN，2026-09-01）**：PLAN 1（daily-pipeline 冷進程穩定性——TPEx 非致命 + 冷連線預熱 + retry:5 + `.ok` 補跑標記）、PLAN 2（資料脈絡判斷收斂到 `lib/data-context.ts` 的 `resolveDataContext()` 單一 helper + `lib/latest-scan.ts` 掃描結果唯一讀取入口 + `run-signal-scan.ts` watchlist 成員豁免 gate → 6226 PR / 醞釀籌碼空白已解）、PLAN 3（`scripts/pipeline/intraday-scan.ts` + launchd 每 30 分盤中自動掃描、`/screening` 頁每 60 秒自動刷新、`/watchlist` 頁改讀掃描 JSON 三分支、進頁不再打 MIS；醞釀中卡片移除 K棒/力道/位階三分數）、PLAN 4（`/screening` 頁簡化——移除盤後/盤中 toggle + realtime 背景任務 spawn + 每 60 秒自動刷新，`_run-signal-scan.ts` 刪除；進頁一律 `getScreeningContext()` → `getScreeningResult()` 依 `resolveDataContext().mode` 回結果，讀一次就定住、要看新的手動重整——跟 watchlist 心智模型一致；「昨」badge 事故徹底解決）皆已完成並部署 launchd。**與下方第 5 節「盤中提醒」不同**——那是「人不在電腦前也收到推播」（依賴雲端 DB + GitHub Actions），這三份只做「伺服器開著時盤中資料即時、頁面資料源判斷統一」。

逐次的設計理由、實測數字、驗證過程全部記在 [docs/PROGRESS.md](PROGRESS.md)。

---

## 6. 盤中資料源強化（PLAN 5，接續四份 PLAN，2026-09-03）

四份 PLAN 上線後盤中掃描能自動跑，但幾個粗糙處：realtime 掃描結果每次一個 `{timestamp}.json` 累積成垃圾（一週 ~50 個）；`fetchMisBatch` 一批 fetch 失敗就整批放棄（開盤前 / 睡眠喚醒時常整批掛，`failedCount` 120 的倍數）；進頁沒有「掃描明顯缺失就重抓」的機制。**PLAN 5 已完成（2026-09-03）：**

- [x] **盤中 realtime 掃描改「單一檔覆蓋」**：`{YYYY-MM-DD}-intraday.json` 每 30 分原子覆蓋（`writeResult` 先寫 `.tmp` 再 `renameSync`），取代累積的 `{timestamp}.json`。`readLatestRealtimeFile()`（`signal-scan.ts`）與 `readLatestScan({ preferRealtime })`（`latest-scan.ts`，新增 `todayIso` 參數由 `data-context` 傳 `t.iso`）都改讀固定檔名，不再 `readdir + sort`。跨日殘留防呆：讀不到「今日」的就當沒有 → 走 `stale`，不 fallback 讀昨天的 `-intraday`。**不跟盤後的 `{YYYY-MM-DD}.json` 合併**——語意衝突（盤後定案 vs 即時估價）、`getScreeningResult` 的「有 `{date}.json` 就不重算」快取機制會誤讀、`data-context` 判 `intraday` 靠 `source === "realtime"` 分不出。兩檔名各自單一、各自覆蓋。舊 `{timestamp}.json` 是死檔（gitignored），要清另開小工作。
- [x] **進頁 fallback：DB → intraday JSON →（明顯缺失）主動重抓**：`getScreeningResult()` 的 realtime 分支——讀 `{date}-intraday.json`，若 `failedCount / totalStocks > 0.10`（缺超過 10%）→ 判定明顯缺失 → **直接同步 `runSignalScan(realtime)` 重跑並覆蓋**（方案 A：卡 UI ~30 秒；`getScreeningContext()` 新增 `willRefetch` 讓進頁 loading 文案準確顯示「盤中資料不完整，正在重新抓取…（約 20–30 秒）」，不給跳過）。**用 `failedCount` 佔比判定，不用 `estimatedCount`**（缺 `z` 用 `high` 代入是 MIS 常態、每份都 1600+ 檔，拿來當觸發條件會每次進頁都重跑）。launchd 加重試後這個 fallback 觸發機率很低。**方案 C（背景 spawn + 前端輪詢）排除**——等於把 PLAN 4 剛清掉的背景任務 + `progress.json` 輪詢 + 「昨」badge 那套請回來，投報率不值。
- [x] **`fetchMisBatch` 加重試**：`scripts/lib/mis-quotes.ts`，`catch` / `!res.ok` 分支 `sleep(2000)` 後重試（`BATCH_RETRIES=2` 總嘗試 2 次、`BATCH_RETRY_DELAY_MS=2000`）。開盤前 / 睡眠喚醒的整批失敗多半重試一次就過。`intraday-scan.ts` 與手動盤中掃描共用這支，一起受益。最壞情況（16 批全失敗）多 ~32 秒，正常（1–2 批偶爾失敗）多 2–4 秒。
- [x] **`com.piercelin.intradayscan.plist` 觸發時段改 10:00–13:30**（原 09:00–13:30）：開盤第一個小時 MIS 常不穩、量能估計不準。已改 8 個觸發點（整點 + 半點）、已 `launchctl reload` 部署（2026-09-03）。

## 7. 三階段命名統一 + 觀察股手動分類（PLAN 6，2026-09-03）

現在 `/watchlist` 的階段 tab 是 `consecutiveAboveBand()` 即時自動判定分的；且全專案三階段用兩套詞（程式碼 `pre-breakout` / `breakout-day` / `extended`，UI 中文「醞釀中 / 首次突破 / 延續爆發」，`WatchlistItem.source` 又是第三套 `breakout` / `accumulation` / `manual`），很亂。**一份 PLAN 一次做完（命名統一 + 廢 source + 手動分類），但 commit 分兩個（先重構、再功能，出問題好回溯）。方向全部定案：**

### 7.1 命名統一（純重構）

- [x] **全專案 `SignalStage` 值統一**：`pre-breakout` → `setup`、`breakout-day` → `breakoutDay`、`extended` 不變。（`breakoutDay` 而非 `breakout`——避免跟即將廢除的 `source` 值 `"breakout"` 混淆、且保留「首次 vs 延續」語意。）Prisma `enum SignalStage { setup breakoutDay extended }`。動的檔（grep 替換）：`scripts/lib/signal-factors/staging.ts`（只有註解）、`scripts/screening/run-signal-scan.ts`（型別 + 階段判定 + **JSON 輸出 `stage` 欄位值**）、`lib/actions/signal-scan.ts`（re-export，無需改 code）、`lib/actions/watchlist.ts`（自己那份 union 刪掉改 `import type` from signal-scan）、`components/signal/labels.ts`（`STAGE_LABELS` / `STAGE_PILL_CLASS` / `STAGE_ORDER` key）、`components/signal/FactorList.tsx`、`components/screening/ScreeningPanel.tsx`、`components/screening/SignalDetail.tsx`、`components/watchlist/WatchlistCard.tsx`、`components/watchlist/WatchlistGallery.tsx`、`lib/latest-scan.ts`。
- [x] **改完立刻重跑掃描覆蓋舊 JSON**：`data/signal-scan-results/*.json` 裡 `stage: "pre-breakout"` 會過時 → 前端讀進來對不上 `STAGE_LABELS["setup"]`。改完在 `main` 手動跑一次 `pnpm tsx scripts/screening/run-signal-scan.ts --source=eod` 覆蓋 `{date}.json`；realtime 檔等下次 launchd 自動覆蓋（或手動跑 `--source=realtime`）。舊 `{timestamp}.json` gitignored、無所謂。**不做讀舊值轉換**（YAGNI，掃描 JSON 本來每天重生）。

### 7.2 廢除 `WatchlistItem.source`

- [x] `source` 目前**只有寫入、無任何讀取**（`WatchlistCard` / `WatchlistGallery` / `scripts/` 全不讀，純死欄位；當初「記錄從哪個策略加入、日後做分析」的意圖從沒實現）。`userStage`（見 7.3）是它的上位替代（三階段之一，比 `breakout`/`accumulation` 二分精確）。**直接移除**：schema 拿掉 `source` + migration、`addToWatchlist` 拿掉 `source` 參數、`ScreeningPanel` 拿掉 `stageToSource()` + 加入時的 `bySource` 分組、`WatchlistCardRow` 拿掉 `source` 欄位。既有 6 筆非空 `source` 值 migration drop column 時自然消失。

### 7.3 `userStage` 手動分類

- [x] **新增 `WatchlistItem.userStage SignalStage?`**（nullable，用 7.1 的 enum）。
- [x] **`addToWatchlist` 加入時算 `autoStage` 寫入**：私有 `computeAutoStages(codes)` helper——逐 code 撈最新 quote + 布林上軌歷史 → `consecutiveAboveBand` → `setup`/`breakoutDay`/`extended`，帶進 `createMany` 的 `userStage`。缺指標的檔 fallback `"setup"`。**只用 DB 資料**（加入動作盤中也不打 MIS）。
- [x] **tab 分類用 `userStage ?? autoStage`**（渲染時 fallback；既有資料 `userStage` null）。
- [x] **卡片因子渲染跟 `stage = userStage ?? autoStage`**：`buildCardRow` 裡 `autoStage` 照算（即時判定），`stage = item.userStage ?? autoStage`，下面渲染分支不動。
- [x] **`WatchlistCardRow` 加 `userStage` + `autoStage` 兩欄**（`source` 欄移除）。
- [x] **手動分類 != 自動評估時的提示**：
  - a. **卡片 chip**：`row.userStage !== row.autoStage` → 卡片標頭加「⚠ 自動判定：{中文}」chip（`STAGE_PILL_CLASS[autoStage]` 色）。
  - b. **tab label 數字**：`首次突破（8 · 2 異動）`——`WatchlistGallery` 的 `countByStage` 改成 `Record<SignalStage, { total, mismatch }>`。
  - **`autoStage` 用當前 mode（eod/intraday/stale）的判定**，接受盤中閃動——盤中衝上上軌 → 異動數 +1，回落 → 復原。
- [x] **卡片加改分類 UI**（3 顆按鈕，當前 `userStage` 高亮）→ `updateWatchlistItem({ code, userStage })` → `revalidatePath("/watchlist")`。`updateWatchlistItem` 加 `userStage?: SignalStage` 參數——**字串值 == Prisma enum 成員名（§1.1 特意），直接傳不需 map**。

**兩個 deferred 項**（不影響上述完成度，等時機再做）：

**兩個 deferred 項**（不影響上述完成度，等時機再做）：

- **盤後選股 v2 參數校準**：首版前 30 名偏大型股（「其他法人集中度」子項對權值股外資穩定流入給高分）。靠肉眼看單日排名 + 實盤觀察調 `signal-factors/accumulation.ts` 的 `CHIP_WEIGHTS` / `READINESS_FLOOR` / `MIN_AVG_VOLUME_SHARES`。同理 `run-signal-scan.ts` 的階段權重 / 法人因子曲線 / `margin-chasing` 觸發點（`surgePercentileThreshold` 等）也待累積資料後校準（約 2026-11）。
- **融資融券歷史回補到 2020**：目前只回補約 45 個交易日。要補全 6 年需另寫 `scripts/backfill/backfill-margin-trading.ts`（FinMind `TaiwanStockMarginPurchaseShortSale` 逐支）。

---

## 5. 盤中提醒

定期檢查觀察股，依「是否已買入」決定提醒時機，出現大跌大漲或不確定訊號時推播。依賴觀察清單有內容、也依賴資料庫能被 GitHub Actions 連到。細節等實際盯盤有手感後再細訂。

### 5.1 基礎建設

- [ ] **資料庫外部連線**：目前是本機 Postgres（`localhost:5432`），GitHub Actions 連不到。決定：(a) 搬到雲端 Postgres（Supabase/Neon/RDS），或 (b) 開本機 Postgres 的外部連線（動態 IP / 安全性顧慮較多）。這決定整個盤中提醒的排程方式走不走得通
- [ ] **通知管道定案**：傾向 Telegram（設定最快、免費無額度限制、手機即時推播），Discord/Email 為備選。實作發送模組（目前 repo 零通知程式碼與依賴）
- [ ] **排程方式定案**：
  - launchd / 本地伺服器：依賴本機在跑，跟「人不在電腦前也要收到」對不上
  - GitHub Actions cron：不依賴本機，方向較對，但需 5.1 的資料庫外部連線先解決；cron 最小 5 分鐘、不保證準點

### 5.2 提醒邏輯

- [ ] 盤中即時報價來源：沿用 `scripts/lib/mis-quotes.ts`（`run-signal-scan.ts` realtime 路徑在用）的 `mis.twse.com.tw` 端點（社群逆向工程、非官方）
- [ ] 對觀察清單逐檔判斷：
  - 未買入：出現「第一根突破」訊號 / 接近設定的目標買價 → 提醒「可考慮進場」
  - 已買入：跌破停損價 / 觸及停利價 / 單日大跌 → 提醒「注意風險」
- [ ] 定義「大跌大漲或不確定訊號」的具體判斷邏輯（門檻、用哪些指標）——等實際盯盤有手感再定
- [ ] 提醒去重（同一檔同一訊號一天只提醒一次）
