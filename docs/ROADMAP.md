# Roadmap

近期要做的事、順序、跟為什麼這樣排。跟 `PLAN.md`（單一任務的實作規格書，做完即被下一份取代）不同，這份是持續累積更新的「目前打算怎麼走」。

## 已完成（2026-08 ~ 2026-09）

盤後選股 v2、前端 scaffolding（Next.js + Prisma）、選股 → 挑股 → 觀察清單流程、籌碼面 / 大盤濾網強化（大盤燈號 4.5.1 / 融資融券資料層 4.5.2 / 選股引擎統一 4.5.3 / 舊三支退役 4.5.4）皆已完成。**歷史回測系統**做到「訓練/驗證切分 + 完整 UI」後因效能問題（進儀表板 OOM）於 2026-08-31 放棄，程式碼凍結在 `feat/backtest-ui-3.6-3.7` 分支，不再撿回。

**資料源統一 + 盤中即時性（四份 PLAN，2026-09-01）**：PLAN 1（daily-pipeline 冷進程穩定性——TPEx 非致命 + 冷連線預熱 + retry:5 + `.ok` 補跑標記）、PLAN 2（資料脈絡判斷收斂到 `lib/data-context.ts` 的 `resolveDataContext()` 單一 helper + `lib/latest-scan.ts` 掃描結果唯一讀取入口 + `run-signal-scan.ts` watchlist 成員豁免 gate → 6226 PR / 醞釀籌碼空白已解）、PLAN 3（`scripts/pipeline/intraday-scan.ts` + launchd 每 30 分盤中自動掃描、`/screening` 頁每 60 秒自動刷新、`/watchlist` 頁改讀掃描 JSON 三分支、進頁不再打 MIS；醞釀中卡片移除 K棒/力道/位階三分數）、PLAN 4（`/screening` 頁簡化——移除盤後/盤中 toggle + realtime 背景任務 spawn + 每 60 秒自動刷新，`_run-signal-scan.ts` 刪除；進頁一律 `getScreeningContext()` → `getScreeningResult()` 依 `resolveDataContext().mode` 回結果，讀一次就定住、要看新的手動重整——跟 watchlist 心智模型一致；「昨」badge 事故徹底解決）皆已完成並部署 launchd。**與下方第 5 節「盤中提醒」不同**——那是「人不在電腦前也收到推播」（依賴雲端 DB + GitHub Actions），這三份只做「伺服器開著時盤中資料即時、頁面資料源判斷統一」。

逐次的設計理由、實測數字、驗證過程全部記在 [docs/PROGRESS.md](PROGRESS.md)。

---

## 6. 盤中資料源強化（PLAN 5，接續四份 PLAN，2026-09-03）

四份 PLAN 上線後盤中掃描能自動跑，但幾個粗糙處：realtime 掃描結果每次一個 `{timestamp}.json` 累積成垃圾（一週 ~50 個）；`fetchMisBatch` 一批 fetch 失敗就整批放棄（開盤前 / 睡眠喚醒時常整批掛，`failedCount` 120 的倍數）；進頁沒有「掃描明顯缺失就重抓」的機制。**已定案，待開 PLAN：**

- [ ] **盤中 realtime 掃描改「單一檔覆蓋」**：`{YYYY-MM-DD}-intraday.json` 每 30 分原子覆蓋（先寫 `.tmp` 再 rename），取代累積的 `{timestamp}.json`。`readLatestRealtimeFile()` 改讀固定檔名，不再 `readdir + sort`。**不跟盤後的 `{YYYY-MM-DD}.json` 合併**——語意衝突（盤後定案 vs 即時估價）、`getScreeningResult` 的「有 `{date}.json` 就不重算」快取機制會誤讀、`data-context` 判 `intraday` 靠 `source === "realtime"` 分不出。兩檔名各自單一、各自覆蓋。
- [ ] **進頁 fallback：DB → intraday JSON →（明顯缺失）主動重抓**：`getScreeningResult()` 的 realtime 分支——讀 `{date}-intraday.json`，若 `failedCount / totalStocks > 0.10`（缺超過 10%）→ 判定明顯缺失 → **直接同步 `runSignalScan(realtime)` 重跑並覆蓋**（方案 A：卡 UI ~30 秒 + loading 文案「盤中資料不完整，正在重新抓取全市場報價…（約 30 秒）」，不給跳過）。**用 `failedCount` 佔比判定，不用 `estimatedCount`**（缺 `z` 用 `high` 代入是 MIS 常態、每份都 1600+ 檔，拿來當觸發條件會每次進頁都重跑）。launchd 加重試後這個 fallback 觸發機率很低。**方案 C（背景 spawn + 前端輪詢）排除**——等於把 PLAN 4 剛清掉的背景任務 + `progress.json` 輪詢 + 「昨」badge 那套請回來，投報率不值。
- [ ] **`fetchMisBatch` 加重試**：`scripts/lib/mis-quotes.ts`，`catch` / `!res.ok` 分支 `sleep(2000)` 重試 1–2 次。開盤前 / 睡眠喚醒的整批失敗多半重試一次就過。`intraday-scan.ts` 與手動盤中掃描共用這支，一起受益。
- [x] **`com.piercelin.intradayscan.plist` 觸發時段改 10:00–13:30**（原 09:00–13:30）：開盤第一個小時 MIS 常不穩、量能估計不準。已改 8 個觸發點（整點 + 半點）、已 `launchctl reload` 部署（2026-09-03）。

## 7. 觀察股手動分類（PLAN 6，2026-09-03）

現在 `/watchlist` 的階段 tab（醞釀中 / 首次突破 / 延續爆發）是 `consecutiveAboveBand()` 即時自動判定分的。改成「使用者手動指定分類」，但**保留自動評估拿來比對**。**方向定案，細節待開 PLAN：**

- [ ] **新增 `WatchlistItem.userStage`**（Prisma `enum SignalStage { preBreakout, breakoutDay, extended }`，nullable）。**`source` 欄位不動**——它的語意是「當初從哪個策略加入」（`"breakout"` / `"accumulation"` / `"manual"`，歷史遺留、跟 `SignalStage` 詞彙不同），不是「現在的階段分類」，塞進去語意錯亂。Prisma enum 值不能有 `-`，用 camelCase（`preBreakout` 等），在 action 邊界跟字串型 `SignalStage`（`"pre-breakout"`…）做一次 map 轉換。
- [ ] **tab 分類改用 `userStage`**：`userStage != null` → 用它；`null`（尚未指定）→ fallback 用 `autoStage`（即時判定，現況邏輯，資料源同樣 eod/intraday/stale 三分支）。
- [ ] **`autoStage` 仍每檔即時算**，但只拿來比對——不分 tab。`WatchlistCardRow` 多帶 `userStage` + `autoStage` 兩欄。
- [ ] **手動分類 != 自動評估時的提示**：
  - a. **卡片 chip**：卡片上加「自動判定：{X}」chip（用 `STAGE_PILL_CLASS` 那組色 + ⚠ 或箭頭），讓使用者知道「你放在醞釀中，系統覺得它已進延續爆發」。
  - b. **tab label 數字**：`首次突破（8 · 2 異動）`——`2 異動` = 這 tab 裡 `autoStage` 跟 tab 不符的檔數。`WatchlistGallery` 的 `countByStage` 改成同時算「該 tab 檔數」與「不一致檔數」。
- [ ] **卡片加改分類 UI**（stage 下拉 / 三顆按鈕）→ `updateWatchlistItem({ code, userStage })` → `revalidatePath("/watchlist")`。`updateWatchlistItem` action 早已存在（買入狀態 UI 移除後保留著），加 `userStage` 參數即可。

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
