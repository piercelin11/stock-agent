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
  ├─ Layer 0 基準跑（全市場原始因子落地 JSONL）
  ├─ 記憶體重算（套門檻 → rankScore → 加權 → 統計）+ 訓練/驗證期切分
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

**這階段不使用資料庫存回測結果。** 現在的目的是反覆調加權參數、快速看訊號有沒有預測力，是實驗性高頻迭代，不是多人協作的正式紀錄。把這種用完即丟的資料放進 Prisma schema 會增加 migration / index 維護成本卻沒有對應效益。改用檔案系統（JSON / JSONL）。DB 化留到「參數收斂、要長期自動化監控」的更後期再評估，不在這次規劃範圍。

### 3.0 核心架構：四層資料流

把「抓資料」跟「合成分數」拆開，讓調參數的重跑幾乎即時。這是整個回測系統的骨幹。

```
Layer 0    全市場原始因子（慢，只在換時間範圍時重跑）        → 落地 JSONL
Layer 0.5  未來 N 日報酬 cache（全域，跨策略共用）           → 落地 JSONL
Layer 1    套門檻參數篩候選池（記憶體，即時）
Layer 2    分項函式 → 重算 rankScore → 加權排名（記憶體，即時）
Layer 3    接 Layer 0.5 算命中率 / 報酬分布 / 穩定性（記憶體，即時）
```

**為什麼 Layer 0 必須存全市場、不能只存候選池：**
兩支選股腳本各有一組**硬性門檻**（breakout 的 `GATES` / `TRIGGER_VOLUME_RATIO`、accumulation 的 `MIN_AVG_VOLUME_SHARES` 與「站上布林上軌排除」），這些門檻是可調參數，決定哪些股票進候選池。若 Layer 0 只存「當時通過門檻的股票」，之後調寬門檻就無法還原「原本沒過、調寬後應該要進來」的股票。所以 Layer 0 存全市場每一檔。

**accumulation 的門檻和 breakout 同性質，且更麻煩（rankScore 穿透問題）：**
- `MIN_AVG_VOLUME_SHARES`（近 20 日均量下限，`accumulation-shared.ts` 匯出的常數，3.1 列為可覆蓋 config）→ 與 breakout 的 `GATES` 完全同性質，必須存全市場的 `volumeMa20` 才能事後重篩。
- 「站上布林上軌排除」（`close > bollingerUpper`）→ 這條不是可調參數，是與 breakout 清單互斥的結構規則，不因調參而變；但為了讓 Layer 0 資料完整、也讓「若之後想放寬互斥規則」有還原空間，仍存全市場、在 Layer 1 才套。
- **rankScore 穿透**：accumulation 的四個分項（投信頻率 / 投信淨買比 / 其他法人集中度 / 窒息量）和 breakout 的 `relativeStrength`，都是**跨候選池的百分位排名**（`rankScore`）。候選池成員一變（調 `MIN_AVG_VOLUME_SHARES`），每檔的百分位分數就跟著變。因此 **Layer 2 必須在篩完池之後「重跑一次 rankScore」**，不能沿用 Layer 0 時期算的分數。

### 3.1 腳本參數化（前置）

- [ ] `calculateAccumulationScore(date, config?)` — `config` 可覆蓋 `accumulation-shared.ts` 的所有常數（`CHIP_WEIGHTS` / `TRUST_SUB_WEIGHTS` / `TECH_WEIGHTS` / `READINESS_FLOOR` / 視窗天數 / `MIN_AVG_VOLUME_SHARES`），不傳則回退現有預設。輸出 JSON 已內嵌 `params` 區塊，格式沿用
- [ ] `calculateBreakoutStrength(date, config?)` — `config` 可覆蓋 `breakout-shared.ts` 的 `GATES` / `WEIGHTS` / `TRIGGER_VOLUME_RATIO` / 各視窗常數，不傳則回退
- [ ] **明確區分兩類參數**（分層架構靠這個切）：「門檻類」（`GATES` / `TRIGGER_VOLUME_RATIO` / `MIN_AVG_VOLUME_SHARES`…決定誰進候選池，走 Layer 1）vs「加權 / 曲線類」（`WEIGHTS` / `CHIP_WEIGHTS` / 映射轉折點…決定分數怎麼組，走 Layer 2）。`config` 型別建議照這兩類分成兩個子物件
- [ ] `breakout-shared.ts` 內嵌的 magic number（`computeVolumeStrength` 的 2×→40/6×→100、`computeBreakoutMargin` 的 3% 轉折、`computeBase` 的 0.6/0.4 權重等）評估哪些值得抽成 config、哪些維持寫死。**凡是可能成為校準對象的曲線轉折點，Layer 0 就必須存它的原始輸入而非成品分數**（見 3.2）
- [ ] 從 `check-intraday-breakout.ts` 的私有 `main()` 抽出可呼叫的純函式（目前完全沒匯出），供回測用歷史資料模擬盤中快照——**注意**：TPEx 盤中/歷史端點限制（見 CLAUDE.md），盤中訊號的歷史回測可能只能對 TWSE 或只能用收盤資料近似
- [ ] 確認參數化沒改變預設行為：對同一天用「不傳 config」與「傳等於預設值的 config」跑，輸出需完全一致

### 3.2 檔案輸出格式設計（取代原「回測資料表」）

不新增 Prisma model。改設計 Layer 0–3 各自的檔案內容與職責。

**共通原則：Layer 0 存「原始輸入值」，不存成品分項分數、不存 rankScore 結果。** 兩個理由：
1. **rankScore 穿透**（見 3.0）：分項分數是「在某個候選池裡的百分位」，候選池一變就失效，必須事後重算，所以只能存排名前的原始比率。
2. **曲線可校準**：`computeVolumeStrength`（2×→40）、`computeBreakoutMargin`（3% 轉折）、`computeBase`（0.6/0.4）這些映射曲線，肉眼校準時很可能想調。存成品分數 = 鎖死曲線；存原始值（量比幾倍、乖離幾 %）= 想改曲線不用重跑 Layer 0。重算成本是純算術（全市場約 1900 檔 × 交易日數 × 7 函式 ≈ 千萬次純函式呼叫，秒級），不心疼。

**檔案結構：**

```
data/backtest-runs/{run-id}/
  config.json                 # 時間範圍（訓練/驗證）、策略、選股純函式的 code 版本（git hash 或手動版號）
  raw-factors/{date}.jsonl    # Layer 0 輸出，按交易日分檔，一行一檔股票
  versions/{name}.json        # 使用者主動保留的具名重算結果（對應原 ParamVersion 概念）
  versions/index.json         # 具名版本清單：name / config / 建立時間 / 統計摘要 pointer
  summary/{name}.json         # （選配）Layer 3 統計輸出，若要跨 session 保留

data/backtest-cache/
  forward-returns.jsonl       # Layer 0.5，全域、非 run 專屬，(date, code) → N 日報酬 + benchmark
```

- **`config.json`**：`code` 版本很重要——`raw-factors` 只在「選股純函式本身沒改」時可重用；函式改了要重跑 Layer 0。
- **`raw-factors/{date}.jsonl`（Layer 0）**：全市場每檔一行。內容分兩塊——
  - **門檻判斷裸值**：`close` / `bollingerUpper` / `volume` / `volumeMa20` / `sharesOutstanding`（＋ accumulation 額外需要的、breakout 額外需要的）。
  - **rankScore 前的原始聚合值**：
    - accumulation：投信 20 日淨買超天數比例、投信淨買超股數 ÷ 股本、(外資+自營商淨買超加總) ÷ (成交量加總)、近 5 日 `volume/volumeMa20` 均值、當日 bandwidth ＋ 前 240 日 bandwidth 陣列。
    - breakout：量比（`volume/volumeMa20`）、乖離率（`(close−bollingerUpper)/bollingerUpper`）、K 棒 OHLC、firstBar 需要的近 30 日 `close`+`bollingerUpper` 序列、當日 bandwidth ＋ 前 240 日 bandwidth 陣列、proximity 需要的近 240 日 `close`、RS 需要的近 61 日 `close`。
  - **按交易日分檔**的理由：Layer 1 可串流逐日讀；換時間範圍時只補新日期的檔；單一巨檔（估計 300MB–1GB）不好處理。
  - **體積退路**：若 `raw-factors` 體積失控，`computeBase` 的 240 日 bandwidth 陣列可退成只存兩個中間量（depthScore、durationDays），代價是放棄調 `computeBase` 內部邏輯。**預設存完整陣列**，這只是退路。
- **`forward-returns.jsonl`（Layer 0.5）**：(date, code) → { ret5, ret10, ret20, benchmarkRet5/10/20 }。只跟「日期＋股票代號」有關，跟策略、參數完全無關 → breakout 和 accumulation 跑同期間**共用同一份**，算過的 (date, code) 就不再算。不放進某次 run 的資料夾。
- **Layer 1/2/3 不落地**：篩池 + 分項函式 + rankScore + 加權 + 統計全在記憶體 / 前端 state。使用者主動要保留比較時才存成 `versions/{name}.json`。

### 3.3 Layer 0 基準跑（批次歷史模擬引擎）

- [ ] 對回測區間內每個交易日，用選股純函式撈 DB 算出**全市場每檔**的門檻裸值 + rankScore 前原始聚合值，寫入 `raw-factors/{date}.jsonl`。**不套任何門檻、不算成品分數、不寫 DB**
- [ ] 背景任務執行（可能跑幾百個交易日）：Server Action 觸發 → 背景 worker 逐日跑 → 寫進度檔（或記憶體進度），UI 輪詢
- [ ] **資料完整性檢查（這步仍查 DB）**：Layer 0 開跑前確認回測區間的 `DailyQuote` / `TechnicalIndicator` / `InstitutionalTrading` 覆蓋率。**兩個待確認事項**：
  - `InstitutionalTrading` 實際資料範圍——CLAUDE.md 寫「2025-05-02 起 324 個交易日」，`accumulation-shared.ts` 附近的說明寫「已回補至 6 年」，**兩者矛盾**，決定 accumulation 回測區間能拉多長，實作前先確認以哪個為準
  - Layer 0 正確性前提是 `TechnicalIndicator` 已完整回填**整個回測區間**（`bollingerUpper` / `bollingerBandwidth` / `volumeMa20` 是逐日重算寫入的，查歷史某天安全），否則早期日期候選池會因指標缺值而大量 degraded / 被剔除，污染回測結果

### 3.4 效果評估模組（產生 Layer 0.5 report cache）

- [ ] 對回測區間內每個 (交易日, 全市場股票)，用該日之後的 `DailyQuote` OHLC 算 N 日（5/10/20，可設定）報酬率，寫入 `forward-returns.jsonl`。算過的 (date, code) 跳過
- [ ] 對照組：同期大盤報酬（加權指數）作為 benchmark，一併寫進同一份 cache
- [ ] 命中判定（`ret_N > benchmarkRet_N`）放在 Layer 3 算，不寫進 cache（cache 只放與策略無關的原始報酬）
- [ ] （選配）簡單停損停利規則模擬：用後續 OHLC 判斷先觸發停利還是停損——**優先度低，先做「訊號有沒有預測力」，這塊之後再擴充**

### 3.5 統計匯總模組（讀 JSONL 用 JS 算，非 Prisma 查詢層）

- [ ] 抽成純函式 `computeBacktestStats(candidates, forwardReturns)` — 輸入 Layer 2 的候選名單 + Layer 0.5 的報酬 cache，輸出：命中率（贏過 benchmark 比例）、平均 / 中位數報酬、勝率、賺賠比、最大回撤
- [ ] 按時間分段的穩定性（避免只在某段市況特別準）——每季一個 bucket
- [ ] 按分數分層驗證單調性：前 10 名 vs 前 30 名 vs 全候選，看分數高低是否真的對應報酬高低
- [ ] 訓練期與驗證期分開統計、用同一組參數跑
- [ ] 純函式好處：不依賴 DB、好單測；這些統計本來就不是 SQL aggregate 一句話能算的

### 3.6 訓練/驗證期切分

- [ ] 一開始固定一段時間範圍，切訓練期（in-sample，較長，例如扣掉最近 2–3 個月）與驗證期（out-of-sample，較短，最近 2–3 個月）。**範圍固定，不隨參數調整而更換**
- [ ] 訓練期反覆調參：改 Layer 1/2 參數 → 重跑 Layer 1/2/3（記憶體，即時）→ 比較命中率變化
- [ ] `config.json` 記錄「這組參數是在哪段訓練期調出來的」
- [ ] 驗證期需要**顯式「解鎖」動作** + 紅色警示；驗證期跑完的結果**自動落地存檔**（避免使用者「看一眼就回去調參」當沒看過）
- [ ] UI 視覺警示：不要用驗證期資料回頭調參數（那樣驗證期就失去意義）
- [ ] rolling window / walk-forward optimization 明列為之後再做，初期先固定一組切分

### 3.7 回測 UI

分兩種操作，成本差很多：

- [ ] **執行基準跑（慢）**：選策略 + 時間範圍（訓練/驗證分開選）→ 觸發 Layer 0 + Layer 0.5 cache miss 的部分 → 進度條 / 背景執行。預期數十秒到數分鐘，視區間長度。跑完顯示全市場原始因子已就緒
- [ ] **調整參數（快）**：滑桿 / 輸入框改門檻（Layer 1）或加權 / 曲線轉折（Layer 2）→ Layer 1/2/3 記憶體重算 → **目標 <2 秒**更新儀表板。這是整個設計的賣點，UI 做成滑桿即時回饋
- [ ] **設定頁**：參數輸入面板（門檻類 / 加權類分區）、日期範圍（訓練/驗證分開選、視覺警示）、版本命名與存檔
- [ ] **結果儀表板頁**：命中率 / 平均報酬 / 勝率 / 賺賠比等指標卡片 + 圖表（報酬分布直方圖、命中率隨時間折線圖、訓練 vs 驗證並排）
- [ ] **個股檢視頁**：單一候選股當天完整評分明細 + 後續實際走勢圖 + 是否命中，方便肉眼校準時對照
- [ ] **版本比較頁**：至少兩組參數版本並排顯示各項統計。比較對象是「不同參數的重新計算結果」，不一定都已落地存檔（記憶體 / 前端 state 暫存即可，主動保留才寫 `versions/{name}.json`）
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
