# PLAN：Layer 0 基準跑 + 資料完整性檢查（回測第 2 批）

對應 `docs/ROADMAP.md` 第 3.2（檔案輸出格式設計）與 3.3（Layer 0 基準跑 / 批次歷史模擬引擎）。這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識完成後回寫 `CLAUDE.md`，過程紀錄回寫 `docs/PROGRESS.md`，ROADMAP 3.2 / 3.3 的 `- [ ]` 逐項打勾。

前一批（3.1 腳本參數化）已完成：兩支選股純函式 `calculateBreakoutStrength(date, { prisma?, config? })` / `calculateAccumulationScore(date, { prisma?, config? })` 可吃可覆蓋參數 + 可被 Next.js 安全 import，`config` 分 `gate`（門檻類）/ `score`（加權/曲線/視窗類）兩子物件，三支 screening 腳本頂層無 module-level `new PrismaClient()`。

---

## 0. 這一批的邊界

**只做兩件事：**

1. **資料完整性檢查腳本**：一支獨立可跑的 CLI，給定回測區間，掃 `DailyQuote` / `TechnicalIndicator` / `InstitutionalTrading` 三張表的覆蓋率，抓出「整段缺日期」與「單股缺漏」（如 PROGRESS 記載的 4104 只寫 326 筆再補回的那類），回報但**不自動修**。Layer 0 基準跑開跑前先叫這支確認前提成立。

2. **Layer 0 批次歷史模擬引擎**：對回測區間每個交易日，用選股純函式撈 DB 算出**全市場每檔**的「門檻判斷裸值 + rankScore 前的原始聚合值」，寫入 `data/backtest-runs/{run-id}/raw-factors/{date}.jsonl`（一行一檔股票）。**不套任何門檻、不算成品分數、不算 rankScore、不寫 DB。** 同時寫 `config.json`（時間範圍 + 策略 + code 版本）。用背景子進程執行 + 進度寫檔，供之後的回測 UI 輪詢。

**明確不在範圍**（留給後續 PLAN）：

- **Layer 0.5 forward-returns cache**（`data/backtest-cache/forward-returns.jsonl`）→ ROADMAP 3.4，下一批。
- **Layer 1/2/3 記憶體重算**（套門檻 → rankScore → 加權 → 統計）→ ROADMAP 3.5，下一批。
- **回測 UI**（設定頁 / 儀表板 / 個股檢視 / 版本比較）→ ROADMAP 3.7。本批的背景任務只做「Server Action 觸發 + 進度檔輪詢」的最小可驗證骨架，不做滑桿面板。
- **`versions/{name}.json` / `summary/{name}.json`**（使用者主動保留的具名重算結果）→ 那是 Layer 2/3 的產物，本批不碰。
- **訓練/驗證期切分的 UI 警示邏輯** → ROADMAP 3.6。本批 `config.json` 只**記錄** `trainStart/trainEnd/validStart/validEnd` 四個欄位，不做鎖定/解鎖行為。
- **參數校準本身**（accumulation 前段偏大型股）→ 要等 Layer 1/2/3 齊了才能做。

---

## 1. 前置事實（已查證，實作時直接採用）

### 1.1 資料現況（2026-08-28 查 DB / PROGRESS 記載）

| 表 | 筆數 | 區間 | 每日檔數 |
| --- | --- | --- | --- |
| `DailyQuote` | 3,066,466 | 2020-01-02 → 2026-08-28 | 早期約 1808、近期約 1983（一般股票）|
| `TechnicalIndicator` | 3,060,066 | 2020-01-02 起 | 略少於 DailyQuote（前 N 日無 MA/布林）|
| `InstitutionalTrading` | 2,662,485 | 2020-01-02 → 2026-08-28、約 1476 交易日 | 2020≈1808 / 2025≈1983 |

- 三表同起點（2020-01-02），accumulation 與 breakout 回測區間都可拉滿 6 年。
- **已知單股缺漏案例**：4104（東洋）在 6 年回補時一度只有 326 筆 `DailyQuote`，事後用 FinMind 單股重抓補回 1616 筆，技術指標亦用 `calculateTechnicalIndicators(["4104"])` 補算。完整性檢查腳本要能抓出「某股票在區間內的資料筆數顯著少於同期中位數」這類漏。
- `TechnicalIndicator` 是**逐日重算寫入**的（查歷史某天的 `bollingerUpper` / `bollingerBandwidth` / `volumeMa20` 安全），前提是回填涵蓋整個回測區間。
- 交易日曆：專案**無交易日曆表**。判斷「某天是不是交易日」一律以「`DailyQuote` 當天有沒有一般股票資料」為準（`calculate-industry-heat.ts` 的 `recentTradingDates` 已是這個模式：`prisma.dailyQuote.findMany({ distinct: ["date"], orderBy: { date: "desc" } })`）。

### 1.2 兩支選股純函式撈了哪些 DB 資料（Layer 0 要照抄的來源）

**breakout（`calculate-breakout-strength.ts` 的 `runCalculation`）**：

- `fetchTodayQuotes(prisma, date)`：當天全市場 `securityType="stock"` 的 `DailyQuote`（open/high/low/close/change/volume）+ `Stock.name` / `Stock.sharesOutstanding`。
- `fetchIndicatorsForDate(prisma, date, codes)`：當天 `TechnicalIndicator` 的 `bollingerUpper` / `bollingerBandwidth` / `volumeMa20`。
- firstBar：`prevDate`（比 date 早的最近交易日）往回 `firstBarLookbackDays`(=30) 筆的 `DailyQuote.close` + `TechnicalIndicator.bollingerUpper`。
- base + proximityToHigh：`fetchHistoryWindow(prisma, prevDate, codes, baseMaxWindowDays=240)` → 每股 T-1 起往回 240 筆的 `{ date, close, bollingerBandwidth }`。**base 與 proximity 共用這一份**。
- relativeStrength：**全市場** `codes` 近 `rsWindowDays + 1`(=61) 筆 `DailyQuote.close`（含當天）。

**accumulation（`calculate-accumulation-score.ts` 的 `runCalculation`）**：

- `buildCandidatePool`：當天全市場 `DailyQuote`（close）+ `Stock.name` / `sharesOutstanding` + 當天 `TechnicalIndicator`（bollingerUpper / bollingerBandwidth / volumeMa20）。
- `buildFactorInputs`：
  - `InstitutionalTrading`（`lte: date`，新到舊）：`foreignNetBuy` / `investmentTrustNetBuy` / `dealerNetBuy`，逐股截 `institutionalWindowDays`(=20)。
  - `DailyQuote`（`lte: date`，新到舊）：`volume`，用途有二——(a) 其他法人集中度的分母（對齊三大法人日期）、(b) 窒息量近 `squeezeVolumeWindowDays`(=5) 天的 `volume / volumeMa20`。
  - `TechnicalIndicator`（`lt: date`，**不含當日**，新到舊）：`bollingerBandwidth`，逐股截 `bandwidthHistoryMaxDays`(=240)。

### 1.3 rankScore 穿透（3.0 的核心約束，決定 Layer 0 存什麼）

accumulation 四個分項（投信買超頻率 / 投信淨買比 / 其他法人集中度 / 窒息量）與 breakout 的 `relativeStrength`，都是 `rankScore()` 的**跨候選池百分位排名**。候選池成員一變（調 `gate`），每檔百分位就變 → **Layer 2 必須在篩完池後重跑 rankScore**。

因此 **Layer 0 存「rankScore 的輸入」，不存 rankScore 的輸出**：
- 存「投信 20 日淨買超天數比例」的**原始比例值**，不存「它在當時候選池的百分位分數」。
- breakout 的 `relativeStrength` 存**近 61 日報酬率原始值**（`computeMarketWideReturns` 的輸出），不存 `rankScore` 後的分數。

同理，**曲線可校準**（`computeVolumeStrength` 的 2×→40、`computeBreakoutMargin` 的 3% 轉折、`computeBase` 的 0.6/0.4）→ Layer 0 存「量比幾倍、乖離幾 %、bandwidth 陣列」等**曲線的輸入**，不存曲線的輸出分數。存輸出 = 鎖死曲線。

### 1.4 前端 / 背景任務現況

- `lib/prisma.ts`：`globalThis` 快取單例，`import "server-only"` 護欄。
- `lib/actions/health.ts`：唯一的 Server Action 範例（`"use server"` + `import { prisma }`）。
- **背景任務模式已定案（CLAUDE.md「背景任務」段）**，PoC 檔案已於 3.1 刪除，模式為：
  - Server Action `spawn` 一個 detached 子進程 → 子進程每步覆寫 `data/xxx/progress.json` → 另一個 Server Action 輪詢讀檔 → client component `setInterval` poll。
  - `spawn` 用 `process.execPath` + `node_modules/tsx/dist/cli.mjs` **絕對路徑** + 目標腳本當參數，**不要 `pnpm tsx` / `npx tsx`**（detached 子進程解析 launcher 慢）。
  - `.npmrc` 是 `node-linker=hoisted`，`node_modules/tsx/dist/cli.mjs` 是扁平路徑、解析得到。

### 1.5 `data/` 目錄與 `.gitignore`

- 現有 screener 輸出目錄全在 `.gitignore`（`/data/breakout-strength-results/` 等）。
- **本批新增的 `data/backtest-runs/` 與 `data/backtest-cache/` 也要進 `.gitignore`**（用完即丟的實驗資料，ROADMAP 3 明訂不進版控、不進 DB）。

---

## 2. 檔案輸出格式（ROADMAP 3.2 落地）

### 2.1 目錄結構

```
data/backtest-runs/{run-id}/
  config.json                 # 本批產出
  raw-factors/{date}.jsonl    # 本批產出，Layer 0，按交易日分檔，一行一檔股票
  progress.json               # 本批產出，背景任務進度（跑完可留作稽核）
  # 以下留給後續 PLAN，本批不建：
  # versions/{name}.json
  # versions/index.json
  # summary/{name}.json

data/backtest-cache/
  # forward-returns.jsonl     # 留給 ROADMAP 3.4，本批不建
```

**`{run-id}` 格式**：`{strategy}-{YYYYMMDD-HHmmss}`，例 `breakout-20260830-143012` / `accumulation-20260830-143012`。一次跑一個策略一個 run（不合併），理由：兩策略的 `raw-factors` schema 不同（見 §2.3），混在一個 run 只會讓 Layer 1 讀檔要分辨欄位。

### 2.2 `config.json`

```jsonc
{
  "runId": "breakout-20260830-143012",
  "strategy": "breakout",                 // "breakout" | "accumulation"
  "createdAt": "2026-08-30T14:30:12.000Z",
  "range": {
    "start": "2024-01-02",                // 回測區間（含）
    "end": "2026-05-30"                   // 回測區間（含）
  },
  "split": {                              // 僅記錄，本批不做鎖定/解鎖（ROADMAP 3.6）
    "trainStart": "2024-01-02",
    "trainEnd": "2026-02-28",
    "validStart": "2026-03-01",
    "validEnd": "2026-05-30"
  },
  "codeVersion": {
    "gitHash": "42b9e99...",              // execSync("git rev-parse HEAD")，dirty 時加 "-dirty"
    "dirty": false,
    "note": "手動版號，選填"
  },
  "sharedLibHash": "sha256:...",          // 見下：breakout-shared.ts + accumulation-shared.ts + types.ts 內容 hash
  "layer0": {
    "tradingDays": 580,                   // 實際寫出的交易日數
    "completedDays": 580,
    "totalRowsWritten": 1123400,
    "windowConfig": {                     // 記錄 Layer 0 用了多長的視窗抓資料（Layer 2 調視窗不可超過這個）
      "historyWindowDays": 260,
      "rsWindowDays": 61,
      "firstBarLookbackDays": 30
    }
  }
}
```

- **`codeVersion` 很重要**：`raw-factors` 只在「選股純函式本身沒改」時可重用。函式改了要重跑 Layer 0。
- **`sharedLibHash`**：純粹 git hash 不夠——使用者可能改了 `breakout-shared.ts` 但沒 commit。加一個「對 `scripts/lib/{breakout-shared,accumulation-shared,types}.ts` 三個檔內容做 sha256」的欄位，Layer 1/2 讀 run 時可比對「現在的 shared 檔跟產這份 raw-factors 時一不一樣」，不一樣就警告。實作：`createHash("sha256").update(fileA + fileB + fileC).digest("hex")`。
- **`windowConfig`**：Layer 0 抓歷史時，視窗要比 `DEFAULT_*_CONFIG` 的預設**多抓一截**（見 §3.3），把實際抓的長度記進 `config.json`，之後 Layer 2 若把 `baseMaxWindowDays` 調到超過這個值，就知道 raw-factors 序列不夠、要重跑 Layer 0。

### 2.3 `raw-factors/{date}.jsonl`（Layer 0 核心產出）

**共通原則（ROADMAP 3.2）：存「原始輸入值」，不存成品分項分數、不存 rankScore 結果。** 全市場每檔一行（`securityType="stock"`），包含當天有 `DailyQuote` 的所有一般股票，**不預先套任何門檻**。

**每行的共通欄位**：

```jsonc
{
  "date": "2025-03-14",
  "code": "2330",
  "name": "台積電",
  // ---- 門檻判斷裸值（Layer 1 套 gate 用）----
  "close": 875.0,
  "open": 870.0,          // breakout candleShape 需要；accumulation 不需要但一起存無妨
  "high": 878.0,
  "low": 866.0,
  "change": 5.0,
  "volume": 25000000,
  "sharesOutstanding": 25930380458,   // Stock.sharesOutstanding，null 照存 null
  "bollingerUpper": 860.0,            // 當天 TechnicalIndicator
  "bollingerBandwidth": 0.12,         // 當天
  "volumeMa20": 22000000,             // 當天
  "prevClose": 870.0,                 // close - change，changePercent 用（避免 Layer 2 再算一次）
  "prevTradingDate": "2025-03-13"     // T-1 交易日（firstBar / base 視窗的錨點）
}
```

**無損編碼（實作定案，取代原 `{key:val}` 物件陣列）**：2026-08-29 實測，原 PLAN 的 `{ close, bollingerUpper }` / `{ date, close, bollingerBandwidth }` 物件陣列讓 breakout 6 年 raw-factors 達 ~61 GB（估 3.4 GB 的 18 倍），accumulation ~21 GB。改用**位置對齊的 tuple / 純陣列** + **浮點 round 到 6 位小數** + **`history` 不存每筆 `date`**（序列已是「從 `prevTradingDate` 起、新到舊、連續交易日」，`computeBase` / `computeProximityToHigh` 只按位置取值）。純編碼壓縮，**不損失任何可重算能力**（Layer 2 仍可完整校準所有曲線/視窗）。實測降到 breakout ~15 GB / accumulation ~5 GB。

**breakout 專屬欄位**（`strategy === "breakout"` 時追加）：

```jsonc
{
  // firstBar：T-1 起往回 firstBarLookbackDays 筆（新到舊），tuple [close, bollingerUpper]
  "firstBarSeries": [
    [858.0, 861.0],   // [0] = T-1
    [852.0, 859.0],
    // ... 最多 40 筆（§3.3：預設 30 + 緩衝）
  ],
  // base + proximityToHigh 共用：T-1 起往回 historyWindowDays 筆（新到舊），tuple [close, bollingerBandwidth]
  // 不存 date——序列為 prevTradingDate 起連續交易日、新到舊
  "history": [
    [858.0, 0.11],
    // ... 最多 260 筆（§3.3：預設 240 + 緩衝 20）
  ],
  // relativeStrength：這一檔近 rsWindowDays+1 筆 close（含當天，新到舊）。
  // rankScore 是跨全市場的 → Layer 2 讀「全市場每檔的這個陣列」自己算報酬 + rankScore。
  "rsCloseSeries": [875.0, 870.0, 868.0, /* ... 最多 76 筆 */]
}
```

**accumulation 專屬欄位**（`strategy === "accumulation"` 時追加）：

```jsonc
{
  // 三大法人：date 對齊的視窗（新到舊），tuple [trustNetBuy, foreignPlusDealerNetBuy, volume]
  // trustNetBuy = investmentTrustNetBuy；foreignPlusDealerNetBuy = foreignNetBuy + dealerNetBuy
  // volume = 同日 DailyQuote.volume（其他法人集中度的分母，對齊三大法人日期）
  "institutional": [
    [1200000, -300000, 25000000],
    // ... 最多 30 筆（§3.3：預設 20 + 緩衝）
  ],
  // 窒息量：近 squeezeVolumeWindowDays + 緩衝 筆的原始 volume（新到舊），Layer 2 除以當天 volumeMa20
  "recentVolumes": [25000000, 23000000, 21000000, /* ... 最多 15 筆 */],
  // 壓縮度（computeBase）：不含當日、往回 bandwidthHistoryMaxDays + 緩衝 筆的 bandwidth（新到舊）
  "bandwidthHistory": [0.11, 0.115, 0.13, /* ... 最多 260 筆 */]
}
```

- **為什麼 breakout 的 `history` 與 accumulation 的 `bandwidthHistory` 不合併**：breakout 的 `history` 從 **T-1** 起算且要 `close`；accumulation 的 `bandwidthHistory` 從 **當日前一筆**（`lt: date`）起算、只要 `bandwidth`。錨點與欄位都不同，各存各的最清楚。（兩者實際上 T-1 == `lt:date` 的第一筆，但語意來源不同，不強行共用。）
- **`rsCloseSeries` 為什麼每檔都存**：`relativeStrength` 的 rankScore 母體是**全市場**（不是候選池），所以 Layer 0 必須存全市場每一檔的報酬輸入序列，Layer 2 才能重算「這一天全市場的 RS 百分位」。
- **體積退路**（ROADMAP 3.2）：若 `raw-factors` 體積失控，`bandwidthHistory` / `history` 的 240 筆陣列可退成只存兩個中間量（`depthScore` 前的 percentile、`durationDays`），代價是放棄調 `computeBase` 內部邏輯。**本批預設存完整陣列**，只在 PROGRESS 記這條退路。預估體積見 §3.4。

### 2.4 `progress.json`

沿用 CLAUDE.md 背景任務模式的進度檔格式：

```jsonc
{
  "runId": "breakout-20260830-143012",
  "status": "running",          // "pending" | "running" | "done" | "error"
  "phase": "layer0",            // "completeness-check" | "layer0"
  "totalDays": 580,
  "completedDays": 137,
  "currentDate": "2024-07-15",
  "startedAt": "2026-08-30T14:30:12.000Z",
  "updatedAt": "2026-08-30T14:33:40.000Z",
  "error": null,
  "completenessWarnings": [ /* §4 的檢查結果摘要，跑之前先塞這裡 */ ]
}
```

子進程**每寫完一個交易日的 `{date}.jsonl` 就覆寫一次** `progress.json`（原子寫：先寫 `progress.json.tmp` 再 `rename`，避免輪詢讀到半截）。

---

## 3. Layer 0 批次引擎實作

### 3.1 檔案位置與匯出

新增 **`scripts/backtest/run-layer0.ts`**（新資料夾 `scripts/backtest/`，與 `pipeline/` / `screening/` / `backfill/` 平行；`scripts/lib/` 段落與 README、CLAUDE.md 的 `scripts/` 清單一併更新）。

```ts
export interface RunLayer0Options {
  strategy: "breakout" | "accumulation";
  start: string;                 // YYYY-MM-DD
  end: string;                   // YYYY-MM-DD
  split?: { trainEnd: string; validStart: string };  // 選填，只記錄
  prisma?: PrismaClient;
  runId?: string;                // 選填，預設自動生成
  onProgress?: (p: ProgressSnapshot) => void;  // 背景 runner 用；CLI 直接 console
}

export async function runLayer0(options: RunLayer0Options): Promise<{ runId: string; outputDir: string }>;
```

- `main()` 薄殼解析 CLI 參數：`--strategy=breakout --start=2024-01-02 --end=2026-05-30 [--train-end=... --valid-start=...]`。
- **`isMain` guard**（比照現有腳本）：`import` 不觸發 `main()`。
- `prisma` 注入模式比照 3.1：`options.prisma ?? makePrisma()` + `ownsPrisma` finally disconnect。

### 3.2 演算法（逐交易日）

```
1. 解析 range → 查 DB 拿區間內所有「有 DailyQuote 一般股票資料」的 distinct date（升冪）= 交易日清單
2. 生成 runId、寫 config.json（含 git hash / sharedLibHash / windowConfig）
3. 跑資料完整性檢查（§4），結果寫進 progress.json 的 completenessWarnings
   - 若檢查發現「硬性缺漏」（整段日期缺 / 某表在區間內完全沒資料）→ 印錯誤、status=error、中止
   - 只是「單股零星缺漏」→ 印警告、繼續（raw-factors 照樣產，Layer 2 自然會 degraded）
4. for each 交易日 d：
   a. 撈該日 + 歷史視窗資料（§3.3 的抓法，一次撈完該日所有股票）
   b. 逐股組出 raw-factors 行（純資料搬運 + computeMarketWideReturns 這種「非 rankScore」的聚合）
   c. 寫 raw-factors/{d}.jsonl（一行一檔，JSON.stringify 無縮排）
   d. 覆寫 progress.json（completedDays++、currentDate=d）
5. 補齊 config.json 的 layer0 統計欄位、progress.json status=done
```

- **關鍵：Layer 0 不 import 選股純函式的「篩池 / 評分」部分**，只重用它們的「撈 DB + 組視窗序列」邏輯。做法：把 `calculate-breakout-strength.ts` 與 `calculate-accumulation-score.ts` 裡「撈資料 + 組序列」的部分**抽成可共用的 fetch helper**放進對應 shared 檔（見 §3.5），Layer 0 與原腳本都呼叫同一份，確保 Layer 0 撈的資料跟正式跑一致。
- **`computeMarketWideReturns` 例外**：它算的是「近 61 日報酬率」原始值、**不是** rankScore，屬於「rankScore 前的原始聚合值」，可以在 Layer 0 算好存進 `rsReturn` 欄位——**但**為了「視窗可校準」（Layer 2 想改 `rsWindowDays`），還是存**原始 `rsCloseSeries` 陣列**，讓 Layer 2 自己算報酬。§2.3 已採此法。

### 3.3 視窗長度：Layer 0 要比預設多抓「緩衝」

Layer 2 調參時可能把視窗**調大**（`baseMaxWindowDays` 240→280、`institutionalWindowDays` 20→30）。若 Layer 0 只存剛好 240 / 20 筆，Layer 2 一調大就截斷、算錯。

**對策**：Layer 0 抓歷史時，每個視窗在預設值上**加一個固定緩衝**：

| 視窗 | 預設 | Layer 0 實抓 | 緩衝理由 |
| --- | --- | --- | --- |
| `history`（base + proximity，breakout）| 240 | **260** | 留 20 天給 Layer 2 微調 |
| `bandwidthHistory`（accumulation）| 240 | **260** | 同上 |
| `rsCloseSeries` | 61 | **75** | RS 視窗調整空間 |
| `firstBarSeries` | 30 | **40** | firstBar lookback 調整空間 |
| `institutional` | 20 | **30** | 投信視窗調整空間 |
| `recentVolumes` | 5 | **15** | 窒息量視窗調整空間 |

- 緩衝值寫成 `run-layer0.ts` 裡的 `const LAYER0_WINDOW_BUFFER = { history: 260, ... }`，**記進 `config.json` 的 `windowConfig`**。
- Layer 1/2 讀 run 時，若使用者把某視窗 config 調到超過 `windowConfig` 記的值 → UI 應提示「需重跑 Layer 0」（本批不做 UI，只在 `config.json` 留下判斷依據 + 在 PROGRESS 記這個約束）。
- 這些緩衝值**不進 `BreakoutConfig` / `AccumulationConfig`**——它們是 Layer 0 抓取策略，不是選股邏輯參數。

### 3.4 體積估算與驗證

- 粗估：breakout 每行 ≈ `history`(260×3 數字) + `rsCloseSeries`(75) + `firstBarSeries`(40×2) + 共通欄位 ≈ 約 1.2 KB/行（JSON、無縮排）。全市場 ≈ 1950 檔 → 每日 ≈ 2.3 MB。6 年 ≈ 1476 交易日 → **約 3.4 GB**。
- accumulation 每行 ≈ `bandwidthHistory`(260) + `institutional`(30×4) + `recentVolumes`(15) ≈ 約 0.9 KB/行 → 每日 ≈ 1.7 MB → 6 年 ≈ **2.5 GB**。
- **這個量級可接受**（本機硬碟、`.gitignore`、按日分檔可串流讀）。若實測體積比估算大很多 → 啟用 §2.3 的體積退路，PROGRESS 記。
- **實測驗證步驟**：先跑一小段（如 `--start=2026-05-01 --end=2026-05-30`，約 20 交易日），量實際 `du -sh raw-factors/`，外推 6 年，確認在 5 GB 以內再放心跑長區間。

### 3.5 從選股腳本抽出 fetch helper

為確保 Layer 0 撈的資料跟正式跑逐位元一致，把兩支腳本的「撈 DB + 組視窗序列」抽成 shared 檔的匯出函式，**原腳本改呼叫它**（順帶縮短原腳本）。抽出範圍：

**`breakout-shared.ts` 追加**：
- `fetchBreakoutRawInputs(prisma, date, codes, opts)` → 回傳每股的 `{ todayQuote, todayIndicator, firstBarSeries, history, rsCloseSeries }`。內部就是現在 `runCalculation` 第 147–305 行那段（`fetchTodayQuotes` / `fetchIndicatorsForDate` / firstBar 組序列 / `fetchHistoryWindow` / 全市場 RS 序列）。`opts` 帶視窗長度（正式跑傳預設、Layer 0 傳加緩衝的值）。
- `fetchHistoryWindow` 已經是匯出的，`fetchTodayQuotes` / `fetchIndicatorsForDate` 從腳本移進 shared。

**`accumulation-shared.ts` 追加**：
- `fetchAccumulationRawInputs(prisma, date, codes, opts)` → 回傳每股 `{ todayQuote, todayIndicator, institutional, recentVolumes, bandwidthHistory }`。內部是現在 `buildFactorInputs` 那段（去掉 `buildCandidatePool` 的門檻篩選——Layer 0 要全市場）。

**風險控制**：這個抽取會動到兩支已驗證過的腳本。用 3.1 同款的**黃金檔比對**（§6.1）確保 `results` 逐位元不變。

### 3.6 錯誤處理

- 單一交易日撈資料 / 寫檔失敗 → 記進 `progress.json.error`、`status=error`、**中止**（不跳過續跑——Layer 0 要求區間完整，缺一天 Layer 1 串流讀會有洞）。使用者修好後可用 `--resume`（見 §3.7）從斷點續。
- DB 連線中斷：Layer 0 是本機 DB、無網路請求，不接 `http.ts` 的 retry。連線層錯誤直接往外拋、`status=error`。

### 3.7 `--resume`（斷點續跑）

- `run-layer0.ts` 接 `--resume={run-id}`：讀該 run 的 `config.json` 拿 range/strategy，掃 `raw-factors/` 已有哪些 `{date}.jsonl`，跳過已完成的交易日，從第一個缺的接著跑。
- 續跑不重寫 `config.json` 的 range/strategy（但更新 `layer0` 統計、`createdAt` 保留原值、加 `resumedAt`）。
- 續跑前**仍跑一次完整性檢查**（DB 內容可能在中斷期間變過）。

---

## 4. 資料完整性檢查（ROADMAP 3.3 的「這步仍查 DB」）

### 4.1 檔案位置與匯出

新增 **`scripts/backtest/check-data-completeness.ts`**。

```ts
export interface CompletenessReport {
  range: { start: string; end: string };
  tradingDays: number;                    // 區間內有 DailyQuote 的 distinct date 數
  tables: {
    dailyQuote: TableCoverage;
    technicalIndicator: TableCoverage;
    institutionalTrading: TableCoverage;
  };
  missingDates: {                         // 「整段缺日期」：某表在該交易日一筆都沒有
    technicalIndicator: string[];
    institutionalTrading: string[];
    // dailyQuote 不會有（交易日的定義就是它）
  };
  thinStocks: ThinStock[];                // 「單股缺漏」：某股票在區間內筆數 << 同期中位數
  hardFailures: string[];                 // 中止 Layer 0 的理由（空陣列 = 可跑）
}

interface TableCoverage {
  totalRows: number;
  daysWithData: number;                   // 有資料的交易日數
  coverageRatio: number;                  // daysWithData / tradingDays
  medianRowsPerDay: number;
}

interface ThinStock {
  code: string;
  table: "dailyQuote" | "technicalIndicator" | "institutionalTrading";
  actualDays: number;
  expectedDays: number;                   // 該股上市後、區間內的交易日數
  ratio: number;
}

export async function checkDataCompleteness(
  range: { start: string; end: string },
  options?: { prisma?: PrismaClient },
): Promise<CompletenessReport>;
```

### 4.2 檢查邏輯

1. **交易日母體**：`DailyQuote` distinct date（`securityType="stock"`）在區間內 → `tradingDays`。
2. **整段缺日期**：對 `TechnicalIndicator` / `InstitutionalTrading` 各查 distinct date，跟交易日母體做差集 → `missingDates`。
   - `TechnicalIndicator` 早期會少幾天（前 N 日算不出 MA20/布林）——**區間 start 前 60 個交易日內的缺不算 hard failure**，只列出。區間中段整段缺才是 hard failure。
   - `InstitutionalTrading` PROGRESS 記載 2020-01-02 起就有，區間中段整段缺 → hard failure。
3. **單股缺漏（`thinStocks`）**：
   - 每股在區間內的「應有交易日數」= 該股第一筆 `DailyQuote` 之後、區間內的交易日數（處理「區間中途才上市」的新股，不誤報）。
   - 每股實際筆數 / 應有筆數 < **0.9** → 列入 `thinStocks`（4104 那種 326/1616 ≈ 0.2 會被抓到）。
   - 對三張表各算一次。
   - `thinStocks` **不是 hard failure**（Layer 2 會自然 degraded），但要在 progress 明顯列出，讓使用者決定要不要先補。
4. **`hardFailures`** 觸發條件（任一即中止 Layer 0）：
   - 任一表 `coverageRatio < 0.95`（區間內大範圍缺）。
   - `missingDates` 有落在「區間 start + 60 交易日」之後的日期。
   - 交易日母體 < 20（區間太短或 DailyQuote 本身沒資料）。

### 4.3 CLI

`pnpm tsx scripts/backtest/check-data-completeness.ts --start=2024-01-02 --end=2026-05-30` → 印報告（表格 + 缺漏清單），有 hard failure 時 exit 1。**獨立可跑**，也被 `run-layer0.ts` 在開跑前呼叫。

---

## 5. 背景任務骨架（最小可驗證，非完整 UI）

ROADMAP 3.3 要求「Server Action 觸發 → 背景 worker 逐日跑 → 寫進度檔 → UI 輪詢」。本批只做能驗證這條鏈路的最小骨架，**滑桿面板 / 儀表板留給 3.7**。

### 5.1 Server Actions（`lib/actions/backtest.ts`，新檔）

```ts
"use server";

// 觸發：spawn detached 子進程跑 run-layer0.ts，立刻回 runId
export async function startLayer0Run(input: {
  strategy: "breakout" | "accumulation";
  start: string;
  end: string;
}): Promise<{ runId: string }>;

// 輪詢：讀 data/backtest-runs/{runId}/progress.json
export async function getLayer0Progress(runId: string): Promise<ProgressSnapshot | null>;

// 列出已有的 run（讀 data/backtest-runs/ 目錄 + 各 config.json）
export async function listBacktestRuns(): Promise<RunSummary[]>;
```

- `startLayer0Run` 的 spawn 嚴格照 CLAUDE.md 模式：
  ```ts
  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(process.cwd(), "scripts", "backtest", "run-layer0.ts");
  const child = spawn(process.execPath, [tsxCli, script,
    `--strategy=${strategy}`, `--start=${start}`, `--end=${end}`],
    { detached: true, stdio: "ignore" });
  child.unref();
  ```
- runId 需在 spawn **之前**就決定（傳給子進程 `--run-id=`），這樣 action 能立刻回傳；子進程用這個 runId 建目錄。
- **不注入 prisma**：子進程是獨立 Node process，自己 `makePrisma()`（Layer 0 是純 DB 讀、跑幾分鐘，跟 Next.js 連線池無關）。

### 5.2 最小 UI（`app/backtest/page.tsx`，新路由）

- `layout.tsx` 側邊欄已有「Backtest」佔位連結（PROGRESS 2026-08-28 記），本批讓它指向 `/backtest`。
- 頁面：策略下拉 + start/end 日期輸入 + 「開始 Layer 0 基準跑」按鈕 + 進度條（`"use client"` component，`setInterval` 每 2s 呼叫 `getLayer0Progress`）+ 已有 run 清單。
- `export const dynamic = "force-dynamic";`（比照 `app/page.tsx`，這頁會讀檔/查 DB）。
- **不做**：參數滑桿、Layer 1/2/3 重算、儀表板圖表、個股檢視。這頁純粹是「觸發 Layer 0 + 看它跑完」。

### 5.3 驗證範圍

- 本批的 UI 驗收只到「按按鈕 → 子進程起來 → 進度條從 0 跑到 100% → run 清單出現這筆」。
- 連線池檢查：`startLayer0Run` 被連續呼叫 5 次（起 5 個子進程），Next.js 進程的 `pg_stat_activity` 連線數不增長（子進程各自的連線與 Next.js 無關，子進程結束即釋放）。

---

## 6. 驗證（本 PLAN 的驗收）

### 6.1 選股腳本行為不變（§3.5 抽 helper 的風險控制）

沿用 3.1 的黃金檔手法：

1. **抽 helper 前**，對 breakout `2026-08-18` / `2026-08-21` / `2026-08-27`、accumulation `2026-08-26` 用現有程式碼跑，複製輸出到 `data/_golden/`。
2. **抽完後**同指令重跑，`results` 陣列**逐位元相同**（順序 / 每檔每分項 / `totalScore` / `rank` / `degraded`）。
3. `data/_golden/` 加 `.gitignore`，驗完刪。

### 6.2 Layer 0 輸出正確性

1. **小區間試跑**：`--strategy=breakout --start=2026-08-15 --end=2026-08-27`（約 9 交易日）→ 檢查：
   - `raw-factors/` 每個交易日一個 `.jsonl`，行數 == 當天 `DailyQuote` 一般股票數。
   - 隨機抽一檔（如 2330 在 `2026-08-27`）→ 手動比對 `close` / `bollingerUpper` / `history[0].close` 與直接查 DB 一致。
   - `history` 陣列長度 == min(260, 該股可用歷史天數)；`institutional` == min(30, ...)。
2. **交叉驗證 Layer 0 ↔ 正式跑**：寫一次性腳本 `scripts/backtest/_verify-layer0.ts`：
   - 對 `2026-08-27` 讀 `raw-factors/2026-08-27.jsonl`，在**記憶體**套 breakout 的 `gate` + 七項評分函式 + rankScore（等於預先實作一小段 Layer 1/2，不落地），比對 `data/breakout-strength-results/2026-08-27.json` 的 `results`。
   - **允許差異**：`rsCloseSeries` 截斷長度（Layer 0 存 75、正式跑用 61）不影響 61 日報酬值 → `relativeStrength` 分數應一致。
   - `totalScore` 每檔誤差 < 1e-9。
   - **這個 `_verify-*` 驗完即刪**（PROGRESS 註明）。這一步實際上就是下一批 Layer 1/2 的雛形，先用來確認 Layer 0 存的資料「夠算出正確結果」。
3. **完整性檢查抓漏能力**：對已知有 4104 缺漏歷史的區間（若 DB 現在 4104 已補齊，則人工在測試 DB 刪掉 4104 某段 `TechnicalIndicator` 模擬）→ 確認 `thinStocks` 列出 4104。**若不方便造資料**，至少驗證「區間內某新上市股（第一筆 DailyQuote 在區間中段）不會被誤報為 thinStock」。

### 6.3 typecheck

- `pnpm exec tsc --noEmit` 對 `scripts/` 零新增錯誤（基準：`prisma.config.ts` 已於前批修成 `?? ""`，現況乾淨）。
- `pnpm build` 通過（新增的 `app/backtest/page.tsx` + `lib/actions/backtest.ts` 進 Next bundler 不炸）。

### 6.4 背景任務鏈路

- `pnpm dev` 起站 → `/backtest` 按鈕觸發 `--start=2026-08-20 --end=2026-08-27` → 進度條 0→100% → run 出現在清單。
- `progress.json` 原子寫（輪詢期間不會讀到 JSON parse error）。
- 子進程連線數不影響 Next.js（§5.3）。

---

## 7. 待決小事（實作時當場定）

| 項目 | 選項 | 傾向 |
| --- | --- | --- |
| `raw-factors` 一檔一天 vs 一檔整個 run | 按日 / 單檔 | **按日**（ROADMAP 3.2 已定：Layer 1 串流逐日讀、換區間只補新日期、避免單一巨檔）|
| `sharedLibHash` 涵蓋哪些檔 | 只 shared 兩檔 / 加 types.ts / 加 screening 三支 | **shared 兩檔 + types.ts**（螢幕腳本改了也要重跑，但它們的核心邏輯都在 shared；先涵蓋 shared，screening 腳本靠 git hash + dirty 旗標）|
| Layer 0 抽 helper 放 shared 檔 vs 新 `scripts/lib/backtest-fetch.ts` | shared / 新檔 | **放各自的 shared 檔**（fetch 邏輯與該策略的常數同處，跟 3.1 把 config 放 shared 同理）|
| 完整性檢查 `thinStock` 門檻 | 0.8 / 0.9 / 0.95 | **0.9**（4104 的 0.2 遠低於任何門檻；0.9 對「偶爾停牌幾天」的正常股容忍度夠）|
| `--strategy` 一次跑一個 vs 兩個一起 | 一個 / 兩個 | **一個**（§2.1：兩策略 raw-factors schema 不同，分 run 乾淨）|
| 背景 runner 進度回報 | 寫檔輪詢 / SSE / WebSocket | **寫檔輪詢**（CLAUDE.md 已定案的模式，不引入新機制）|
| `data/backtest-runs/` 是否隨 run 數量清理 | 手動 / 自動保留 N 份 | **手動**（本批不做 GC，PROGRESS 記「run 目錄需手動清」）|

---

## 8. 實作步驟（順序）

0. **存黃金檔**（§6.1 step 1）：改任何程式前，先跑現有 breakout `2026-08-18/21/27`、accumulation `2026-08-26` 存到 `data/_golden/`。`data/_golden/` 加 `.gitignore`。
1. **`.gitignore`**：加 `/data/backtest-runs/`、`/data/backtest-cache/`。
2. **`scripts/lib/breakout-shared.ts`**：抽出 `fetchTodayQuotes` / `fetchIndicatorsForDate`（從腳本移入）+ 新 `fetchBreakoutRawInputs(prisma, date, codes, { historyWindowDays, rsWindowDays, firstBarLookbackDays })`。
3. **`scripts/lib/accumulation-shared.ts`**：抽出 `fetchAccumulationRawInputs(prisma, date, codes, { institutionalWindowDays, squeezeVolumeWindowDays, bandwidthHistoryMaxDays })`（從 `buildFactorInputs` 抽，去掉門檻篩選）。
4. **`scripts/screening/calculate-breakout-strength.ts` / `calculate-accumulation-score.ts`**：改呼叫新 helper，`runCalculation` 對應段落刪除。**跑 §6.1 黃金檔比對**，`results` 逐位元一致才往下。
5. **`scripts/backtest/check-data-completeness.ts`**：`checkDataCompleteness` + CLI。單獨測 `--start=2024-01-02 --end=2026-05-30` 印報告。
6. **`scripts/backtest/run-layer0.ts`**：`runLayer0` + CLI + `isMain` guard + `--resume`。逐日撈 helper → 組 raw-factors 行 → 寫 jsonl + progress.json（原子寫）。開跑前呼叫 `checkDataCompleteness`。
7. **§6.2 小區間試跑 + `_verify-layer0.ts` 交叉驗證**（breakout `2026-08-27`），確認 Layer 0 存的資料算得出正確 `results`。`_verify-*` 驗完刪。§3.4 體積實測（跑 20 交易日量 `du -sh`）。
8. **`lib/actions/backtest.ts`**：`startLayer0Run` / `getLayer0Progress` / `listBacktestRuns`，spawn 嚴格照 CLAUDE.md 模式。
9. **`app/backtest/page.tsx` + client 進度條 component**：策略/日期輸入 + 觸發按鈕 + 輪詢進度條 + run 清單。`layout.tsx` 的「Backtest」連結指向 `/backtest`。
10. **驗證**（§6 全部）：黃金檔、Layer 0 正確性、typecheck、`pnpm build`、`pnpm dev` 背景鏈路、連線池。
11. **回寫文件**：
    - `CLAUDE.md`：新增 `scripts/backtest/` 段落（`run-layer0.ts` / `check-data-completeness.ts` 的用途、輸出路徑、視窗緩衝約束）；`scripts/lib/` 段補「兩 shared 檔各新增 `fetchXxxRawInputs` helper，Layer 0 與正式跑共用」；「回測系統」段補 Layer 0 檔案格式（`data/backtest-runs/{run-id}/` 結構、raw-factors 存原始值不存 rankScore/成品分數的原則、視窗緩衝機制）。
    - `README.md`：「目前功能」加 `scripts/backtest/` 兩支；「使用方式」加 `check-data-completeness` 與 `run-layer0` 的 CLI 範例；前端段補 `/backtest` 頁。
    - `docs/PROGRESS.md`：本批改動（helper 抽出 + 黃金檔驗證、完整性檢查邏輯與門檻、Layer 0 引擎 + 檔案格式 + 視窗緩衝 + 體積實測數字、背景任務骨架、`_verify-layer0` 已刪、run 目錄需手動清、§2.3 體積退路）。
    - `docs/ROADMAP.md`：3.2 的 5 項 + 3.3 的 3 項 `- [ ]` 逐項對照打勾。

---

## 9. 驗收清單

- [ ] `data/_golden/` 黃金檔於抽 helper 前建立；抽完後 breakout `2026-08-18/21/27`、accumulation `2026-08-26` 的 `results` 陣列**逐位元相同**。
- [ ] `scripts/lib/breakout-shared.ts` 匯出 `fetchBreakoutRawInputs`，`scripts/lib/accumulation-shared.ts` 匯出 `fetchAccumulationRawInputs`；兩支 screening 腳本改呼叫 helper，原撈資料段落已移除。
- [ ] `scripts/backtest/check-data-completeness.ts` 匯出 `checkDataCompleteness`，CLI 對 6 年區間印出三表覆蓋率 + `missingDates` + `thinStocks`，有 hard failure 時 exit 1。
- [ ] 完整性檢查：4104 那類單股缺漏會列入 `thinStocks`；區間中途上市的新股**不**被誤報。
- [ ] `scripts/backtest/run-layer0.ts` 匯出 `runLayer0`，CLI 支援 `--strategy` / `--start` / `--end` / `--train-end` / `--valid-start` / `--resume` / `--run-id`；`isMain` guard 讓 import 不觸發 `main()`。
- [ ] Layer 0 開跑前呼叫 `checkDataCompleteness`，hard failure 時 `status=error` 中止。
- [ ] `data/backtest-runs/{run-id}/` 產出 `config.json`（含 git hash + dirty 旗標 + `sharedLibHash` + `windowConfig`）、`raw-factors/{date}.jsonl`（每交易日一檔、行數 == 當天一般股票數）、`progress.json`（原子寫）。
- [ ] `raw-factors` 每行**只存原始輸入值**（門檻裸值 + 視窗序列 + `rsCloseSeries`），**不含**成品分項分數、**不含** rankScore 結果。
- [ ] Layer 0 視窗實抓長度 > 預設（`history` 260 / `rsCloseSeries` 75 / `institutional` 30 等），且記進 `config.json.windowConfig`。
- [ ] `_verify-layer0.ts`：讀 `raw-factors/2026-08-27.jsonl` 在記憶體套 gate + 評分 + rankScore，`totalScore` 每檔與 `data/breakout-strength-results/2026-08-27.json` 誤差 < 1e-9（驗完刪）。
- [ ] `--resume={run-id}` 從第一個缺的交易日續跑，不重寫 range/strategy。
- [ ] §3.4 體積：20 交易日試跑實測 `du -sh`，外推 6 年在 5 GB 以內（否則啟用體積退路並記 PROGRESS）。
- [ ] `lib/actions/backtest.ts` 的 `startLayer0Run` 用 `process.execPath` + `node_modules/tsx/dist/cli.mjs` 絕對路徑 spawn detached 子進程 + `unref()`，**不用** `pnpm tsx`；runId 在 spawn 前決定。
- [ ] `app/backtest/page.tsx` + client 進度條：按鈕觸發 → 進度條 0→100% → run 清單出現該筆；`export const dynamic = "force-dynamic"`。
- [ ] `pnpm exec tsc --noEmit` 對 `scripts/` 零新增錯誤；`pnpm build` 通過。
- [ ] `pnpm dev` 下 `startLayer0Run` 連續 5 次，Next.js 進程 `pg_stat_activity` 連線數不持續增長。
- [ ] CLI 舊行為不變：`calculate-breakout-strength.ts --date=` / `calculate-accumulation-score.ts --date=` 照舊輸出到 `data/*-results/`。
- [ ] `data/_golden/`、一次性 `_verify-layer0.ts` 已刪；`.gitignore` 加了 `/data/backtest-runs/` + `/data/backtest-cache/`。
- [ ] 四份文件（CLAUDE.md / README.md / PROGRESS.md / ROADMAP.md）已同步，ROADMAP 3.2（5 項）+ 3.3（3 項）打勾。

---

## 10. 已知風險 / 待後續 PLAN 處理

| 項目 | 處理時機 |
| --- | --- |
| Layer 0.5 forward-returns cache（`data/backtest-cache/forward-returns.jsonl`）、benchmark 報酬 | ROADMAP 3.4（下一批）|
| Layer 1/2/3 記憶體重算（套門檻 → rankScore → 加權 → 統計純函式 `computeBacktestStats`）| ROADMAP 3.5（下一批）|
| 完整的回測 UI（參數滑桿即時回饋 <2s、儀表板圖表、個股檢視、版本比較）| ROADMAP 3.7 |
| 訓練/驗證期的鎖定/解鎖 + 紅色警示 + 驗證期結果自動落地 | ROADMAP 3.6（本批只在 config.json 記錄四個日期欄位）|
| `versions/{name}.json` / `summary/{name}.json`（具名重算結果保留）| Layer 2/3 PLAN |
| Layer 2 視窗調到超過 `windowConfig` 記錄值時的「需重跑 Layer 0」提示 | ROADMAP 3.7（本批只在 config.json 留判斷依據）|
| `raw-factors` 體積退路（`bandwidthHistory` 退成 depthPercentile + durationDays 兩中間量）| 若 §3.4 實測體積失控時啟用；否則留 PROGRESS 記錄 |
| `data/backtest-runs/` 的 GC / 保留策略 | 本批不做，PROGRESS 記「手動清」|
| `check-intraday-breakout` 的歷史回測（TPEx 盤中端點限制）| ROADMAP 3.1 已標注，非本批 |
```
