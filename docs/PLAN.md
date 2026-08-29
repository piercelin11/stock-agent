# PLAN：Forward-returns cache + 統計純函式（回測第 3 批）

對應 `docs/ROADMAP.md` 第 3.4（效果評估模組 / 產生 Layer 0.5 report cache）與 3.5（統計匯總模組 / 讀 JSONL 用 JS 算）。這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識完成後回寫 `CLAUDE.md`，過程紀錄回寫 `docs/PROGRESS.md`，ROADMAP 3.4 / 3.5 的 `- [ ]` 逐項打勾。

前兩批已完成：

- **3.1 腳本參數化**：兩支選股純函式 `calculateBreakoutStrength(date, { prisma?, config? })` / `calculateAccumulationScore(date, { prisma?, config? })` 可覆蓋參數 + 可被 Next.js 安全 import，`config` 分 `gate`（門檻類）/ `score`（加權/曲線/視窗類）兩子物件。
- **3.2 + 3.3 檔案格式 + Layer 0 基準跑**：`scripts/backtest/run-layer0.ts`（`runLayer0()` + CLI + `isMain` guard + `--resume`）逐交易日把全市場每檔的「門檻裸值 + rankScore 前原始聚合值」寫進 `data/backtest-runs/{run-id}/raw-factors/{date}.jsonl`（無損 tuple 編碼、視窗多抓緩衝、round 6 位）。`scripts/backtest/check-data-completeness.ts`（`checkDataCompleteness()` + CLI）開跑前檢查三表覆蓋率。撈 DB 邏輯抽成 `scripts/lib/{breakout,accumulation}-shared.ts` 的 `fetchXxxRawInputs` helper。背景任務骨架：`lib/actions/backtest.ts` + `app/backtest/page.tsx` + `components/BacktestRunner.tsx`。

---

## 0. 這一批的邊界

**只做兩件事：**

1. **Layer 0.5 forward-returns cache**：對回測涉及的每個 `(交易日, 全市場股票)`，用該日之後的 `DailyQuote` OHLC 算 N 日（5 / 10 / 20，可設定）報酬率，加上同期 benchmark（0050）報酬，寫入 `data/backtest-cache/forward-returns.jsonl`。**全域、非 run 專屬**，跨策略共用；算過的 `(date, code)` 跳過。獨立 CLI + 被 Layer 0 完成後可選擇性接著跑。

2. **統計純函式模組**：`scripts/lib/backtest-stats.ts`，匯出 `computeBacktestStats(candidates, forwardReturns, options)` 等純函式。輸入「某組參數重算出來的候選名單（含分數 / rank / degraded）」+「forward-returns cache」，輸出命中率、平均 / 中位數報酬、勝率、賺賠比、最大回撤、按季穩定性、按分數分層單調性、訓練 / 驗證期分開統計。**純函式、不碰 DB、不落地**——好單測，供之後的 Layer 1/2/3 記憶體重算與回測 UI 直接呼叫。

**為了讓統計函式有東西可測，本批一併補上「Layer 1/2 記憶體重算」的最小可用實作**（3.5 的統計必須吃 Layer 2 的候選名單），但**只做能餵進統計的骨架**，不做 UI 滑桿、不做即時回饋優化：

- `scripts/lib/backtest-replay.ts`：`replayBreakout(rawFactorsRows, config)` / `replayAccumulation(rawFactorsRows, config)`——讀某一天的 `raw-factors` 行陣列 + resolved config，在記憶體套 `gate` → 重跑 `rankScore` → 套 `score` 評分函式 → 加權排名，回傳跟 `calculateBreakoutStrength` / `calculateAccumulationScore` 的 `results` **同形狀**的候選名單。這就是 3.0 架構圖的 Layer 1 + Layer 2，只是不接前端。
- 上一批的一次性 `_verify-layer0.ts`（已刪）其實就是這個的雛形；本批把它正式化成 `backtest-replay.ts` 並留下。

**明確不在範圍**（留給後續 PLAN）：

- **Layer 3 完整串接 + 回測 UI**（設定頁滑桿 / 儀表板圖表 / 個股檢視 / 版本比較）→ ROADMAP 3.7。本批 `backtest-replay.ts` + `backtest-stats.ts` 是純函式庫，`app/backtest/` 只加「跑一次完整重算並印統計摘要」的最小驗證入口（見 §5），不做互動面板。
- **訓練/驗證期的鎖定/解鎖 + 紅色警示 + 驗證期結果自動落地** → ROADMAP 3.6。本批 `computeBacktestStats` **接受** `split` 參數並**分段輸出**訓練 / 驗證統計，但不做「解鎖動作」「看過就落地」這類行為約束。
- **`versions/{name}.json` / `summary/{name}.json`（具名重算結果保留）** → Layer 2/3 PLAN。本批統計輸出只回傳 plain object，呼叫端自己決定要不要存。
- **停損停利規則模擬**（用後續 OHLC 判斷先觸發停利還停損）→ ROADMAP 3.4 已標「優先度低」，本批不做，`forward-returns.jsonl` 只存原始 N 日報酬。
- **參數校準本身**（accumulation 前段偏大型股）→ 要等本批的 replay + stats + 3.7 UI 齊了才能做。
- **rolling window / walk-forward** → ROADMAP 3.6 已明列之後再做。

---

## 1. 前置事實（已查證，實作時直接採用）

### 1.1 資料現況

| 表 | 區間 | 備註 |
| --- | --- | --- |
| `DailyQuote`（一般股票 + 0050）| 2020-01-02 → 今 | forward-returns 的 OHLC 來源；0050 約 1612 筆（benchmark 用）|
| `TechnicalIndicator` / `InstitutionalTrading` | 2020-01-02 起 | 本批不直接讀，Layer 0 已把需要的值寫進 `raw-factors` |

- **benchmark 標的**：`scripts/backfill/backfill-benchmark-quotes.ts` 已把 **0050** 補進 `DailyQuote`（`BENCHMARK_CODES = ["0050"]`，`securityType=etf`）。本批 forward-returns 的 benchmark 報酬直接讀 0050 的 `DailyQuote.close`。
- **0050 未還原股價**：除息日 `close` 含假跌幅。benchmark 報酬對除息敏感度低（N=5/10/20 日、一次除息影響約 1~2%），**本批接受此誤差**，PROGRESS 記「若日後 benchmark 報酬要更準，改抓 `TaiwanStockPriceAdj` 或加 006208 對照」。
- **交易日曆**：專案無交易日曆表。「某天是不是交易日」一律以「`DailyQuote` 當天有沒有一般股票資料」為準（沿用 `run-layer0.ts` 的 `tradingDatesInRange`）。forward-returns 算「該日之後第 N 個交易日」也用這套 distinct date 清單。

### 1.2 forward-returns 的定義（精確）

給定基準日 `d`、股票 `code`、水平 `N`：

- `entryClose` = `code` 在 `d` 當天的 `DailyQuote.close`。
- `exitClose` = `code` 在「`d` 之後第 N 個**該股實際有報價的交易日**」的 `close`。
  - **用該股自己的報價序列數 N**，不是全市場交易日曆——停牌 / 暫停交易的股票不會因為「日曆上第 N 天沒開」而算錯或落空。實作：撈 `code` 在 `date > d` 的 `DailyQuote`（升冪）取第 N 筆。
  - 若該股在 `d` 之後不足 N 筆報價（近期上市沒滿 N 天 / 已下市）→ 該 `(d, code, N)` 的報酬記 `null`，不跳過整檔（其他 N 可能有值）。
- `retN` = `(exitClose - entryClose) / entryClose * 100`（百分比，round 到 6 位，與 `raw-factors` 同精度）。
- `benchmarkRetN` = 0050 用**全市場交易日曆**的「`d` 之後第 N 個交易日」算的同式報酬（benchmark 不會停牌，用日曆即可；若 0050 剛好缺該日則往後找第一個有值的，並記 `benchmarkRetNActualGapDays`）。
- **命中判定 `retN > benchmarkRetN` 不寫進 cache**——cache 只放與策略無關的原始報酬，命中留給 §4 的 `computeBacktestStats` 算（ROADMAP 3.4 明訂）。

### 1.3 replay 要重現的評分管線（從兩支 screening 腳本抄）

**breakout（`calculate-breakout-strength.ts` 的 `runCalculation`）：**

1. `gate.triggerVolumeRatio`：`volume / volumeMa20 >= 2.0` 才進場（第一層觸發）。
2. `gate.minMarketCap`（30 億）+ `gate.minVolumeShares`：`sharesOutstanding × close` 與 `volume` 門檻（第二層資格）。
3. 七項評分函式（`computeCandleShape` / `computeVolumeStrength` / `computeBreakoutMargin` / `computeFirstBar` / `computeBase` / `computeProximityToHigh` / RS），其中 **`relativeStrength` = 全市場 `computeMarketWideReturns` → `rankScore(returns, false, naScore)`**（跨全市場百分位，不是候選池）。
4. `totalScore = Σ scores[k] × score.weights[k]`，`sort desc`，`rank = i + 1`。
5. `degraded: string[]` 收集各函式回傳的 degraded 分項名。

**accumulation（`calculate-accumulation-score.ts` 的 `runCalculation`）：**

1. `buildCandidatePool` 門檻：剔除「今日 `close > bollingerUpper`」（與突破清單互斥）+「近 20 日均量 < `gate.minAvgVolumeShares`(=500 張)」。
2. 四分項原始值 → **跨候選池** `rankScore`（`trustFreq` / `trustNetRatio` / `otherInst` / `quietVolume`）——候選池一變就要重算，這是 3.0 的 rankScore 穿透核心。
3. `trustScore = combineTrustScore(...)`；`chipScore = combineChipScore(trustScore, otherInstScore, score.chipWeights)`。
4. `readinessCoef = computeReadinessCoefficient(techRaw, score.readinessFloor)`；`finalScore = combineFinalScore(chipScore, readinessCoef)`。
5. `sort by finalScore desc`，`rank = i + 1`，`degraded` 同上。

> **關鍵**：replay 不能沿用 Layer 0 時期的 `rankScore` 輸出（Layer 0 根本沒算），必須在「套完 `gate` 篩出候選池」之後，用候選池成員（breakout 的 RS 例外——母體是全市場）重跑 `rankScore`。`raw-factors` 存的是 rankScore 的**輸入**（量比、乖離、報酬序列、bandwidth 陣列、三大法人序列），replay 讀這些現算。

### 1.4 raw-factors 讀取：緩衝截斷

Layer 0 每個視窗多抓了緩衝（`history` 260 vs 預設 240、`rsCloseSeries` 76 vs 61、`institutional` 30 vs 20、`recentVolumes` 15 vs 5、`firstBarSeries` 40 vs 30、`bandwidthHistory` 260 vs 240）。**replay 讀 `raw-factors` 時，先把每個緩衝陣列截到 resolved config 的視窗長度再算**（上一批 `_verify-layer0.ts` 已印證：`computeBase` 對 260 筆 vs 240 筆的 percentile / p25 不同）。截斷邏輯集中在 `backtest-replay.ts` 的一個 `sliceWindows(row, config)` helper。

### 1.5 `data/` 與 `.gitignore`

- `.gitignore` 已有 `/data/backtest-runs/` + `/data/backtest-cache/`（上一批加）。本批的 `forward-returns.jsonl` 落在 `data/backtest-cache/`，已被 ignore，無需再改。

---

## 2. Layer 0.5：forward-returns cache

### 2.1 檔案位置與格式

```
data/backtest-cache/
  forward-returns.jsonl        # 本批產出，全域、非 run 專屬
  forward-returns.meta.json    # 本批產出，cache 元資料（涵蓋區間 / horizons / benchmark / 產生時間）
```

**`forward-returns.jsonl`**：一行一個 `(date, code)`，無縮排 `JSON.stringify`：

```jsonc
{
  "date": "2025-03-14",
  "code": "2330",
  "entryClose": 875.0,
  "ret5": 3.428571,          // %，null = 該股 d 之後不足 5 筆報價
  "ret10": -1.142857,
  "ret20": 8.0,
  "benchmarkRet5": 1.2,      // 0050 同期
  "benchmarkRet10": 2.05,
  "benchmarkRet20": 4.4,
  "benchmarkGapDays": null   // 通常 null；0050 剛好缺該交易日時記「往後找了幾天」
}
```

- **key 是 `(date, code)`，與策略 / 參數完全無關** → breakout 與 accumulation 跑同期間共用同一份，算過的不再算（ROADMAP 3.4）。
- **horizons 寫死 `[5, 10, 20]`**（`FORWARD_RETURN_HORIZONS` 常數），但欄位用 `retN` 命名以便日後加 `ret60` 不破格式。CLI 可用 `--horizons=5,10,20,60` 覆蓋。
- **round 到 6 位小數**（與 `raw-factors` 一致）。
- **不存命中旗標、不存停損停利**（§1.2）。

**`forward-returns.meta.json`**：

```jsonc
{
  "horizons": [5, 10, 20],
  "benchmarkCode": "0050",
  "coveredDateRange": { "start": "2020-01-02", "end": "2026-05-30" },  // cache 內實際出現過的 date 範圍
  "rowCount": 2841200,
  "lastBuiltAt": "2026-08-30T14:30:12.000Z",
  "note": "0050 未還原股價，除息日 close 含假跌幅；benchmark 報酬有小誤差"
}
```

### 2.2 檔案位置與匯出（`scripts/backtest/build-forward-returns.ts`，新檔）

放 `scripts/backtest/`（與 `run-layer0.ts` / `check-data-completeness.ts` 平行）。

```ts
export interface BuildForwardReturnsOptions {
  start: string;                 // YYYY-MM-DD，要算 forward-returns 的「基準日」下界
  end: string;                   // YYYY-MM-DD，基準日上界
  horizons?: number[];           // 預設 [5, 10, 20]
  codes?: string[];              // 選填，預設全市場一般股票；給定則只算這些
  prisma?: PrismaClient;
  force?: boolean;               // true = 重算並覆寫已存在的 (date, code)（改了報酬定義時用）
  onProgress?: (p: { totalDays: number; completedDays: number; currentDate: string | null }) => void;
}

export async function buildForwardReturns(
  options: BuildForwardReturnsOptions,
): Promise<{ rowsWritten: number; rowsSkipped: number; cachePath: string }>;
```

- `main()` 薄殼解析 CLI：`--start=2024-01-02 --end=2026-05-30 [--horizons=5,10,20] [--codes=2330,2454] [--force]`。
- **`isMain` guard**：`import` 不觸發 `main()`（比照 `run-layer0.ts`）。
- `prisma` 注入：`options.prisma ?? makePrisma()` + `ownsPrisma` finally disconnect（比照 3.1）。

### 2.3 演算法

```
1. 交易日母體：DailyQuote distinct date（securityType="stock"）全區間（不只 start..end——
   要算 end 當天的 ret20，需要 end 之後 +20 個交易日的報價，所以撈到「今天」為止）。
2. 讀既有 forward-returns.jsonl → Set<`${date}|${code}`>（已算過的，force=false 時跳過）。
3. 全市場一般股票清單（或 options.codes）。
4. 預載 benchmark：0050 全區間 DailyQuote（date → close）到 Map。
5. for each 基準日 d in [start..end] 交易日：
   a. 撈當天全市場 DailyQuote（code → close）= entryClose 來源。
   b. 對每檔 code：
      - 已在 Set 且非 force → skip（rowsSkipped++）。
      - 撈 code 在 date > d 的 DailyQuote.close 升冪前 max(horizons) 筆（一次撈完所有 horizon 用）。
      - 每個 N：有第 N 筆 → retN = (exit - entry)/entry*100；不足 → null。
      - benchmarkRetN：從 benchmark Map 找「d 之後第 N 個全市場交易日」的 0050 close；
        缺該日則往後找第一個有值，記 benchmarkGapDays（通常 null）。
      - 累積一行，round 6 位。
   c. append 到 forward-returns.jsonl（用 appendFileSync 或每日 batch 一次 write）。
   d. onProgress（completedDays++、currentDate=d）。
6. 重算 forward-returns.meta.json（rowCount 掃檔行數 / coveredDateRange / lastBuiltAt）。
```

- **效能**：6 年約 1476 基準日 × 約 1950 檔 ≈ 288 萬行。每檔「撈 d 之後前 20 筆」若逐檔查 DB 會 288 萬次 query → 太慢。**對策**：每個基準日 `d` **一次撈**「該日之後、全市場、`date` 在 `d` 後 30 個日曆日內的 `DailyQuote`」（`{ stockCode, date, close }`），在記憶體按 code 分組、升冪，取前 N 筆。30 日曆日足以涵蓋 20 交易日 + 假期緩衝；不足時（極少）對該檔補一次單獨 query。預估每日 1 個 range query（約 1950 檔 × 20 筆 ≈ 4 萬列）→ 1476 個 query，可接受。
- **append 而非覆寫**：cache 是累加的。`force=true` 時先把要重算的 `(date, code)` 從舊檔濾掉再 append（或整個區間重寫），meta 記 `lastBuiltAt`。
- **原子性**：寫 `forward-returns.jsonl.tmp` 累積完再 `rename`（大檔；append 模式下改為「每 50 個基準日 flush 一次、用臨時檔 + rename 替換」以免中途中斷留半行）。中斷後重跑靠 step 2 的 Set 自然續跑。

### 2.4 體積估算

- 每行約 12 欄純數字，`JSON.stringify` 約 160 bytes → 288 萬行 ≈ **460 MB**。可接受（`.gitignore`、可串流讀）。
- 若加 `ret60` / 多 benchmark → 線性增長，仍在 GB 內。

### 2.5 CLI 與 Layer 0 的關係

- **獨立可跑**：`pnpm tsx scripts/backtest/build-forward-returns.ts --start=2024-01-02 --end=2026-05-30`。
- **不強制綁進 `run-layer0.ts`**——forward-returns 與 run / 策略無關，重複跑只是浪費。但 `lib/actions/backtest.ts` 加一個 `ensureForwardReturns(range)` action（見 §5.1），UI 觸發 Layer 0 完成後可一併補齊 cache 缺的區間。

---

## 3. Layer 1/2 記憶體重算：`scripts/lib/backtest-replay.ts`（新檔）

### 3.1 定位

- **純函式庫**，`scripts/lib/` 下（與 `breakout-shared.ts` / `accumulation-shared.ts` 同層），import 它們的評分函式 + `rankScore` + config 型別，**不 import Prisma、不讀檔**。輸入是「已經讀進記憶體的 `raw-factors` 行陣列」。
- 職責 = ROADMAP 3.0 的 **Layer 1（套 `gate` 篩池）+ Layer 2（重跑 `rankScore` → 套 `score` → 加權排名）**。
- 上一批的一次性 `_verify-layer0.ts` 是這個的原型（已刪），本批正式化。

### 3.2 匯出

```ts
import type { BreakoutConfig } from "./breakout-shared";
import type { AccumulationConfig } from "./accumulation-shared";

/** raw-factors/{date}.jsonl 一行 parse 後的形狀（tuple 已還原成具名，見 §3.3） */
export interface BreakoutRawRow { /* date, code, name, close, ..., firstBarSeries, history, rsCloseSeries */ }
export interface AccumulationRawRow { /* date, code, name, close, ..., institutional, recentVolumes, bandwidthHistory */ }

export interface ReplayResultBreakout {
  date: string;
  code: string;
  name: string;
  scores: Record<string, number>;   // 七分項
  totalScore: number;
  rank: number;
  degraded: string[];
}
export interface ReplayResultAccumulation {
  date: string;
  code: string;
  name: string;
  chipScore: number;
  readinessCoef: number;
  finalScore: number;
  rank: number;
  degraded: string[];
}

/** 單一交易日重算。rows = 該日 raw-factors 全部行。回傳「通過 gate 並評分排名後」的候選名單。 */
export function replayBreakout(rows: BreakoutRawRow[], config: BreakoutConfig): ReplayResultBreakout[];
export function replayAccumulation(rows: AccumulationRawRow[], config: AccumulationConfig): ReplayResultAccumulation[];

/** 多日批次：Map<date, rows> → Map<date, ReplayResult[]>。純粹逐日呼叫上面兩個，方便統計模組用。 */
export function replayBreakoutRange(byDate: Map<string, BreakoutRawRow[]>, config: BreakoutConfig): Map<string, ReplayResultBreakout[]>;
export function replayAccumulationRange(byDate: Map<string, AccumulationRawRow[]>, config: AccumulationConfig): Map<string, ReplayResultAccumulation[]>;
```

### 3.3 raw-factors 行的 parse（tuple → 具名）

Layer 0 為壓體積用了位置對齊 tuple（`history` = `[close, bollingerBandwidth]`、`firstBarSeries` = `[close, bollingerUpper]`、`institutional` = `[trustNetBuy, foreignPlusDealerNetBuy, volume]`）。`backtest-replay.ts` 提供 `parseBreakoutRow(json)` / `parseAccumulationRow(json)` 把 tuple 還原成評分函式期望的 `{ close, bollingerUpper }[]` 等形狀。**這一步 + §1.4 的緩衝截斷是 replay 唯一的「格式適配」邏輯，其餘直接呼叫 shared 檔函式。**

### 3.4 `replayBreakout` 步驟（對照 §1.3）

```
1. 每行 parse + sliceWindows（截 history→240 / rsCloseSeries→61 / firstBarSeries→30，取自 config.score）
2. gate.triggerVolumeRatio：volume / volumeMa20 >= config.gate.triggerVolumeRatio → 進 triggered
3. gate.minMarketCap / minVolumeShares：sharesOutstanding × close、volume 門檻 → 進 passed
4. RS 母體 = 全市場（rows 全部，不是 passed）：
   - 每行 rsCloseSeries → computeMarketWideReturns(codes, historyByStock, config.score.rsWindowDays)
   - rankScore(returns, false, config.score.naScore) → rsScoreByCode
5. for each passed q：
   - computeCandleShape / computeVolumeStrength(volume/volumeMa20, curve) / computeBreakoutMargin(close, bu, curve)
     / computeFirstBar(firstBarSeries, ...) / computeBase(history bandwidth, curve, ...) / computeProximityToHigh(history close, ...)
   - scores.relativeStrength = rsScoreByCode[q.code]
   - totalScore = Σ scores[k] × config.score.weights[k]
   - degraded 收集
6. sort by totalScore desc → rank
```

### 3.5 `replayAccumulation` 步驟

```
1. 每行 parse + sliceWindows（institutional→20 / recentVolumes→5 / bandwidthHistory→240）
2. gate：剔除 close > bollingerUpper；剔除「recentVolumes / 對齊的 volumeMa20 推近 20 日均量」< config.gate.minAvgVolumeShares
   （均量口徑照 calculate-accumulation-score.ts 現行做法）
3. 候選池成員定了 → 四分項原始值：
   - computeTrustRawMetrics(institutional trust 序列, ...) → trustFreqRaw / trustNetRatioRaw
   - computeOtherInstitutionRatio(institutional foreign+dealer 序列, institutional volume 序列, ...) → otherInstRaw
   - computeQuietVolumeRatio(recentVolumes, volumeMa20, ...) → quietVolumeRaw
   - computeBase(bandwidthHistory, breakout base curve, ...) → squeeze techRaw 的一半
4. 跨「候選池」rankScore 四分項（lowerIsBetter 各依現行）
5. trustScore = combineTrustScore(...); chipScore = combineChipScore(trustScore, otherInstScore, config.score.chipWeights)
6. readinessCoef = computeReadinessCoefficient(techRaw, config.score.readinessFloor); finalScore = combineFinalScore(...)
7. sort by finalScore desc → rank
```

### 3.6 正確性驗證（本批驗收核心）

`replay*` 對「不篩池、用 `DEFAULT_*_CONFIG`」跑某一天，要跟 `data/*-results/{date}.json` 的 `results` **數值一致**（`totalScore` / `finalScore` 每檔誤差 < 1e-9，`rank` / `degraded` 完全相同）。

- **基準日**：breakout `2026-08-27`（`data/breakout-strength-results/2026-08-27.json` 存在）、accumulation `2026-08-26`（`data/accumulation-score-results/2026-08-26.json` 存在）。
- **前提**：這些 `data/*-results/` JSON 可能已比現行程式碼舊（見專案記憶「committed screening outputs 會 lag」）→ **驗證前先用現行程式碼重跑一次** `calculate-breakout-strength.ts --date=2026-08-27` / `calculate-accumulation-score.ts --date=2026-08-26` 覆蓋，當作 replay 的 golden。
- **需要對應日期的 `raw-factors`**：先跑一小段 Layer 0（`--strategy=breakout --start=2026-08-25 --end=2026-08-27 --min-trading-days=1` / accumulation 同）產出 `raw-factors`，replay 讀它。
- **允許差異**：`rsCloseSeries` 緩衝長度（Layer 0 存 76、replay 截 61）→ 截斷後 61 日報酬應完全一致，`relativeStrength` 分數不受影響。
- 驗證腳本 `scripts/backtest/_verify-replay.ts`（一次性，**驗完刪**，PROGRESS 註明）。

---

## 4. Layer 3 統計純函式：`scripts/lib/backtest-stats.ts`（新檔）

### 4.1 定位與匯出

- **純函式庫**，`scripts/lib/` 下。**不碰 DB、不讀檔、不 import React / Prisma**。輸入是「已讀進記憶體的重算候選名單 + forward-returns」。
- ROADMAP 3.5 明訂：「不依賴 DB、好單測；這些統計本來就不是 SQL aggregate 一句話能算的」。

```ts
export interface CandidatePick {
  date: string;
  code: string;
  score: number;        // breakout=totalScore / accumulation=finalScore
  rank: number;         // 當天在候選名單內的名次
}

export interface ForwardReturnLookup {
  // (date, code) → { retN, benchmarkRetN }；由呼叫端從 forward-returns.jsonl 建
  get(date: string, code: string): {
    ret: Record<number, number | null>;
    benchmarkRet: Record<number, number | null>;
  } | undefined;
}

export interface BacktestStatsOptions {
  horizons: number[];                        // [5, 10, 20]
  topN?: number[];                           // 分層驗證的切點，預設 [10, 30, Infinity]（Infinity = 全候選）
  split?: { trainEnd: string; validStart: string };  // 有給則額外輸出 train / valid 分段
  quarterBuckets?: boolean;                  // 預設 true：按季輸出穩定性
}

export interface HorizonStats {
  n: number;                                 // 納入統計的 (date, code) 數（該 horizon retN 非 null）
  hitRate: number;                           // ret > benchmarkRet 的比例
  avgReturn: number;
  medianReturn: number;
  avgExcessReturn: number;                   // mean(ret - benchmarkRet)
  winRate: number;                           // ret > 0 的比例
  profitFactor: number;                      // Σ 正報酬 / |Σ 負報酬|
  maxDrawdown: number;                       // 按 date 排序、報酬序列累積的最大回撤
}

export interface BacktestStats {
  overall: Record<number, HorizonStats>;             // 每個 horizon 一組
  byTopN: Record<number, Record<number, HorizonStats>>;   // topN 切點 → horizon → stats（單調性檢查）
  byQuarter?: Record<string, Record<number, HorizonStats>>;  // "2025Q1" → horizon → stats
  bySplit?: {
    train: Record<number, HorizonStats>;
    valid: Record<number, HorizonStats>;
  };
  meta: { totalPicks: number; datesCovered: number; horizons: number[] };
}

export function computeBacktestStats(
  picks: CandidatePick[],
  forwardReturns: ForwardReturnLookup,
  options: BacktestStatsOptions,
): BacktestStats;
```

### 4.2 計算細節（ROADMAP 3.5 逐項對應）

1. **命中率**：`ret_N > benchmarkRet_N` 的比例（3.4 明訂「命中判定放 Layer 3 算」）。`benchmarkRet_N` 為 null 的 pick 不納入 `hitRate` 分母（但仍納入 `avgReturn`）。
2. **平均 / 中位數報酬、勝率、賺賠比、最大回撤**：都對「該 horizon `retN` 非 null」的 pick 子集算。`maxDrawdown` = 把 pick 按 `date` 升冪、`retN` 視為一連串獨立部位報酬，算 `cumulative` 曲線的 peak-to-trough 最大跌幅（簡化模型，不是資金加權；PROGRESS 註明這是「等權、不重疊」的粗估）。
3. **按季穩定性**：`date` → `YYYYQn` bucket，每 bucket 一組 `HorizonStats`。避免「只在某段市況特別準」。
4. **按分數分層單調性**：`options.topN = [10, 30, Infinity]` → 每個切點取「每天 rank ≤ N 的 pick」子集算 stats。看 `top10.hitRate ≥ top30.hitRate ≥ all.hitRate` 是否成立（分數高低是否對應報酬高低）。**函式只輸出各層數字，「單調不單調」的判讀留給 UI / 呼叫端**。
5. **訓練 / 驗證分段**：`options.split` 有給 → 用 `date <= trainEnd` / `date >= validStart` 切兩子集，各算一組 `overall`。同一組 `picks` 進來（同一組參數），不做鎖定行為（3.6）。
6. **純函式好處**：全部輸入顯式傳入，`computeBacktestStats` 無副作用，好寫 `*.test.ts`（本批加最小單測，見 §6.3）。

### 4.3 forward-returns 讀取 helper

`backtest-stats.ts` **不讀檔**，但配一個 `scripts/backtest/` 下的 loader：

```ts
// scripts/backtest/load-forward-returns.ts（可被 CLI / action / 測試共用；這支可以讀檔）
export function loadForwardReturns(cachePath?: string): ForwardReturnLookup;
```

讀 `data/backtest-cache/forward-returns.jsonl` 建成 `Map<`${date}|${code}`, ...>` 包成 `ForwardReturnLookup`。

---

## 5. 最小驗證入口（非完整 UI）

ROADMAP 3.7 才做滑桿 / 儀表板。本批只加「能端到端跑一次重算 + 統計並看到數字」的最小入口，證明 Layer 0 → 0.5 → 1/2 → 3 這條鏈通。

### 5.1 Server Actions（`lib/actions/backtest.ts`，加函式）

```ts
// 補齊某區間的 forward-returns cache（spawn build-forward-returns.ts detached 子進程，比照 startLayer0Run）
export async function ensureForwardReturns(input: { start: string; end: string }): Promise<{ started: boolean }>;

// 對某個已完成的 run，用 DEFAULT config（或傳入 override）跑一次完整重算 + 統計，回摘要
export async function runBacktestSummary(input: {
  runId: string;
  configOverride?: unknown;   // DeepPartial<BreakoutConfig | AccumulationConfig>，選填
  horizons?: number[];
}): Promise<BacktestStats>;
```

- `runBacktestSummary` **在 Next.js 進程內同步跑**（讀 `raw-factors/*.jsonl` + `forward-returns.jsonl` → `replayXxxRange` → `computeBacktestStats`）。純記憶體 + 純函式，一個 6 年 run 約幾百個 `.jsonl`、串流讀，預期數秒。**不 spawn 子進程**（跟 Layer 0 不同——Layer 0 慢且查 DB，這個快且純算）。
- `ensureForwardReturns` **spawn 子進程**（可能幾分鐘）：`process.execPath` + `node_modules/tsx/dist/cli.mjs` 絕對路徑 + `build-forward-returns.ts`，`detached` + `unref()`，嚴格照 CLAUDE.md 背景任務模式。

### 5.2 最小 UI（`app/backtest/page.tsx`，擴充現有頁）

- 現有頁已有「觸發 Layer 0 + run 清單 + 進度條」。本批加：
  - run 清單每筆加一顆「跑統計摘要」按鈕 → 呼叫 `runBacktestSummary(runId)` → 底下用 `<pre>` 或簡單表格印 `BacktestStats.overall` + `byTopN`（每 horizon 一列：n / hitRate / avgReturn / medianReturn / profitFactor / maxDrawdown）。
  - 一顆「補 forward-returns cache」按鈕 + 日期輸入 → `ensureForwardReturns`。
- **不做**：滑桿、即時回饋、圖表、個股檢視、版本比較、train/valid 視覺警示。這些是 3.6 / 3.7。
- `export const dynamic = "force-dynamic";` 維持。

### 5.3 驗證範圍

- 本批 UI 驗收只到「按『跑統計摘要』→ 幾秒內畫面出現 hitRate / avgReturn 等數字，且數字與 CLI 直接跑 `_verify-replay` + 手算一致」。

---

## 6. 驗證（本 PLAN 的驗收）

### 6.1 forward-returns cache 正確性

1. **小區間試跑**：`build-forward-returns.ts --start=2026-07-01 --end=2026-07-10`（約 8 基準日）→ 檢查：
   - `forward-returns.jsonl` 行數 == Σ 每個基準日當天全市場一般股票數。
   - 隨機抽 `(2330, 2026-07-01)` → 手動查 DB：`entryClose` == 該日 2330 close；`ret5` == `(2026-07-01 之後第 5 個 2330 交易日 close − entryClose) / entryClose × 100`。
   - `benchmarkRet5` == 0050 用全市場日曆算的同期報酬。
   - 近期上市 / 已下市股：`ret20` == null 而非漏行。
2. **去重**：同指令再跑一次 → `rowsWritten == 0`、`rowsSkipped == 上次的行數`，檔案不變。
3. **`--force`**：改 `--horizons` 或加 `--force` → 對應 `(date, code)` 被重算覆蓋，meta `lastBuiltAt` 更新。
4. **體積**：小區間外推 6 年，確認在 1 GB 內（§2.4 估 460 MB）。

### 6.2 replay 逐位元對齊 screening 腳本（§3.6）

1. 先用現行程式碼重跑 `calculate-breakout-strength.ts --date=2026-08-27` / `calculate-accumulation-score.ts --date=2026-08-26` 覆蓋 `data/*-results/`，當 golden。
2. 跑小段 Layer 0 產出 `2026-08-27` / `2026-08-26` 的 `raw-factors`。
3. `_verify-replay.ts`：讀該日 `raw-factors` → `replayBreakout(rows, DEFAULT_BREAKOUT_CONFIG)`（**不篩池版本**：gate 全放行，只為比對評分）→ 比 golden `results`：
   - `totalScore` / `finalScore` 每檔誤差 < 1e-9。
   - `rank` / `degraded` 完全相同。
   - RS 分數不受 `rsCloseSeries` 緩衝長度影響（截 61 後一致）。
4. **再驗「篩池版本」**：`replayBreakout` 正常套 `gate` → 候選數應等於 golden `results.length`（golden 本來就是篩過的）。
5. `_verify-replay.ts` 驗完刪（PROGRESS 註明）。

### 6.3 統計純函式單測（`scripts/lib/backtest-stats.test.ts`）

- 這是本批唯一新增的正式測試檔（專案目前無測試框架 → 用 `node:test` + `tsx`，`pnpm tsx --test scripts/lib/backtest-stats.test.ts`，PROGRESS 記「首個單測檔，用 node:test」）。
- 案例：
  - 3 個 pick、手算 `hitRate` / `avgReturn` / `medianReturn` / `winRate` / `profitFactor` → 斷言相等。
  - `retN` 有 null 的 pick → 不影響其他 horizon、不進該 horizon 分母。
  - `maxDrawdown`：構造已知累積曲線（+10, −5, +3, −8）→ 斷言回撤值。
  - `byTopN`：5 個 pick、rank 1..5，`topN=[2, Infinity]` → top2 只納 rank ≤ 2。
  - `split`：pick 跨 `trainEnd` → `bySplit.train` / `bySplit.valid` 各自筆數正確。

### 6.4 端到端鏈路

- `runBacktestSummary(runId)` 對 6.2 產的小 run → 回傳 `BacktestStats`，`overall[5].n > 0`、`hitRate ∈ [0,1]`。
- `app/backtest` 按鈕 → 畫面出現統計數字，與 `_verify-replay` + 手算一致。

### 6.5 typecheck / build

- `pnpm exec tsc --noEmit` 對 `scripts/` 零新增錯誤。
- `pnpm build` 通過（`lib/actions/backtest.ts` 新增的 action + `app/backtest/page.tsx` 擴充進 Next bundler 不炸；`backtest-replay.ts` / `backtest-stats.ts` 是純 `scripts/lib/`，被 action import 要確認沒有 Prisma / node-only 副作用連累 bundler）。

---

## 7. 待決小事（實作時當場定）

| 項目 | 選項 | 傾向 |
| --- | --- | --- |
| forward-returns「第 N 天」用該股報價序列 vs 全市場日曆 | 該股 / 日曆 | **該股自己的報價序列**（§1.2：停牌股不誤算）；benchmark 用日曆（0050 不停牌）|
| horizons 預設 | `[5,10]` / `[5,10,20]` / `[5,10,20,60]` | **`[5,10,20]`**（ROADMAP 3.4 明列 5/10/20；`retN` 命名法保留加 60 的空間）|
| `forward-returns.jsonl` 一份全域 vs 每 run 一份 | 全域 / per-run | **全域**（ROADMAP 3.2/3.4 明訂：只跟 date+code 有關，跨策略共用）|
| replay 放 `scripts/lib/backtest-replay.ts` vs 塞進兩個 shared 檔 | 獨立檔 / 分散 | **獨立檔**（它同時 import 兩個 shared 檔 + 跨策略共用 parse / slice 邏輯，塞哪個 shared 都不對稱）|
| stats 的 `maxDrawdown` 模型 | 等權不重疊 / 資金加權 / 不做 | **等權不重疊粗估**（3.5 只要求「最大回撤」指標，精細交易模擬是 3.4 選配、已排除）|
| 單測框架 | `node:test` / vitest / jest | **`node:test` + tsx**（零新依賴，專案已有 tsx）|
| `runBacktestSummary` 同步 vs 背景 | 同步 / spawn | **同步**（純記憶體 + 純函式，數秒）；`ensureForwardReturns` 才 spawn |
| benchmark 除息誤差 | 現在處理 / 記錄待日後 | **記錄待日後**（改抓 `TaiwanStockPriceAdj`；N 日報酬對單次除息不敏感）|

---

## 8. 實作步驟（順序）

1. **`scripts/backtest/build-forward-returns.ts`**：`buildForwardReturns` + CLI + `isMain` guard。每基準日一次 range query 撈「之後 30 日曆日全市場 close」→ 記憶體分組取前 N → append jsonl + 寫 meta。§6.1 小區間試跑 + 手動比對 + 去重 + 體積外推。
2. **`scripts/backtest/load-forward-returns.ts`**：`loadForwardReturns()` → `ForwardReturnLookup`。
3. **`scripts/lib/backtest-replay.ts`**：`parseBreakoutRow` / `parseAccumulationRow`（tuple → 具名）+ `sliceWindows` + `replayBreakout` / `replayAccumulation` + `*Range` 批次版。純 import shared 檔函式。
4. **`scripts/backtest/_verify-replay.ts`（一次性）**：先重跑 screening 腳本覆蓋 golden → 跑小段 Layer 0 → replay 比對（§6.2）。過了就往下，**驗完刪**。
5. **`scripts/lib/backtest-stats.ts`**：`computeBacktestStats` + 型別。逐項對 §4.2 實作（overall / byTopN / byQuarter / bySplit / maxDrawdown）。
6. **`scripts/lib/backtest-stats.test.ts`**：§6.3 五組案例，`pnpm tsx --test` 綠燈。
7. **`lib/actions/backtest.ts`**：加 `ensureForwardReturns`（spawn，照 CLAUDE.md 模式）+ `runBacktestSummary`（同步，讀檔 → replayRange → computeBacktestStats）。
8. **`app/backtest/page.tsx` + client component**：run 清單加「跑統計摘要」按鈕 + 統計數字表格；「補 forward-returns」按鈕 + 日期輸入。
9. **驗證**（§6 全部）：forward-returns 正確性、replay 逐位元、stats 單測、端到端、typecheck、`pnpm build`。
10. **回寫文件**：
    - `CLAUDE.md`：`scripts/backtest/` 段補 `build-forward-returns.ts`（用途、輸出 `data/backtest-cache/forward-returns.jsonl` 格式、第 N 天用該股序列 / benchmark 用日曆、0050 除息誤差、去重機制、horizons）；`scripts/lib/` 段補 `backtest-replay.ts`（Layer 1/2 記憶體重算、tuple parse + 緩衝截斷是唯二格式適配、逐位元對齊 screening 腳本）與 `backtest-stats.ts`（Layer 3 純函式、`computeBacktestStats` 輸出欄位、maxDrawdown 是等權不重疊粗估、首個 `node:test` 單測檔）；「回測系統」段補完整四層資料流現況（0 → 0.5 → 1/2 → 3）。
    - `README.md`：「目前功能」加 `build-forward-returns` + 統計模組；「使用方式」加 `build-forward-returns` 的 CLI 範例與 `--test` 跑單測；前端段補 `/backtest` 的統計摘要按鈕。
    - `docs/PROGRESS.md`：本批（forward-returns cache 設計 + 定義精確化 + 體積實測、replay 正式化 + 逐位元驗證數字、stats 純函式欄位與 maxDrawdown 模型、首個單測檔、`_verify-replay` 已刪、最小 UI 入口、benchmark 除息誤差待日後）。
    - `docs/ROADMAP.md`：3.4（4 項）+ 3.5（5 項）逐項對照打勾；若 3.4 / 3.5 全打完，回覆裡提醒使用者「回測系統剩 3.6 訓練/驗證期切分 + 3.7 UI」。

---

## 9. 驗收清單

- [ ] `scripts/backtest/build-forward-returns.ts` 匯出 `buildForwardReturns`，CLI 支援 `--start` / `--end` / `--horizons` / `--codes` / `--force`；`isMain` guard 讓 import 不觸發 `main()`。
- [ ] `data/backtest-cache/forward-returns.jsonl` 每行 `(date, code)` 一筆，含 `entryClose` / `ret{5,10,20}` / `benchmarkRet{5,10,20}`，round 6 位；不足 N 筆報價的 horizon 記 `null` 而非漏行。
- [ ] forward-returns 的「第 N 天」用**該股自己的報價序列**數；benchmark 用全市場日曆、0050 缺日往後找並記 `benchmarkGapDays`。
- [ ] 命中旗標 / 停損停利**不**寫進 cache（cache 只放策略無關的原始報酬）。
- [ ] 去重：重跑同區間 `rowsWritten == 0`；`--force` 才覆寫。`forward-returns.meta.json` 記 `horizons` / `benchmarkCode` / `coveredDateRange` / `rowCount` / `lastBuiltAt`。
- [ ] 6 年 cache 體積實測在 1 GB 內。
- [ ] `scripts/lib/backtest-replay.ts` 匯出 `replayBreakout` / `replayAccumulation`（+ `*Range`），純 import shared 檔函式，**不 import Prisma、不讀檔**。
- [ ] replay 讀 `raw-factors` 時把緩衝陣列截到 resolved config 視窗長度（`history`→240 / `rsCloseSeries`→61 / `institutional`→20 等）再算。
- [ ] replay 在「套完 gate 篩池」之後才重跑 `rankScore`（breakout RS 母體為全市場例外）。
- [ ] `_verify-replay.ts`：breakout `2026-08-27` / accumulation `2026-08-26`，replay 的 `totalScore` / `finalScore` 每檔與（現行程式碼重跑的）golden 誤差 < 1e-9，`rank` / `degraded` 完全相同；驗完刪。
- [ ] `scripts/lib/backtest-stats.ts` 匯出 `computeBacktestStats`，輸出 `overall` / `byTopN` / `byQuarter` / `bySplit` + 每個 `HorizonStats` 含 `hitRate` / `avgReturn` / `medianReturn` / `avgExcessReturn` / `winRate` / `profitFactor` / `maxDrawdown`；純函式無副作用。
- [ ] `scripts/lib/backtest-stats.test.ts`：≥ 5 組手算案例（含 null 處理、maxDrawdown、byTopN 切點、split 分段），`pnpm tsx --test` 綠燈。
- [ ] `lib/actions/backtest.ts` 的 `ensureForwardReturns` 用 `process.execPath` + `node_modules/tsx/dist/cli.mjs` 絕對路徑 spawn detached + `unref()`；`runBacktestSummary` 同步跑（不 spawn）。
- [ ] `app/backtest/page.tsx`：run 清單「跑統計摘要」按鈕 → 幾秒內顯示 hitRate / avgReturn 等數字，與 `_verify-replay` + 手算一致；「補 forward-returns」按鈕可觸發。
- [ ] `pnpm exec tsc --noEmit` 對 `scripts/` 零新增錯誤；`pnpm build` 通過。
- [ ] 舊行為不變：`run-layer0.ts` / `check-data-completeness.ts` / 兩支 screening 腳本 CLI 輸出照舊。
- [ ] 一次性 `_verify-replay.ts` 已刪。
- [ ] 四份文件（CLAUDE.md / README.md / PROGRESS.md / ROADMAP.md）已同步，ROADMAP 3.4（4 項）+ 3.5（5 項）打勾。

---

## 10. 已知風險 / 待後續 PLAN 處理

| 項目 | 處理時機 |
| --- | --- |
| 訓練/驗證期的顯式解鎖 + 紅色警示 + 驗證期結果自動落地 + 「看一眼就回去調參」的行為約束 | ROADMAP 3.6（本批 `computeBacktestStats` 只**分段輸出** train / valid 統計，不做行為約束）|
| 完整回測 UI（參數滑桿即時回饋 <2s、儀表板圖表、報酬分布直方圖、命中率折線、個股檢視、版本比較）| ROADMAP 3.7 |
| `versions/{name}.json` / `summary/{name}.json`（具名重算結果保留）| Layer 2/3 PLAN |
| 停損停利規則模擬（用後續 OHLC 判斷先觸發停利還停損）| ROADMAP 3.4 選配，優先度低，之後再擴充 |
| benchmark 除息誤差（0050 未還原）/ 加 006208 對照 | 若 benchmark 報酬要更準時改抓 `TaiwanStockPriceAdj` |
| `computeBacktestStats` 的 `maxDrawdown` 精細化（資金加權 / 重疊部位）| 交易策略測試階段（非 ROADMAP 範圍）|
| 用回測框架回頭做第 1 階段的 accumulation 參數校準 | 3.7 UI 齊了之後（ROADMAP 1 與 3.7 最後一項）|
| forward-returns cache 的 GC / 過期策略 | 本批不做，PROGRESS 記「與 `data/backtest-runs/` 同為手動清」|
| `data/*-results/` committed JSON 可能 lag 現行程式碼 | §6.2 已納入（驗證前先重跑覆蓋 golden）|
