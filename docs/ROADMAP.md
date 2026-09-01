# Roadmap

近期要做的事、順序、跟為什麼這樣排。跟 `PLAN.md`（單一任務的實作規格書，做完即被下一份取代）不同，這份是持續累積更新的「目前打算怎麼走」。

## 已完成（2026-08 ~ 2026-09）

盤後選股 v2、前端 scaffolding（Next.js + Prisma）、選股 → 挑股 → 觀察清單流程、籌碼面 / 大盤濾網強化（大盤燈號 4.5.1 / 融資融券資料層 4.5.2 / 選股引擎統一 4.5.3 / 舊三支退役 4.5.4）皆已完成。**歷史回測系統**做到「訓練/驗證切分 + 完整 UI」後因效能問題（進儀表板 OOM）於 2026-08-31 放棄，程式碼凍結在 `feat/backtest-ui-3.6-3.7` 分支，不再撿回。

**資料源統一 + 盤中即時性（四份 PLAN，2026-09-01）**：PLAN 1（daily-pipeline 冷進程穩定性——TPEx 非致命 + 冷連線預熱 + retry:5 + `.ok` 補跑標記）、PLAN 2（資料脈絡判斷收斂到 `lib/data-context.ts` 的 `resolveDataContext()` 單一 helper + `lib/latest-scan.ts` 掃描結果唯一讀取入口 + `run-signal-scan.ts` watchlist 成員豁免 gate → 6226 PR / 醞釀籌碼空白已解）、PLAN 3（`scripts/pipeline/intraday-scan.ts` + launchd 每 30 分盤中自動掃描、`/screening` 頁每 60 秒自動刷新、`/watchlist` 頁改讀掃描 JSON 三分支、進頁不再打 MIS；醞釀中卡片移除 K棒/力道/位階三分數）、PLAN 4（`/screening` 頁簡化——移除盤後/盤中 toggle + realtime 背景任務 spawn + 每 60 秒自動刷新，`_run-signal-scan.ts` 刪除；進頁一律 `getScreeningContext()` → `getScreeningResult()` 依 `resolveDataContext().mode` 回結果，讀一次就定住、要看新的手動重整——跟 watchlist 心智模型一致；「昨」badge 事故徹底解決）皆已完成並部署 launchd。**與下方第 5 節「盤中提醒」不同**——那是「人不在電腦前也收到推播」（依賴雲端 DB + GitHub Actions），這三份只做「伺服器開著時盤中資料即時、頁面資料源判斷統一」。

逐次的設計理由、實測數字、驗證過程全部記在 [docs/PROGRESS.md](PROGRESS.md)。

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
