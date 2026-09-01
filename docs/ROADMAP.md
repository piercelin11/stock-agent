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

**進度（2026-09-01）**：4.5.1 大盤濾網、4.5.2 融資融券資料層、4.5.3 選股引擎統一（路線 A + B + 三大法人分項 + `margin-chasing` 警示）、**4.5.4 舊三支退役 + `signal-factors/` 目錄化**皆完成。**整個 4.5 節除「等資料再校準 `margin-chasing` 觸發點」+ 4.5.2 的「歷史回補到 2020」（deferred，融資融券已補到約兩個月、暫不做全 6 年）外已全部完成。**

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

現在 `/screening` 有三個分頁：「第一根突破」（盤後）、「冷水區醞釀」（accumulation）、「盤中即時掃描」。想收斂成更少入口。

**決定（2026-08-31）：跳過路線 A，直接做路線 B。** 路線 A 真正「白做」的只有前端那層兩合一殼（B 會再併成單頁 + 階段 filter，改第二次）；資料源自動切換邏輯不算白做——它本來就是 B 的一部分，**把它當 B 的第一步先落地**，不算走回頭路。

- [x] **路線 A：盤中 / 盤後突破合併（資料源自動切換）** — ~~把「盤後突破」和「盤中即時掃描」兩個分頁合成一支~~。**併入路線 B 一起做**：`run-signal-scan.ts` 開頭查「DB 有今天的 `DailyQuote` 嗎」→ 有 → `source: "eod"`（讀 DB）；沒有 → `source: "realtime"`（打 `mis.twse.com.tw`）。`SignalResult.priceSource`（`eod` / `realtime` / `estimated`）標記行情來源
- [x] **路線 B：單一評分管線 + 階段標籤** — `scripts/lib/signal-factors.ts`（統一因子庫，re-export 舊評分函式 + 新增 `computeInstitutionalFlow` / `computeBreakoutMarginMonotone` / `consecutiveAboveBand` helper + `SignalScanConfig`）+ `scripts/screening/run-signal-scan.ts`（單一評分管線）。跑全市場一般股票 → 單一 gate（市值 + 當日量 + 均量）→ 依「連續站上上軌天數」打階段標籤 `pre-breakout` / `breakout-day` / `extended` → 同一份因子分、階段套不同合併方式 → 各階段各自排名 → 落地 `data/signal-scan-results/`。前端 `ScreeningPanel.tsx` 重寫成單頁 + 階段 filter（全部 / 醞釀中 / 今日突破 / 已延伸）；Server Action `lib/actions/signal-scan.ts` 取代 `screening.ts` + `intraday.ts`
  - **統一的範圍界定**：因子庫共用 + 單一候選池 + 資料源自動切換 + 單一前端 → **統一**；「最後一步怎麼把各因子合成一個總分」→ **按階段各自保留，不強制統一**
  - **`pre-breakout` 階段的合併保留乘法結構**（`籌碼分數 × 技術就緒係數`，含下限 0.5 保底），**不改成加權和**。理由：這是「籌碼強 ∧ 技術收斂」的 AND 關係，加權和只能表達「可互相補償的加權投票」；一檔籌碼分數極高、但股價還在亂噴完全沒收斂的股票，加權和會靠籌碼分硬拉出高總分，判成「準備好的醞釀股」——正是乘法 + 保底原本要擋的。「統一因子分」不代表「每個階段都用同一種合併公式」
  - **`breakout-day` / `extended` 階段用加權和**（沿用 `calculate-breakout-strength.ts` 現行的 7 分項加權結構）
  - **階段權重 / 合併參數靠肉眼校準 / 實盤觀察**（不做回測）
  - **候選池互斥要處理**：accumulation 現在排除「已站上布林上軌」、breakout 要求「站上」，兩者候選池天然互斥；統一管線改為「都算、用階段標籤分」，互斥規則變成標籤邏輯
  - **盤中版籌碼**：三大法人 / 融資融券都是盤後才公布，盤中拿不到「當日」。盤中版籌碼因子讀「到 T-1 為止的回看窗」（例：投信近 5 日買超讀到昨天），「突破當日法人是否淨買超」這種當日子項盤中降級給中性分（沿用現有 `degraded` 機制）
  - **盤中價格缺失處理（MIS `z` bug：超過半數個股回應無成交價）**：缺 `z` 時**不剔除、不用中價猜**。
    - `breakoutMargin` / `firstBar` / `proximityToHigh` / `relativeStrength` 四項：**用當日最高價 `h` 代入 close**。`h` 是「有沒有站上上軌 / 距高點多遠 / 期間報酬」這類問題有數學確定性的保守上界，代入只會低估突破強度，方向安全。**分數照常參與加權，不標 degraded**（h 代入的分數是真實有意義的，不是佔位分）。
    - `candleShape`：**走既有 degraded 慣例，給中性 50 分**。這項問的正是「有沒有從高點 `h` 拉回」，用 `h` 代入會強制回答「沒拉回」——不是保守，是編造答案；用中價 `(h+l)/2` 也是無根據的填空。缺 `z` 就套系統本來就有的降級規則，不發明新例外。
    - `volumeStrength`：不受影響（吃 volume 不吃價）。
    - **落地 JSON**：`data/intraday-breakout-snapshots/{timestamp}.json` 每檔加 `priceSource: "realtime" | "estimated"`（有 `z` / 缺 `z`）。前端 `getIntradayResult` 讀到 `estimated` 顯示標記 + 提示「突破判定基於盤中最高價、K棒形態項為佔位分」。盤後版結果無此欄（或固定 `"final"`），前端合併顯示時靠這欄區分即時估計 vs 盤後定案（= 路線 B「標記行情來源」）。`candleShape` 分項的 `degraded` 沿用現有評分明細機制，本來就在檔內。
- [x] **三大法人評分分項**：`computeInstitutionalFlow()`（`scripts/lib/signal-factors.ts`）— 近 5 日投信 + 外資淨買超各自 ÷ `volumeMa20` → clip `[0, clipDivisor]` 線性映射 0~100，投信權重 0.6 > 外資 0.4。突破當日法人淨賣超 → 分數封頂 `sellCapScore`(40)；盤中拿不到當日法人 → 不封頂但標 `degraded`。breakout-day / extended 階段的第 8 分項（從現行 7 項各 ×0.90 勻出 `institutionalFlow: 0.10`，總和維持 1）。首版參數全部拍腦袋、待肉眼校準
  - **正規化先用「÷ `volumeMa20`」的簡單版，不一開始就上歷史百分位**。若實測「前段偏大型股」的偏誤仍明顯（權值股外資穩定流入吃高分，見第 1 節 §1「參數校準」的同一現象），再升級成「每檔對自己歷史淨買超分布取百分位」的版本
  - [x] **融資融券當修正因子 — `margin-chasing` 警示**（PLAN 2026-09-01）：`breakout-day`/`extended` 階段，突破當天三大法人（投信＋外資）淨賣超 **且** 這檔融資餘額近 5 日累積增速排在自己 40 天歷史前 20%（`computeMarginSurgePercentile` 百分位 > 80）→ `SignalResult.warnings` push `"margin-chasing"`。**只標記不動分數**（不疊 `computeInstitutionalFlow` 封頂 / 權重）——標記取代動態調整，跟 `degraded` 哲學一致。`warnings` 與 `degraded` 語意分開（資料充足的風險訊號 vs 資料不足的不確定）。realtime 當日融資餘額拿不到 → 恆不觸發。前端列尾紅「追」badge + 展開紅框提示
    - **待校準觸發點**：累積滿 3 個月融資融券資料後（約 2026-11 起），回頭檢查此因子實際觸發頻率 + 命中準確度，再決定 `surgePercentileThreshold`(80) / `lookbackDays`(5) / `historyWindowDays`(40) 要不要調

### 4.5.4 舊三支退役 + `signal-factors/` 目錄化（收尾，不急）

4.5.3 統一引擎（`run-signal-scan.ts`）上線後，`/screening`、Dashboard、Server Action 都已改吃統一管線。舊三支（`calculate-breakout-strength.ts` / `calculate-accumulation-score.ts` / `check-intraday-breakout.ts`）+ 兩個 shared 檔（`breakout-shared.ts` / `accumulation-shared.ts`）目前**留原地可跑、退役待這一批**。這批把它們正式收掉，並把因子庫從「`signal-factors.ts` 薄 re-export 層 + 兩個 shared 檔本體」整併成 `signal-factors/` 目錄。

**做這批的前提**：(1) 統一引擎跑過幾天、肉眼確認排名穩定；(2) `feat/screening-unified` 已 merge 進 `main`。**確認前不動**（現在動 = 在還有 4 個外部 import 者、舊路徑沒退役時動刀，風險 > 收益）。

**現況盤點（2026-09-01）**：
- `breakout-shared.ts`（662 行）現役 import 者：`signal-factors.ts` + `calculate-breakout-strength.ts` + `calculate-accumulation-score.ts` + `check-intraday-breakout.ts` + **`lib/actions/dashboard.ts`**（唯一前端消費者，拿 `computeCandleShape` / `computeVolumeStrength` / `computeBase` / `resolveBreakoutConfig`）。
- `accumulation-shared.ts`（427 行）現役 import 者：`signal-factors.ts` + `calculate-accumulation-score.ts`。
- `market-regime.ts`、`accumulation-shared.ts` 內文提到 breakout-shared 的地方都只是**註解**，非 import。
- `signal-factors.ts` 已是聚合層：import 兩 shared 檔的評分函式 → re-export；`run-signal-scan.ts` 只認 `signal-factors.ts`。
- 兩 shared 檔各有一份重複的 `clip` / `rankScore`（合併時消除）。

**步驟**（全部完成，2026-09-01，`feat/screening-retire-legacy` 分支）：

- [x] **Step 1 — 補齊因子庫 re-export 面**：`signal-factors/index.ts` barrel `export * from` 各子檔，`dashboard.ts` 需要的 `resolveBreakoutConfig` / `computeCandleShape` / `computeVolumeStrength` / `computeBase` 都在。
- [x] **Step 2 — 所有 import 者改指向 `signal-factors/index`**：`lib/actions/dashboard.ts`（`breakout-shared` → `signal-factors/index`）、`run-signal-scan.ts`（`signal-factors` → `signal-factors/index`）。`tsc --noEmit` + `pnpm build` 綠。
- [x] **Step 3 — 舊三支 + 孤兒 runner 直接刪（改成不進 `archive/`）**：`calculate-breakout-strength.ts` / `calculate-accumulation-score.ts` / `check-intraday-breakout.ts` / `_run-intraday-scan.ts` → `git rm`。**評估後改成直接刪**：本體只是「串 shared 函式 + 寫 JSON」的 CLI 殼，評分邏輯已整併進 `signal-factors/`，設計理由在 `docs/PROGRESS.md`，`git show` 撈得回舊實作 → `archive/` 只會多一份要解釋的死碼。CLAUDE.md「既有腳本」段已更新。
- [x] **Step 4 — 因子庫目錄化**：`scripts/lib/signal-factors/` = `index.ts`（barrel）+ `util.ts`（`clip` / `rankScore` 合併）+ `breakout.ts`（原 `breakout-shared.ts`）+ `accumulation.ts`（原 `accumulation-shared.ts`，`BASE_MIN_HISTORY_DAYS` 改從 `breakout.ts` import 消重）+ `institutional.ts` + `staging.ts` + `config.ts`。舊 `signal-factors.ts` 單檔刪除。
- [x] **Step 5 — 刪 `breakout-shared.ts` / `accumulation-shared.ts`**：`git rm`（內容已搬進 `signal-factors/`、無人 import）。
- [x] **Step 6 — 刪 `data/` 舊輸出資料夾**：`data/breakout-strength-results/` / `accumulation-score-results/` / `intraday-breakout-snapshots/` 已刪，`.gitignore` 三行一併移除（原本就 gitignored、未進版控）。
- [x] **Step 7 — 單測搬遷**：`scripts/lib/signal-factors.test.ts` → `scripts/lib/signal-factors/factors.test.ts`（`git mv`），import 改 `./index`。31 案全綠。
- **未動**（如計畫）：`scripts/lib/mis-quotes.ts` / `market-regime.ts` / `http.ts` / `types.ts`（`market-regime.ts` / `mis-quotes.ts` 的註解提及舊檔名處已順手更新）。
- **驗收（全過）**：`pnpm exec tsc --noEmit` 乾淨；`pnpm build` 綠；`pnpm tsx --test scripts/lib/signal-factors/factors.test.ts` 31/31；`grep -rn "breakout-shared\|accumulation-shared" --include="*.ts"` 只剩 `signal-factors/` 內 4 處註解（歷史敘述），程式碼 0 命中。

## 5. 盤中提醒

定期檢查觀察股，依「是否已買入」決定提醒時機，出現大跌大漲或不確定訊號時推播。細節等第 4 階段做完、實際盯盤有手感後再細訂。

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
