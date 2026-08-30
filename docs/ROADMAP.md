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
歷史回測系統  ⏸ 已擱置（程式碼在 feat/backtest-ui-3.6-3.7 分支，OOM 待修）
      │
      ▼
選股 → 挑股 → 觀察清單流程（日常操作殼）  ◄── 現在做這個
      │
      ▼
盤中提醒
  └─ 依賴：觀察清單存在 + 資料庫可從外部連線
```

原實作順序是 **scaffolding → 回測系統 → 日常選股/觀察清單流程 → 盤中提醒**。回測系統做到「訓練/驗證切分 + 完整 UI」後因效能問題（進儀表板 OOM）擱置（見第 3 節），**改先做第 4 節「選股→挑股→觀察清單」流程**。回測待日後把 Layer 0 讀取改成逐日串流再撿回。盤中提醒放最後，依賴觀察清單有內容、也依賴資料庫能被 GitHub Actions 連到。

---

## 1. 盤後選股 v2（投信吃貨訊號）— ✅ 程式碼完成，待參數校準

找「還沒出現第一根突破，但籌碼/技術面有醞釀跡象」的股票，跟 `calculate-breakout-strength.ts`（找已發生的突破事件）互補。

- [x] 四因子 + 乘法計分結構：`最終分數 = 籌碼分數(投信動能 ×0.7 + 排除投信的外資/自營商集中度 ×0.3) × 技術就緒係數(布林壓縮度/窒息量合成，下限 0.5)`。實作於 `scripts/calculate-accumulation-score.ts` + `scripts/accumulation-shared.ts`，輸出 `data/accumulation-score-results/{date}.json`。設計細節見 `docs/PROGRESS.md`（2026-08-27 段落）。
- [ ] **參數校準**：首版前 30 名偏大型股（「其他法人集中度」子項對權值股外資穩定流入給高分所致）。需肉眼看實際排名，調整 `accumulation-shared.ts` 的 `CHIP_WEIGHTS` / `READINESS_FLOOR` / `MIN_AVG_VOLUME_SHARES` 等常數。原打算「併入第 3 階段回測一起做」，但回測系統擱置——暫時只能肉眼看單日排名調，或等回測撿回。

## 2. 前端 scaffolding（Next.js + Prisma）

回測 UI 與後續日常操作介面共用的殼。這階段只搭骨架、不做業務頁面。

- [x] 在既有 repo 內建 Next.js（App Router）。決定放 repo 根目錄 `app/`（不開 `web/` 子目錄、不做 monorepo），與 `scripts/` 共用 `generated/prisma` client。Next 16.3.3 + Turbopack + TS 7 + ESM 直接可跑，無需降版或 `--webpack`
- [x] **Next.js + Prisma 單例**：`lib/prisma.ts` 用 `globalThis` 快取 `PrismaClient`（保留 `PrismaPg` driver adapter 寫法），檔頭 `import "server-only"` 當誤 import 護欄。hot reload 多次不會讓連線數持續增長
- [x] 不另建 REST/GraphQL API，一律用 **Server Actions**（`lib/actions/*.ts`）。已有 `getDbHealth()` 示範讀真實 DB 數字上首頁
- [x] 圖表庫定案 **Recharts**（`components/ChartSmoke.tsx` smoke 圖）、版面/導覽 = Tailwind CSS v4 + 手刻 `components/ui/` + `app/layout.tsx` 側邊欄
- [x] 背景任務機制定案：**獨立 Node 子進程（`spawn` tsx cli.mjs 絕對路徑）+ 進度寫檔 + Server Action 輪詢**。PoC（`scripts/_poc/` + `lib/actions/poc.ts` + `components/PocRunner.tsx`）已於回測系列第一份 PLAN（3.1 腳本參數化）開始時刪除；模式記錄在 CLAUDE.md「背景任務」段，真的 Layer 0 runner 待 3.3

## 3. 歷史回測系統 — ⏸ 已擱置（2026-08-30）

> **狀態**：3.0～3.5 曾在 `main` 上完成、3.6/3.7 在 `feat/backtest-ui-3.6-3.7` 分支上完成，但**整個回測系統已從 `main` 移除**（程式碼保留在該分支）。
>
> **擱置原因**：詳細頁 `runBacktestSummary` 把整個 run 的 `raw-factors/*.jsonl` 一次 `JSON.parse` 進記憶體，即使「一年 breakout」也讓 Next dev server heap OOM（8 GB）。要修得先把 Layer 0 讀取改成「逐日串流 replay、只累積候選 picks」。決定先擱置、專心做第 4 節。
>
> **撿回方式**：`git checkout feat/backtest-ui-3.6-3.7`，先做「Layer 0 讀取改逐日串流」再接 UI。下方各小節的打勾是「當時做過」的紀錄，不代表 `main` 現況。

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

- [x] `calculateAccumulationScore(date, { prisma?, config? })` — `config` 可覆蓋 `accumulation-shared.ts` 的所有常數（`CHIP_WEIGHTS` / `TRUST_SUB_WEIGHTS` / `TECH_WEIGHTS` / `READINESS_FLOOR` / 視窗天數 / `MIN_AVG_VOLUME_SHARES`），不傳則回退現有預設。輸出 JSON 的 `params` 區塊改成輸出實際生效的 resolved config（`gate` + `score` 兩子物件）
- [x] `calculateBreakoutStrength(date, { prisma?, config? })` — `config` 可覆蓋 `breakout-shared.ts` 的 `GATES` / `WEIGHTS` / `TRIGGER_VOLUME_RATIO` / 各視窗常數 / 抽出的曲線轉折點，不傳則回退
- [x] **明確區分兩類參數**（分層架構靠這個切）：`config` 型別分 `gate`（門檻類：`minMarketCap` / `minVolumeShares` / `triggerVolumeRatio` / `minAvgVolumeShares`，決定誰進候選池，走 Layer 1）與 `score`（加權 / 曲線 / 視窗類：`weights` / `chipWeights` / `curves` / `*WindowDays` 等，決定分數怎麼組，走 Layer 2）兩子物件。degraded 門檻（`baseMinHistoryDays` / `minInstitutionalDaysRatio` 等）歸 `score`（不剔除股票，只降級分項）
- [x] `breakout-shared.ts` 內嵌的 magic number 逐項評估：**抽出** `computeVolumeStrength`（2×→40/6×→100）、`computeBreakoutMargin`（3% 轉折 + 每 1% 扣 5 分 + 下限 60）、`computeBase`（0.6/0.4 權重 + duration 封頂 40 天）進 `config.score.curves`；**維持寫死** `computeCandleShape` / `computeProximityScale` / `computeFirstBar`（離散規則）/ `computeBase` 的 p25 門檻（改了語意就變），各在函式上方加 `// TODO(backtest)` 註記
- [x] 從 `check-intraday-breakout.ts` 的私有 `main()` 抽出 `checkIntradayBreakout({ prisma?, config?, now? })`（`main()` 變薄殼）——`now` 一併參數化供回測注入時間。**注意**：TPEx 盤中/歷史端點限制（見 CLAUDE.md），盤中訊號的歷史回測可能只能對 TWSE 或只能用收盤資料近似
- [x] 確認參數化沒改變預設行為：對 breakout `2026-08-18` / `2026-08-21` / `2026-08-27`、accumulation `2026-08-26` 建黃金檔，改動後「不傳 config」與「傳 `DEFAULT_*_CONFIG`」重跑，`results` 陣列皆逐位元相同

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

- [x] 對回測區間內每個交易日，用選股純函式撈 DB 算出**全市場每檔**的門檻裸值 + rankScore 前原始聚合值，寫入 `raw-factors/{date}.jsonl`。**不套任何門檻、不算成品分數、不寫 DB**。實作：`scripts/backtest/run-layer0.ts`（`runLayer0()` + CLI + `isMain` guard + `--resume`）。撈資料邏輯抽成 `scripts/lib/{breakout,accumulation}-shared.ts` 的 `fetchXxxRawInputs` helper，Layer 0 與正式跑共用（黃金檔驗證逐位元不變）。視窗多抓緩衝（`history` 260 / `rsCloseSeries` 76 / `institutional` 30 等），記進 `config.json.windowConfig`
- [x] 背景任務執行（可能跑幾百個交易日）：Server Action 觸發 → 背景 worker 逐日跑 → 寫進度檔（原子寫）→ UI 輪詢。實作：`lib/actions/backtest.ts`（`startLayer0Run` / `getLayer0Progress` / `listBacktestRuns`，spawn `process.execPath` + `node_modules/tsx/dist/cli.mjs` 絕對路徑 detached 子進程）+ `app/backtest/page.tsx` + `components/BacktestRunner.tsx`（進度條 setInterval 2s 輪詢）
- [x] **資料完整性檢查（這步仍查 DB）**：Layer 0 開跑前確認回測區間的 `DailyQuote` / `TechnicalIndicator` / `InstitutionalTrading` 覆蓋率。實作：`scripts/backtest/check-data-completeness.ts`（`checkDataCompleteness()` + CLI，有 hard failure 時 exit 1，也被 `run-layer0.ts` 開跑前呼叫）。抓「整段缺日期」與「單股缺漏」（`thinStocks`，實際/應有 < 0.9；`expectedDays` 用該股第一筆 DailyQuote 之後的交易日數，區間中途上市的新股不誤報）。**已釐清**：
  - `InstitutionalTrading` 實際資料範圍（2026-08-28 查 DB 確認）：**2020-01-02 → 2026-08-28、約 1476 個交易日、266 萬筆**，與 `DailyQuote` / `TechnicalIndicator` 同起點。舊紀錄「2025-05-02 起 324 個交易日」是 2026-08-27 6 年回補前的狀態，已過時。**accumulation 回測區間可拉滿 6 年**，唯一注意早期年份每日檔數略少（2020 每日約 1808 檔 vs 2025 約 1983 檔），屬正常（當時上市家數較少）。
  - Layer 0 正確性前提是 `TechnicalIndicator` 已完整回填**整個回測區間**（`bollingerUpper` / `bollingerBandwidth` / `volumeMa20` 是逐日重算寫入的，查歷史某天安全），否則早期日期候選池會因指標缺值而大量 degraded / 被剔除，污染回測結果。已知 2026-08-27 6 年回補時 4104 曾只寫 326 筆報價再事後補回 1616 筆（技術指標亦已用單股參數補算），完整性檢查腳本要能抓出這類單股缺漏

### 3.4 效果評估模組（產生 Layer 0.5 report cache）

- [x] 對回測區間內每個 (交易日, 全市場股票)，用該日之後的 `DailyQuote` OHLC 算 N 日（5/10/20，可設定）報酬率，寫入 `forward-returns.jsonl`。算過的 (date, code) 跳過 → `scripts/backtest/build-forward-returns.ts`（`buildForwardReturns()` + CLI + `isMain` guard；「第 N 天」用該股自己的報價序列數，不足 N 筆記 null）
- [x] 對照組：同期大盤報酬（0050，未還原）作為 benchmark，一併寫進同一份 cache（benchmark 用全市場交易日曆算第 N 天，缺日往後找並記 `benchmarkGapDays`）
- [x] 命中判定（`ret_N > benchmarkRet_N`）放在 Layer 3 算，不寫進 cache（cache 只放與策略無關的原始報酬）
- [ ] （選配）簡單停損停利規則模擬：用後續 OHLC 判斷先觸發停利還是停損——**優先度低，先做「訊號有沒有預測力」，這塊之後再擴充**

### 3.5 統計匯總模組（讀 JSONL 用 JS 算，非 Prisma 查詢層）

- [x] 抽成純函式 `computeBacktestStats(candidates, forwardReturns, options)` — 輸入 Layer 2 的候選名單 + Layer 0.5 的報酬 cache，輸出：命中率（贏過 benchmark 比例）、平均 / 中位數報酬、超額報酬、勝率、賺賠比、最大回撤 → `scripts/lib/backtest-stats.ts`
- [x] 按時間分段的穩定性（避免只在某段市況特別準）——每季一個 bucket（`byQuarter`）
- [x] 按分數分層驗證單調性：前 10 名 vs 前 30 名 vs 全候選（`byTopN`，切點可設定，預設 `[10, 30, Infinity]`）
- [x] 訓練期與驗證期分開統計、用同一組參數跑（`options.split` → `bySplit.train` / `bySplit.valid`；不做鎖定行為，留 3.6）
- [x] 純函式好處：不依賴 DB、好單測；`scripts/lib/backtest-stats.test.ts`（專案首個單測檔，`node:test` + tsx，7 組手算案例）

### 3.6 訓練/驗證期切分 — 曾在 `feat/backtest-ui-3.6-3.7` 完成，隨系統擱置

（切分綁 `config.json.split`、UI 預設只顯示訓練期、驗證期需手打 `unlock validation` 解鎖、解鎖後看過的參數自動落地 `validation-unlock.json`、紅色警示、rolling window 明列之後再做——都做過，程式碼在分支上。）

### 3.7 回測 UI — 曾在 `feat/backtest-ui-3.6-3.7` 完成，隨系統擱置

（`/backtest/{runId}` 詳細頁：參數面板滑桿即時重算、指標卡片、Recharts 圖表（報酬分布 / 命中率季度線 / byTopN / 訓練 vs 驗證）、個股檢視 modal、版本比較——都做過，程式碼在分支上。**未解決**：`runBacktestSummary` 一次讀整個 run 的 raw-factors 導致 OOM，「調參數 <2 秒」的賣點未在真實 6 年 run 上驗證。「用回測框架回頭做 accumulation 參數校準」也一併擱置。）

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
