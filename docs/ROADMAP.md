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
歷史回測系統  ❌ 不做（2026-08-31 決定放棄，見第 3 節）
      │
      ▼
選股 → 挑股 → 觀察清單流程（日常操作殼）  ──✓ 已完成
      │
      ▼
籌碼面 / 大盤濾網強化（第 4.5 節）  ◄── 現在做這個
      │
      ▼
盤中提醒
  └─ 依賴：觀察清單存在 + 資料庫可從外部連線
```

原實作順序是 **scaffolding → 回測系統 → 日常選股/觀察清單流程 → 盤中提醒**。回測系統做到「訓練/驗證切分 + 完整 UI」後因效能問題（進儀表板 OOM）擱置，**2026-08-31 決定不再撿回**（見第 3 節）。現在做第 4.5 節「籌碼面 / 大盤濾網強化」（大盤燈號、融資融券資料層、選股引擎統一），再進第 5 節盤中提醒。盤中提醒依賴觀察清單有內容、也依賴資料庫能被 GitHub Actions 連到。

---

## 1. 盤後選股 v2（投信吃貨訊號）— ✅ 程式碼完成，待參數校準

找「還沒出現第一根突破，但籌碼/技術面有醞釀跡象」的股票，跟 `calculate-breakout-strength.ts`（找已發生的突破事件）互補。

- [x] 四因子 + 乘法計分結構：`最終分數 = 籌碼分數(投信動能 ×0.7 + 排除投信的外資/自營商集中度 ×0.3) × 技術就緒係數(布林壓縮度/窒息量合成，下限 0.5)`。實作於 `scripts/calculate-accumulation-score.ts` + `scripts/accumulation-shared.ts`，輸出 `data/accumulation-score-results/{date}.json`。設計細節見 `docs/PROGRESS.md`（2026-08-27 段落）。
- [ ] **參數校準**：首版前 30 名偏大型股（「其他法人集中度」子項對權值股外資穩定流入給高分所致）。需肉眼看實際排名，調整 `accumulation-shared.ts` 的 `CHIP_WEIGHTS` / `READINESS_FLOOR` / `MIN_AVG_VOLUME_SHARES` 等常數。原打算「併入回測一起做」，但回測系統已放棄（第 3 節）——改用肉眼看單日排名 + 實盤觀察調整。`calculateAccumulationScore(date, { config })` 可傳覆蓋 config 跑一次比對排名，不必改常數。

## 2. 前端 scaffolding（Next.js + Prisma）

回測 UI 與後續日常操作介面共用的殼。這階段只搭骨架、不做業務頁面。

- [x] 在既有 repo 內建 Next.js（App Router）。決定放 repo 根目錄 `app/`（不開 `web/` 子目錄、不做 monorepo），與 `scripts/` 共用 `generated/prisma` client。Next 16.3.3 + Turbopack + TS 7 + ESM 直接可跑，無需降版或 `--webpack`
- [x] **Next.js + Prisma 單例**：`lib/prisma.ts` 用 `globalThis` 快取 `PrismaClient`（保留 `PrismaPg` driver adapter 寫法），檔頭 `import "server-only"` 當誤 import 護欄。hot reload 多次不會讓連線數持續增長
- [x] 不另建 REST/GraphQL API，一律用 **Server Actions**（`lib/actions/*.ts`）。已有 `getDbHealth()` 示範讀真實 DB 數字上首頁
- [x] 圖表庫定案 **Recharts**（`components/ChartSmoke.tsx` smoke 圖）、版面/導覽 = Tailwind CSS v4 + 手刻 `components/ui/` + `app/layout.tsx` 側邊欄
- [x] 背景任務機制定案：**獨立 Node 子進程（`spawn` tsx cli.mjs 絕對路徑）+ 進度寫檔 + Server Action 輪詢**。PoC（`scripts/_poc/` + `lib/actions/poc.ts` + `components/PocRunner.tsx`）已於回測系列第一份 PLAN（3.1 腳本參數化）開始時刪除；模式記錄在 CLAUDE.md「背景任務」段，真的 Layer 0 runner 待 3.3

## 3. 歷史回測系統 — ❌ 不做（2026-08-31 放棄）

> **決定**：不再開發、也不撿回歷史回測系統。2026-08-30 曾因效能問題擱置，2026-08-31 決定直接放棄這條路。
>
> **曾做到的程度**（保留在 `feat/backtest-ui-3.6-3.7` 分支，`main` 上已無）：四層資料流（Layer 0 全市場原始因子落地 JSONL、Layer 0.5 forward-returns cache、Layer 1/2 記憶體重算、Layer 3 統計純函式）、腳本參數化（兩支選股純函式吃可覆蓋 config）、訓練/驗證期切分、完整回測 UI（滑桿即時重算 / Recharts 圖表 / 個股檢視 / 版本比較）。實作細節見 `docs/PROGRESS.md`（2026-08-28～08-30 段落）。
>
> **放棄原因**：詳細頁 `runBacktestSummary` 把整個 run 的 `raw-factors/*.jsonl` 一次 `JSON.parse` 進記憶體，即使「一年 breakout」也讓 Next dev server heap OOM（8 GB）。要修得把 Layer 0 讀取整個改成逐日串流。評估後認為投入產出比不划算——參數校準改用「肉眼看單日排名 + 實盤觀察」的低成本方式進行。
>
> **殘留物**：`scripts/lib/breakout-shared.ts` / `accumulation-shared.ts` 的 config 三件組（`XxxConfig` / `DEFAULT_XXX_CONFIG` / `resolveXxxConfig`）與 `fetchXxxRawInputs` helper 是回測前置抽出的，選股腳本正式跑不用但留著無害，也讓「用 config 覆蓋參數跑一次看排名」這種輕量校準仍可行。`scripts/lib/types.ts` 的 `DeepPartial` 同理保留。

## 4. 選股 → 挑股 → 觀察清單流程（日常操作殼）

日常實際會用的介面：手動觸發選股 → 挑合適的股 → 加入觀察清單（含買入狀態）。

### 4.1 選股 → 挑股

- [x] 選股頁：按鈕觸發（Server Action 同步在 Next.js 進程內直接 import 呼叫 `calculateAccumulationScore(date)` / `calculateBreakoutStrength(date)`，跑最新交易日）→ 表格呈現候選股（可依因子分數/欄位排序）→ 點單檔看完整評分明細
- [x] 兩種策略分頁：「第一根突破」（breakout-strength）與「冷水區醞釀」（accumulation）
- [x] 從候選股表格勾選 → 一鍵加入觀察清單

### 4.2 觀察清單升級

- [x] `WatchlistItem` schema 加欄位：`isPurchased Boolean @default(false)`、`buyPrice Decimal?`、`buyDate DateTime?`、`targetPrice Decimal?`、`stopLossPrice Decimal?`（+ 額外加 `source String?` 記錄從哪個策略加入；直接加在 `WatchlistItem`，不另建 model）
- [x] migration + 既有資料相容（`20260830085717_add_watchlist_purchase_fields`，SQL 只有 `ADD COLUMN`，全 nullable / `@default`）
- [x] 觀察清單頁：列出清單、可切換買入狀態、填買入價 / 買入日 / 目標價 / 停損價、加備註、移除
- [x] 每檔顯示當日報價 + 關鍵技術/籌碼欄位（讀 `DailyQuote` / `TechnicalIndicator` / `InstitutionalTrading` 最新一筆）

> Note：「尾盤 LLM 分析（依買入狀態判斷該買/該賣）」暫不排進 ROADMAP，等 UI 與回測穩定後再評估要不要做、怎麼做。

> Note：盤中即時掃描的**手動觸發 UI**（背景任務模式：`ScreeningPanel` 第三個 tab → `startIntradayScan` spawn `_run-intraday-scan.ts` → 輪詢 `progress.json`）已於 2026-08-30 併入 `/screening`。這是 ROADMAP 沒明列的加項；第 5 節的「排程 + 通知管道」仍未做。

> Note：2026-08-31 整站切成**固定黑暗模式**（無 light/dark toggle），並重寫 `/` Dashboard：DB 連通性卡改成「資料狀態」卡（今日行情燈號＝DB 最新交易日 vs Asia/Taipei 今日 / 一般股票檔數 / 當日三表覆蓋率），移除 Recharts smoke，新增「觀察類股今日表現」表（對 watchlist 每檔用 `breakout-shared.ts` 的 `computeCandleShape`/`computeVolumeStrength`/`computeBase` 現算 K棒/力道/位階 + 當日動能/籌碼）。ROADMAP 沒明列的加項。

## 4.5 籌碼面 / 大盤濾網強化

選股殼跑起來後的下一輪：加「市場狀態」判斷、把融資融券資料補進來、把三支選股路線收斂。三個子項彼此獨立，可分開做。

### 4.5.1 大盤濾網（市場狀態燈號）— 有 PLAN.md

獨立於「三層選股漏斗」之外的市場狀態模組。**不參與個股評分、不做硬性 gate**（會篩掉整個候選池，跟「篩個股」是不同層級的事），只輸出一個 `bullish` / `neutral` / `bearish` 三段標籤，顯示在首頁 banner + `/screening` 頁頂，供人工在「要不要進場」「部位大小」上判斷。空頭時照跑選股（資料照存），只是醒目警示 + 建議降低單筆風險預算。

- [x] **TAIEX 日線落地**：`Stock` 表沒有大盤指數行情。用 FinMind `TaiwanStockPrice` 抓 `TAIEX`（比照 `backfill-benchmark-quotes.ts` 抓 0050 的模式），寫進 `DailyQuote`（`stockCode = "TAIEX"`）。`SecurityType` enum 加 `index` 值（`ALTER TYPE ... ADD VALUE`，不動任何現有 row）。複用 `calculate-technical-indicators.ts` 算 TAIEX 的 MA60 / 帶寬（`backfill-index-quotes.ts`，1618 筆；`calculate-technical-indicators.ts` 的 `where` 改 `OR: [{ securityType: "stock" }, { code: "TAIEX" }]`）
- [x] **三維度合成三段式**（每維度投 `+1 / 0 / -1`，加總 → 多頭 `+2~+3` / 中性 `-1~+1` / 空頭 `-2~-3`）：
  - **指數位置**：TAIEX 收盤 vs MA60，加「連續 3 交易日」緩衝過濾單日假跌破 whipsaw
  - **均線斜率**：TAIEX MA60 近 5 日是否上彎（只看價格穿越會被假跌破騙）
  - **市場寬度**：全市場「收盤 > 各自 MA60」的股票佔比（指數會被權值股扭曲，寬度看整體）；>55% 偏多 / 45~55% 中性 / <45% 偏空
- [x] **分兩階段實作**（同一份 PLAN）：Step 1 先只做「市場寬度」單維度（零新資料，`DailyQuote` + `TechnicalIndicator` 現成）三段式上線；Step 2 TAIEX 落地後補「指數位置 + 均線斜率」兩維度，變成三票合成（皆已完成，`stage` 由 `hasTaiexIndicatorForDate()` 自動判定）
- [x] **不落地 DB**：regime 結果寫 `data/market-regime/{date}.json`（盤後 pipeline 算的定案，一天一檔覆蓋）；盤中重複跑寫 `data/market-regime/intraday/{timestamp}.json`（比照 `intraday-breakout-snapshots`，允許一天多筆）。理由：資訊量小（整個市場每天一個標籤）、盤中會多次取、不做回測不需要歷史查詢 → 建表不划算（Step 1：`{date}.json` 已上線；盤中版留待 4.5.3）
- [x] **進 pipeline**：`daily-pipeline.ts` 新增步驟（算完技術指標後，需要 TAIEX 的 MA60）。非關鍵路徑，失敗印警告不讓 pipeline 非 0 結束（第 5 步，`calculate-market-regime.ts`）
- [x] **前端**：首頁 banner 顯示當前 regime + 三段對應的部位建議文字；`/screening` 頁頂燈號（`RegimeBanner`，`variant="banner"` / `"strip"`）

### 4.5.2 融資融券資料層

證交所 / 櫃買每日公開的個股信用交易餘額。初版只補資料 + 進 pipeline + 顯示覆蓋率，評分整合留後。

- [x] **新 `MarginTrading` model**（`stockCode + date` 唯一）：`marginBalance` / `marginBalancePrev` / `marginQuota?` / `shortBalance` / `shortBalancePrev` / `offsetting?` / `source` / `fetchedAt`。**單位一律存「股」**（原始資料源以「張」計，入庫 ×1000），schema 註解標明。`marginBalancePrev` 直接取 API 回應的「前日餘額」欄，不自己 join
- [x] **`scripts/pipeline/fill-margin-trading.ts`**：TWSE `MI_MARGN`（`?response=json&date=YYYYMMDD&selectType=ALL`，個股明細在 `tables[1]`，支援任意歷史日期）+ TPEx `www.tpex.org.tw/www/zh-tw/margin/balance`（`?date=YYYY/MM/DD&id=&response=json`，`tables[0]`，亦支援歷史日期）。走 `lib/http.ts` 的 `fetchJson`。套 CLAUDE.md 過濾規則只留一般股票 + 特別股，只 upsert 已存在的 Stock。匯出 `fillOneDayMargin(date)`。CLI `--date=YYYY-MM-DD`（不帶抓今天）/ `--backfill=N`（往回抓 N+約 4 個日曆日、跳非交易日，實得約 N 個交易日）
- [x] **首次回補**：補今天 + 往回約 10 個交易日
- [x] **進 pipeline**：`daily-pipeline.ts` 新增步驟（估值之後）。非關鍵路徑：TWSE+TPEx 都拿不到當日資料時印警告，不讓 pipeline 非 0 結束（融資融券證交所通常傍晚才出）
- [x] **前端覆蓋率**：擴充 `lib/actions/health.ts` 的 `DbHealth.coverage` 加 `margin`（最新交易日有 `MarginTrading` 的股票數 ÷ `stockCount`）。首頁「資料狀態」卡「當日三表覆蓋率」→「當日四表覆蓋率」。實測覆蓋率 95.2%（非全部股票有信用交易資格，正常）
- [ ] 歷史回補到 2020（另寫 `scripts/backfill/backfill-margin-trading.ts`，FinMind `TaiwanStockMarginPurchaseShortSale` 逐支）**不在此輪範圍**

### 4.5.x 體驗改善（使用者臨時加項，非原 todo）

- [x] **技術指標 pipeline 提速**：`calculateTechnicalIndicators` 加 `mode: "full" | "latest"`，`daily-pipeline.ts` 第 4 步改 `"latest"`（每支只撈最近 250 筆、只 upsert 最新一天）→ 整支 pipeline 從 ~10 分鐘降到 ~21 秒。CLI 仍 `"full"`（全歷史）。代價：pipeline 漏跑那天的指標需手動 `calculate-technical-indicators.ts <code>` 補
- [x] **首頁「立即更新資料」按鈕**：`lib/actions/pipeline.ts` + `components/dashboard/PipelineRunner.tsx` — spawn 未改造的 `daily-pipeline.ts` 當背景子進程、粗粒度進度（存活秒數 + log 尾）、可離開頁面切回接管、`progress.json` 單檔鎖、完成後 `window.location.reload()` 刷新覆蓋率

### 4.5.3 選股引擎統一（三路線收斂）

現在 `/screening` 有三個分頁：「第一根突破」（盤後）、「冷水區醞釀」（accumulation）、「盤中即時掃描」。想收斂成更少入口。分兩層，A 可先做、B 較大。

- [ ] **路線 A：盤中 / 盤後突破合併（資料源自動切換）** — 把「盤後突破」和「盤中即時掃描」兩個分頁合成一支。程式開頭查「DB 有今天的 `DailyQuote` 嗎」→ 有就用盤後 DB 資料、沒有就打 `mis.twse.com.tw` 即時 API。兩者評分邏輯本來就 100% 共用（都吃 `breakout-shared.ts`），所以只是「合併殼 + 加資料源判斷 + 產出標記行情來源（即時 / 盤後定案）」。**不依賴回測，可先做**
- [ ] **路線 B：單一評分管線 + 階段標籤** — 突破 + 醞釀共用一組因子庫（把散在 `breakout-shared.ts` / `accumulation-shared.ts` 兩邊的評分函式合進 `signal-factors.ts`），跑全市場算完整因子分，再依 `firstBar` 狀態打階段標籤：`pre-breakout`（還沒站上布林上軌、醞釀中）/ `breakout-day`（今天第一根）/ `extended`（突破已走多日）。同一份因子分，不同階段套不同權重組合排名。前端整併為單頁 + 標籤 filter
  - **階段權重靠肉眼校準 / 實盤觀察**（不做回測）
  - **候選池互斥要處理**：accumulation 現在排除「已站上布林上軌」、breakout 要求「站上」，兩者候選池天然互斥；統一管線改為「都算、用階段標籤分」，互斥規則變成標籤邏輯
  - **盤中版籌碼**：三大法人 / 融資融券都是盤後才公布，盤中拿不到「當日」。盤中版籌碼因子讀「到 T-1 為止的回看窗」（例：投信近 5 日買超讀到昨天），「突破當日法人是否淨買超」這種當日子項盤中降級給中性分（沿用現有 `degraded` 機制）
- [ ] **三大法人評分分項**（併入路線 B 的因子庫，或先單獨加進 breakout 第三層當第 8 分項）：`computeInstitutionalFlow()` — 投信近 5 日淨買超 + 外資近 5 日淨買超，各自 ÷ `volumeMa20` 標準化後線性 clip 0~100，權重投信 > 外資（30 億市值門檻區間投信訊號較乾淨）。突破當日法人淨賣超 → 分數封頂（類似 `computeCandleShape` 收黑封頂）。資料層**不用改**，`InstitutionalTrading` 的 `*NetBuy` 淨額欄位已足夠。加第 8 分項要從現有 7 項權重勻出來（`WEIGHTS` 總和維持 1）
  - **融資融券當修正因子**（等 4.5.2 資料累積 1~2 個月後）：突破當天法人淨賣超 + 融資餘額暴增（散戶追、法人跑）→ `computeInstitutionalFlow` 分數額外封頂 + 標記 `margin-chasing` 警示。初版併進法人分項，不獨立成第 9 分項

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
