# PLAN：腳本參數化（回測前置）

對應 `docs/ROADMAP.md` 第 3.1 節（歷史回測系統的第 1 批前置工作）。這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識請在完成後回寫 `CLAUDE.md`，過程紀錄回寫 `docs/PROGRESS.md`，ROADMAP 3.1 的 `- [ ]` 逐項打勾。

---

## 0. 這一批的邊界

**只做「讓兩支選股純函式吃可覆蓋參數 + 可被 Next.js 安全 import」，不碰回測引擎本身。** Layer 0 基準跑（3.3）、forward-returns cache（3.4）、統計模組（3.5）、回測 UI（3.7）都是後續 PLAN 的事。

這份 PLAN 完成的定義：

1. `calculateAccumulationScore(date, options?)` 與 `calculateBreakoutStrength(date, options?)` 都能接受一個 `options` 參數，內含 `{ prisma?, config? }`：
   - `config` 可覆蓋對應 shared 檔的**所有**可調常數，不傳則回退現有預設。
   - `prisma` 可注入外部的 `PrismaClient` 單例（給 Next.js Server Action 用），不傳則各腳本自建（維持 CLI 現況）。
2. `config` 型別**明確分成「門檻類」與「加權/曲線類」兩個子物件**（分層架構靠這個切）。
3. `check-intraday-breakout.ts` 的 `main()` 拆出一個可被 import 的純函式（目前完全沒匯出）。
4. **預設行為零改變**：同一天用「不傳 config」與「傳等於預設值的 config」跑，輸出 JSON 完全一致（逐位元）。
5. 三支 screening 腳本的**頂層不再有 module-level `new PrismaClient()`**（改成 lazy / 注入），從 Next.js import 不會多開連線池。

**不在範圍**：`config` 的 UI（滑桿面板留給 3.7）、把 config 存檔（`data/backtest-runs/{run-id}/config.json` 留給 3.3）、`breakout-shared.ts` 那些 magic number 全部抽成 config（本 PLAN 只抽「已列為校準對象」的那幾個，其餘評估後決定，見 §4）、Layer 0 需要的「原始因子落地」輸出格式（3.2/3.3）。

---

## 1. 前置事實（已查證，實作時直接採用）

### 1.1 兩支選股腳本現況

- `scripts/screening/calculate-accumulation-score.ts`
  - 匯出 `calculateAccumulationScore(date: Date)`，回傳 `{ date, isNonTradingDay, poolStats }`。
  - 檔尾**已有 `isMain` guard**（`const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;`）→ `import` 不會觸發 `main()` 副作用。
  - **檔案頂層 module-level `new PrismaPg(...)` + `new PrismaClient({ adapter })`**（第 30–31 行）——這是本 PLAN 要處理掉的。
  - 從 `../lib/accumulation-shared.js` import 常數：`INSTITUTIONAL_WINDOW_DAYS` / `SQUEEZE_VOLUME_WINDOW_DAYS` / `BANDWIDTH_HISTORY_MAX_DAYS` / `MIN_AVG_VOLUME_SHARES` / `READINESS_FLOOR` / `NEUTRAL_SCORE` / `CHIP_WEIGHTS` / `TRUST_SUB_WEIGHTS` / `TECH_WEIGHTS` + 純函式。
  - 另從 `../lib/breakout-shared.js` import `computeBase`（壓縮度分數共用）。
  - `writeOutput()` 已內嵌 `params` 區塊（`chipWeights` / `trustSubWeights` / `techWeights` / `readinessFloor` / `squeezeVolumeWindowDays` / `minAvgVolumeShares`）——本 PLAN 要把它擴充成「實際生效的 config」而非「import 進來的預設常數」。

- `scripts/screening/calculate-breakout-strength.ts`
  - 匯出 `calculateBreakoutStrength(date: Date)`，回傳 `{ date, isNonTradingDay, stats }`。
  - 檔尾**已有 `isMain` guard**。
  - **檔案頂層 module-level `new PrismaClient`**（第 27–28 行）——本 PLAN 要處理掉。
  - 從 `../lib/breakout-shared.js` import：`GATES` / `WEIGHTS` / `TRIGGER_VOLUME_RATIO` / `BASE_MAX_WINDOW_DAYS` / `RS_WINDOW_DAYS` + 純函式 + `fetchHistoryWindow`（吃 `prisma` 參數）。
  - 輸出 JSON 已有 `gates` / `weights` 區塊。
  - 內部尚有兩個寫死常數未 import 自 shared：`firstBarLookbackDays = 30`（在函式內）、rankScore 的 `naScore = 50`（多處字面量）。

- `scripts/screening/check-intraday-breakout.ts`
  - **完全沒有匯出**，所有邏輯在私有 `async function main()`。
  - 檔案頂層 module-level `new PrismaClient`。
  - 從 `../lib/breakout-shared.js` import 同一組（`GATES` / `WEIGHTS` / `TRIGGER_VOLUME_RATIO` / ...）。
  - 額外常數：`BATCH_SIZE = 120` / `BATCH_DELAY_MS = 1500` / `MARKET_OPEN_HOUR` 等（MIS 抓取相關，**非選股邏輯參數**，不進 config）。
  - `main()` 裡有 `firstBarLookbackDays = 30`（與收盤版重複）。

### 1.2 shared 檔的可調常數清單

**`scripts/lib/accumulation-shared.ts`**（全部 `export const`）：

| 常數 | 現值 | 類別 |
| --- | --- | --- |
| `INSTITUTIONAL_WINDOW_DAYS` | 20 | 視窗 → **加權/曲線類**（影響聚合值，不影響誰進池） |
| `SQUEEZE_VOLUME_WINDOW_DAYS` | 5 | 視窗 → 加權/曲線類 |
| `BANDWIDTH_HISTORY_MAX_DAYS` | 240 | 視窗 → 加權/曲線類 |
| `MIN_AVG_VOLUME_SHARES` | 500_000 | **門檻類**（決定候選池） |
| `READINESS_FLOOR` | 0.5 | 曲線轉折 → 加權/曲線類 |
| `MIN_INSTITUTIONAL_DAYS_RATIO` | 0.5 | degraded 判定 → 加權/曲線類（邊界情形，見 §3 決策） |
| `MIN_SQUEEZE_VOLUME_DAYS` | 3 | degraded 判定 → 加權/曲線類 |
| `NEUTRAL_SCORE` | 50 | degraded 補分 → 加權/曲線類 |
| `CHIP_WEIGHTS` | `{ trust: 0.7, otherInstitution: 0.3 }` | 加權類 |
| `TRUST_SUB_WEIGHTS` | `{ buyFrequency: 0.5, netRatio: 0.5 }` | 加權類 |
| `TECH_WEIGHTS` | `{ squeeze: 0.5, quietVolume: 0.5 }` | 加權類 |

純函式 `computeReadinessCoefficient` / `combineChipScore` / `combineTrustScore` / `combineFinalScore` / `computeTrustRawMetrics` / `computeOtherInstitutionRatio` / `computeQuietVolumeRatio` **目前直接讀 module-level 常數** → 參數化後要改成「吃傳入的 config」。

**`scripts/lib/breakout-shared.ts`**：

| 常數 | 現值 | 類別 |
| --- | --- | --- |
| `GATES.minMarketCap` | 3_000_000_000 | **門檻類** |
| `GATES.minVolumeShares` | 1_000_000 | **門檻類** |
| `TRIGGER_VOLUME_RATIO` | 2.0 | **門檻類**（觸發條件） |
| `WEIGHTS`（7 項） | 見檔案 | 加權類 |
| `BASE_MIN_HISTORY_DAYS` | 40 | 視窗/degraded → 加權/曲線類 |
| `BASE_MAX_WINDOW_DAYS` | 240 | 視窗 → 加權/曲線類 |
| `PROXIMITY_SHORT_WINDOW` | 60 | 視窗 → 加權/曲線類 |
| `PROXIMITY_LONG_WINDOW` | 240 | 視窗 → 加權/曲線類 |
| `RS_WINDOW_DAYS` | 60 | 視窗 → 加權/曲線類 |
| `BASE_MIN_HISTORY_DAYS` | 40 | （同上，degraded 門檻） |

**內嵌 magic number（§4 評估是否抽出）**：
- `computeVolumeStrength`：`2×→40 分`、`6×→100 分`（線性端點）。
- `computeBreakoutMargin`：`3%` 乖離轉折、轉折後 `每 1% 扣 5 分`、下限 `60`。
- `computeBase`：`depthScore × 0.6 + durationScore × 0.4`、`durationDays / 40` 封頂、p25 門檻。
- `computeCandleShape`：上影線 `40%→40 分`、收盤位置 `40~100`、收黑封頂 `50`、`shadowScore × 0.5 + locScore × 0.5`。
- `computeFirstBar`：連續天數 `≤2 → 50 分`、`>2 → 20 分`。
- `computeProximityScale`：`r ≥ 1 → 100`、`(r − 0.7) / 0.3` 線性、short/long `× 0.5` 各半。
- `computeProximityToHigh` short/long 合成 `× 0.5`。

### 1.3 Next.js 側現況

- `lib/prisma.ts` 已是 `globalThis` 快取的 `PrismaClient` 單例（`import "server-only"` 護欄）。
- `lib/actions/health.ts` 示範 Server Action，目前**只碰 Prisma、不 import 選股函式**（PROGRESS 2026-08-28 記：因為選股腳本頂層 `new PrismaClient()` 會多開連線池，等本 PLAN 解決）。
- 本 PLAN 完成後，Server Action 應能 `import { calculateBreakoutStrength } from "@/scripts/screening/calculate-breakout-strength"` 並傳入 `{ prisma }` 單例——但**實際 UI 串接留給 ROADMAP 4.1**，本 PLAN 只驗證「import 不炸、不多開連線池」。

---

## 2. `config` 型別設計

放在**各自的 shared 檔**（`accumulation-shared.ts` / `breakout-shared.ts`），與該檔常數同處，方便對照。

### 2.1 accumulation

```ts
// scripts/lib/accumulation-shared.ts

/** 門檻類：決定誰進候選池（Layer 1）。回測時調這些要重篩池 → rankScore 要重跑。 */
export interface AccumulationGateConfig {
  minAvgVolumeShares: number; // 預設 500_000
}

/** 加權 / 曲線 / 視窗類：決定分數怎麼組（Layer 2）。調這些不動候選池成員。 */
export interface AccumulationScoreConfig {
  institutionalWindowDays: number;   // 20
  squeezeVolumeWindowDays: number;   // 5
  bandwidthHistoryMaxDays: number;   // 240
  readinessFloor: number;            // 0.5
  minInstitutionalDaysRatio: number; // 0.5
  minSqueezeVolumeDays: number;      // 3
  neutralScore: number;              // 50
  chipWeights: { trust: number; otherInstitution: number };       // 0.7 / 0.3
  trustSubWeights: { buyFrequency: number; netRatio: number };    // 0.5 / 0.5
  techWeights: { squeeze: number; quietVolume: number };          // 0.5 / 0.5
}

export interface AccumulationConfig {
  gate: AccumulationGateConfig;
  score: AccumulationScoreConfig;
}

/** 現行預設。從既有 export const 組出來，數值不變。 */
export const DEFAULT_ACCUMULATION_CONFIG: AccumulationConfig = {
  gate: { minAvgVolumeShares: MIN_AVG_VOLUME_SHARES },
  score: {
    institutionalWindowDays: INSTITUTIONAL_WINDOW_DAYS,
    squeezeVolumeWindowDays: SQUEEZE_VOLUME_WINDOW_DAYS,
    bandwidthHistoryMaxDays: BANDWIDTH_HISTORY_MAX_DAYS,
    readinessFloor: READINESS_FLOOR,
    minInstitutionalDaysRatio: MIN_INSTITUTIONAL_DAYS_RATIO,
    minSqueezeVolumeDays: MIN_SQUEEZE_VOLUME_DAYS,
    neutralScore: NEUTRAL_SCORE,
    chipWeights: CHIP_WEIGHTS,
    trustSubWeights: TRUST_SUB_WEIGHTS,
    techWeights: TECH_WEIGHTS,
  },
};

/** 深層合併：呼叫端只給想改的欄位。 */
export function resolveAccumulationConfig(
  override?: DeepPartial<AccumulationConfig>,
): AccumulationConfig { /* ... */ }
```

- **`export const` 常數全部保留**（`INSTITUTIONAL_WINDOW_DAYS` 等）——`DEFAULT_ACCUMULATION_CONFIG` 從它們組出來，維持「單一數值來源」。純函式改吃 config 後這些常數只剩「組預設」一個用途，但保留可讓 diff 小、也讓別處若有 import 不壞。
- `DeepPartial<T>` 放一個小工具型別（`scripts/lib/` 內共用，或各檔各放一份——見 §7 決策）。
- `resolveAccumulationConfig` 對 `chipWeights` 等巢狀物件做 2 層合併即可（不需要泛型遞迴合併函式，手寫展開更好讀）。

### 2.2 breakout

```ts
// scripts/lib/breakout-shared.ts

export interface BreakoutGateConfig {
  minMarketCap: number;        // 3_000_000_000
  minVolumeShares: number;     // 1_000_000
  triggerVolumeRatio: number;  // 2.0
}

export interface BreakoutScoreConfig {
  weights: {
    candleShape: number; volumeStrength: number; breakoutMargin: number;
    firstBar: number; base: number; proximityToHigh: number; relativeStrength: number;
  };
  baseMinHistoryDays: number;    // 40
  baseMaxWindowDays: number;     // 240
  proximityShortWindow: number;  // 60
  proximityLongWindow: number;   // 240
  rsWindowDays: number;          // 60
  firstBarLookbackDays: number;  // 30（目前寫死在腳本內，順手收進來）
  naScore: number;               // 50（rankScore 缺值補分）
  // §4 決定要不要納入的曲線參數（見該節；預設先不放，留 TODO）
}

export interface BreakoutConfig {
  gate: BreakoutGateConfig;
  score: BreakoutScoreConfig;
}

export const DEFAULT_BREAKOUT_CONFIG: BreakoutConfig = { /* 從 GATES / WEIGHTS / ... 組 */ };

export function resolveBreakoutConfig(override?: DeepPartial<BreakoutConfig>): BreakoutConfig { /* ... */ }
```

### 2.3 純函式簽章改法（統一原則）

**原則：純函式多吃一個 `config` 參數（放最後、必填），不讀 module-level 常數。** 呼叫端（腳本 / 未來回測引擎）負責先 `resolveXxxConfig()` 再傳。

例：

```ts
// before
export function combineChipScore(trustScore: number, otherInstScore: number): number {
  return trustScore * CHIP_WEIGHTS.trust + otherInstScore * CHIP_WEIGHTS.otherInstitution;
}
// after
export function combineChipScore(
  trustScore: number, otherInstScore: number,
  weights: AccumulationScoreConfig["chipWeights"],
): number {
  return trustScore * weights.trust + otherInstScore * weights.otherInstitution;
}
```

- 傳「該函式真正需要的最小片段」（`weights.chipWeights`），不是整包 `AccumulationConfig`——降低耦合、簽章即文件。
- `computeTrustRawMetrics` / `computeOtherInstitutionRatio` / `computeQuietVolumeRatio` 目前用 `INSTITUTIONAL_WINDOW_DAYS` / `MIN_INSTITUTIONAL_DAYS_RATIO` / `SQUEEZE_VOLUME_WINDOW_DAYS` / `MIN_SQUEEZE_VOLUME_DAYS` → 各多吃對應數值。
- `breakout-shared.ts` 的 `computeBase` / `computeProximityToHigh` / `computeMarketWideReturns` 目前用 `BASE_MIN_HISTORY_DAYS` / `PROXIMITY_*` / `RS_WINDOW_DAYS` → 同樣多吃參數。
- `fetchHistoryWindow(prisma, asOfDate, codes, maxDays)` 已經吃 `maxDays` 參數，不用改。

---

## 3. `MIN_INSTITUTIONAL_DAYS_RATIO` / degraded 門檻歸類（決策）

ROADMAP 3.1 要求「明確區分門檻類 vs 加權/曲線類」。有幾個常數性質模糊，這裡定死：

- **`MIN_AVG_VOLUME_SHARES`（accumulation）/ `GATES` / `TRIGGER_VOLUME_RATIO`（breakout）→ 門檻類（`gate`）。** 它們決定「哪些股票進入評分」，回測 Layer 1 靠這層，調它們必須重篩候選池。
- **`MIN_INSTITUTIONAL_DAYS_RATIO` / `MIN_SQUEEZE_VOLUME_DAYS` / `BASE_MIN_HISTORY_DAYS` → 加權/曲線類（`score`）。** 理由：它們不從候選池「剔除」股票，只讓某個**分項**降級成中性分（`NEUTRAL_SCORE`）。股票仍在池內、仍有最終分數、仍參與排名。這是「分數怎麼組」的一部分，歸 Layer 2。
- **視窗天數（`*_WINDOW_DAYS` / `*_MAX_DAYS`）→ 加權/曲線類。** 它們改變聚合值（近 N 日淨買超比例、帶寬歷史百分位），不改變候選池成員資格。**但要在 PROGRESS 註明一個 Layer 0 隱患**：視窗天數若在回測時調大，Layer 0 落地的原始序列長度必須 ≥ 新視窗，否則 Layer 2 重算會截斷。這一點是 3.2/3.3 的事，本 PLAN 只在型別註解寫一句 `// 回測調大此值需確認 Layer 0 序列夠長`。

---

## 4. `breakout-shared.ts` 內嵌 magic number 抽出評估（逐項決策）

ROADMAP 3.1 要求「評估哪些值得抽成 config、哪些維持寫死」。原則：**凡是「肉眼校準時很可能會想調的曲線轉折點」就抽；純粹的實作細節、或改了就違反函式語意的就不抽。** 本 PLAN 的取捨：

| 位置 | 值 | 決策 | 理由 |
| --- | --- | --- | --- |
| `computeVolumeStrength` | `2×→40`, `6×→100` | **抽**（`volumeStrengthCurve: { lowRatio, lowScore, highRatio, highScore }`） | 量比映射是明確的校準對象，2×/6× 是拍腦袋定的 |
| `computeBreakoutMargin` | `3%` 轉折 | **抽**（`breakoutMarginKneePct: number`） | ROADMAP 3.2 明確點名「3% 轉折肉眼校準時很可能想調」 |
| `computeBreakoutMargin` | 轉折後 `每1%扣5分`、下限 `60` | **抽**（`breakoutMarginPenaltyPerPct`, `breakoutMarginFloor`） | 與 knee 同組，一起調才有意義 |
| `computeBase` | `0.6 / 0.4`（depth vs duration） | **抽**（`baseDepthDurationSplit: [number, number]`） | ROADMAP 3.2 點名 |
| `computeBase` | `durationDays / 40` 封頂 | **抽**（`baseDurationCapDays: number`） | 與上面同組 |
| `computeBase` | p25 門檻（`0.25`） | **不抽** | 「低帶寬持續天數」的定義本身，改了語意就變了；且非典型校準對象 |
| `computeCandleShape` | 上影線 `40%`、收黑封頂 `50`、`0.5/0.5` 合成 | **不抽（本批）** | candleShape 權重僅 0.15，投報率低；留 TODO，之後真要調再抽 |
| `computeFirstBar` | 連續天數 `≤2→50`, `>2→20` | **不抽** | 這是離散規則不是曲線；使用者先前明確說「保留這個緩衝、不動 firstBar 邏輯」（PROGRESS 2026-08-27） |
| `computeProximityScale` | `0.7` 下界、short/long `0.5/0.5` | **不抽（本批）** | 留 TODO |
| `rankScore` `naScore = 50` | | **抽進 config**（`naScore`） | 出現在多處字面量，收斂成一個來源比較乾淨 |

**實作方式**：抽出的曲線參數放進 `BreakoutScoreConfig`，給一個 `curves` 子物件裝，`DEFAULT_BREAKOUT_CONFIG` 填現值。純函式簽章多吃對應片段。**不抽的項目在該函式上方加一行 `// TODO(backtest): 若要校準此曲線，抽進 config.score.curves`**，讓後人知道是刻意留的。

> 若實作時發現「抽這幾個曲線參數」讓 diff 過大 / 純函式簽章太長，**退路**：本批先只抽 `computeVolumeStrength` + `computeBreakoutMargin` 兩組（ROADMAP 3.2 唯二點名的），`computeBase` 的 `0.6/0.4` 留 TODO。在 PROGRESS 註明取捨。

---

## 5. `prisma` 注入（消掉 module-level `new PrismaClient()`）

三支 screening 腳本目前都在**檔案頂層**建 client。改法統一：

### 5.1 模式：函式簽章加 `options.prisma`，未傳則 lazy 自建

```ts
// calculate-breakout-strength.ts（accumulation 同理）
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

function makePrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export interface CalculateBreakoutOptions {
  prisma?: PrismaClient;
  config?: DeepPartial<BreakoutConfig>;
}

export async function calculateBreakoutStrength(
  date: Date,
  options: CalculateBreakoutOptions = {},
): Promise<{ date: string; isNonTradingDay: boolean; stats: {...} }> {
  const prisma = options.prisma ?? makePrisma();
  const ownsPrisma = options.prisma === undefined;
  const config = resolveBreakoutConfig(options.config);
  try {
    // ... 原本用 GATES / WEIGHTS 的地方改用 config.gate / config.score
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}
```

- **`ownsPrisma` 旗標**：函式自建的 client 由函式負責 `$disconnect()`；注入的 client（Next.js 單例）**絕不 disconnect**。
- `main()` 改成 `await calculateBreakoutStrength(targetDate)`（不傳 options），其 `finally` 的 `prisma.$disconnect()` 移除（改由函式內部處理）。`main()` 裡查「最新交易日」的那段 `prisma.dailyQuote.findFirst` 需要一個 client → `main()` 自己 `makePrisma()` 一個，或把「找最新交易日」也移進 `calculateX`（傳 `date: Date | null`，null 時內部找最新）。**採後者**：簽章改 `calculateBreakoutStrength(date: Date | "latest", options?)` 或加一個 `resolveTargetDate` helper。→ **決策：保持 `date: Date` 必填，`main()` 自建一次性 client 查最新交易日再傳入**，最小改動、語意清楚。
- `check-intraday-breakout.ts`：把整個 `main()` body 抽成 `export async function checkIntradayBreakout(options?: { prisma?, config?, now?: Date })`，`now` 參數化是為了回測/測試可注入時間（現在寫死 `new Date()`）。`main()` 變成薄殼呼叫它。

### 5.2 為什麼不直接 import `lib/prisma.ts`

`scripts/lib/` 是純 Node 函式庫、不能 `import "server-only"` 的東西。反向依賴（scripts → Next 的 `lib/`）會破壞 `scripts/` 可獨立 `tsx` 執行的前提。所以用**注入**，不是 import。

---

## 6. 預設行為不變的驗證（本 PLAN 的核心驗收）

參數化最大的風險是「重構時悄悄改了計算」。驗證方法：

### 6.1 黃金檔比對

1. **改動前**，先對固定日期跑一次，存基準：
   - `pnpm tsx scripts/screening/calculate-breakout-strength.ts --date=2026-08-27` → 複製 `data/breakout-strength-results/2026-08-27.json` 到 `data/_golden/breakout-2026-08-27.json`。
   - accumulation 同樣對 `2026-08-26`（現有唯一一份輸出的日期）跑並存黃金檔。
   - breakout 另存 `2026-08-18` / `2026-08-21`（已有歷史輸出可直接複製當黃金檔）。
2. **改動後**，同指令重跑，`diff` 新輸出與黃金檔。
   - **`params` / `gates` / `weights` 區塊會變**（從「import 的常數」變成「resolved config」，結構可能不同）——這部分人工確認數值等價即可。
   - **`results` 陣列必須逐位元相同**（順序、每檔每個分數、`totalScore`、`rank`、`degraded`）。
3. 再跑一次「傳等於預設值的 config」：寫一個一次性測試腳本 `scripts/_verify-param-noop.ts`：
   ```ts
   await calculateBreakoutStrength(new Date("2026-08-27"), { config: DEFAULT_BREAKOUT_CONFIG });
   ```
   輸出的 `results` 必須與不傳 config 的版本相同。**這個 `_verify-*` 檔案驗完即刪**（PROGRESS 註明）。

### 6.2 typecheck

- `pnpm exec tsc --noEmit` 對 `scripts/` 零新增錯誤（基準：僅 `prisma.config.ts` 既有錯誤，且該檔已於前一份 PLAN 修成 `?? ""`——確認現在是乾淨的）。

### 6.3 Next.js import 冒煙

- 在 `lib/actions/health.ts` 暫時加：
  ```ts
  import { calculateBreakoutStrength } from "../../scripts/screening/calculate-breakout-strength";
  // 不呼叫，只 import
  ```
  `pnpm build` 通過（確認 `scripts/screening/*` 進 Next bundler 不炸——`generated/prisma` 的 `importFileExtension=""` 已處理過副檔名問題，理論上 OK）。驗完把這行 import 移除（實際串接留給 4.1）。
- **連線池檢查**：`pnpm dev` 起站，`lib/actions/health.ts` 真的呼叫一次 `calculateBreakoutStrength(date, { prisma })`（傳單例），連續觸發 5 次，`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database();` 不持續增長。驗完移除呼叫。

---

## 7. 待決小事（實作時當場定）

| 項目 | 選項 | 傾向 |
| --- | --- | --- |
| `DeepPartial<T>` 型別放哪 | (a) 新增 `scripts/lib/types.ts` 共用；(b) 兩個 shared 檔各放一份 | **(a)**，一行型別不值得重複，且之後回測引擎也會用 |
| `resolve*Config` 合併深度 | 手寫 2 層展開 vs 泛型遞迴 merge | **手寫展開**，config 結構固定且淺，遞迴 merge 難讀又容易在 `exactOptionalPropertyTypes` 下出型別坑 |
| `check-intraday-breakout.ts` 的 `now` 要不要現在就參數化 | 要 / 不要 | **要**（`options.now ?? new Date()`），成本極低，回測會用到 |
| 抽曲線參數的範圍 | §4 全抽 / 只抽 ROADMAP 點名的 2 組 | **先全抽**，撞到 diff 過大再退（§4 退路） |
| `export const` 舊常數要不要刪 | 刪 / 留 | **留**，`DEFAULT_*_CONFIG` 從它們組，維持單一數值來源，diff 也小 |

---

## 8. 實作步驟（順序）

0. **存黃金檔**（§6.1 step 1）：改動任何程式前，先跑現有腳本對 `2026-08-27`（breakout）/ `2026-08-26`（accumulation）產出並複製到 `data/_golden/`。`data/_golden/` 加 `.gitignore`。
1. **`scripts/lib/types.ts`** 新增 `DeepPartial<T>`。
2. **`scripts/lib/accumulation-shared.ts`**：加 `AccumulationConfig` / `DEFAULT_ACCUMULATION_CONFIG` / `resolveAccumulationConfig`；純函式簽章改吃 config 片段（`combineChipScore` / `combineTrustScore` / `computeReadinessCoefficient` / `combineFinalScore` / `computeTrustRawMetrics` / `computeOtherInstitutionRatio` / `computeQuietVolumeRatio`）。舊 `export const` 保留。
3. **`scripts/lib/breakout-shared.ts`**：加 `BreakoutConfig` / `DEFAULT_BREAKOUT_CONFIG` / `resolveBreakoutConfig`；抽 §4 決定要抽的曲線參數；純函式簽章改吃 config 片段（`computeVolumeStrength` / `computeBreakoutMargin` / `computeBase` / `computeProximityToHigh` / `computeMarketWideReturns`）；不抽的加 `// TODO(backtest)` 註解。
4. **`scripts/screening/calculate-accumulation-score.ts`**：
   - 移除頂層 `new PrismaClient`，改 `makePrisma()` + `options.prisma ?? makePrisma()` + `ownsPrisma` finally disconnect。
   - `calculateAccumulationScore(date, options: { prisma?, config? } = {})`。
   - 內部所有讀常數處改讀 `resolveAccumulationConfig(options.config)`。
   - `writeOutput` 的 `params` 區塊改成輸出 resolved config（結構可調整，數值要對）。
   - `main()` 自建一次性 client 查最新交易日，傳入。
5. **`scripts/screening/calculate-breakout-strength.ts`**：同 4 的模式。`firstBarLookbackDays` 收進 config。`naScore` 字面量改讀 config。
6. **`scripts/screening/check-intraday-breakout.ts`**：
   - `export async function checkIntradayBreakout(options: { prisma?, config?, now?: Date } = {})`，body = 原 `main()`。
   - 移除頂層 `new PrismaClient`。
   - `main()` 變薄殼。MIS 抓取常數（`BATCH_SIZE` 等）**不進 config**，維持 module const。
7. **驗證**（§6）：黃金檔 `diff`（`results` 逐位元）、`DEFAULT_*_CONFIG` noop 測試、`tsc --noEmit`、Next import 冒煙 + 連線池檢查。一次性 `_verify-*` 檔驗完刪除。
8. **回寫文件**：
   - `CLAUDE.md`：`scripts/lib/` 段落補「兩個 shared 檔各匯出 `XxxConfig` 型別 + `DEFAULT_XXX_CONFIG` + `resolveXxxConfig`，門檻類走 `gate`、加權/曲線類走 `score`」；screening 段落補「三支選股函式簽章為 `calculateX(date, { prisma?, config? })`，未傳 `prisma` 則自建並自行 disconnect」。
   - `README.md`：若「使用方式」有列選股腳本的 import 用法則更新；CLI 用法不變（`--date=` 照舊）。
   - `docs/PROGRESS.md`：本次改動 + §4 的抽/不抽取捨 + §3 的門檻歸類決策 + 已知 TODO（candleShape / proximity 曲線參數留待之後、視窗天數調大的 Layer 0 隱患）。
   - `docs/ROADMAP.md` 3.1 的 6 個 `- [ ]` 打勾（逐項對照）。

---

## 9. 驗收清單

- [ ] `data/_golden/` 黃金檔已於改動前建立（breakout `2026-08-27` / `2026-08-18` / `2026-08-21`、accumulation `2026-08-26`）。
- [ ] 改動後重跑，各黃金檔的 **`results` 陣列逐位元相同**（順序 / 分數 / `totalScore` / `rank` / `degraded`）。
- [ ] `calculateAccumulationScore(date, { config: DEFAULT_ACCUMULATION_CONFIG })` 與不傳 config 版本輸出 `results` 相同。
- [ ] `calculateBreakoutStrength(date, { config: DEFAULT_BREAKOUT_CONFIG })` 與不傳 config 版本輸出 `results` 相同。
- [ ] 三支 screening 腳本檔案**頂層無 module-level `new PrismaClient()`**（grep 確認）。
- [ ] `calculateX(date, { prisma })` 傳入外部 client 時，函式**不**呼叫該 client 的 `$disconnect()`；不傳時函式自建並於 `finally` disconnect。
- [ ] `check-intraday-breakout.ts` 匯出 `checkIntradayBreakout()`，`main()` 為薄殼。
- [ ] `config` 型別分 `gate`（門檻類：`minAvgVolumeShares` / `minMarketCap` / `minVolumeShares` / `triggerVolumeRatio`）與 `score`（加權/曲線/視窗類）兩子物件。
- [ ] `pnpm exec tsc --noEmit` 對 `scripts/` 零新增錯誤。
- [ ] `lib/actions/health.ts` 暫時 import `calculate-breakout-strength` 後 `pnpm build` 通過（驗後移除 import）。
- [ ] `pnpm dev` 下 Server Action 呼叫 `calculateBreakoutStrength(date, { prisma: 單例 })` 5 次，`pg_stat_activity` 連線數不持續增長（驗後移除呼叫）。
- [ ] CLI 行為不變：`pnpm tsx scripts/screening/calculate-breakout-strength.ts --date=2026-08-27` 與 `... calculate-accumulation-score.ts --date=2026-08-26` 正常輸出到 `data/*-results/`。
- [ ] 一次性 `_verify-*` / 黃金檔比對腳本已刪除；`data/_golden/` 在 `.gitignore`。
- [ ] 四份文件（CLAUDE.md / README.md / PROGRESS.md / ROADMAP.md）已同步，ROADMAP 3.1 六項打勾。

---

## 10. 已知風險 / 待後續 PLAN 處理

| 項目 | 處理時機 |
| --- | --- |
| Layer 0 原始因子落地格式（`raw-factors/{date}.jsonl`）、視窗天數調大時序列長度要夠 | ROADMAP 3.2 / 3.3 |
| `config.json` 落地（run-id、git hash、訓練/驗證期） | ROADMAP 3.3 |
| `computeCandleShape` / `computeProximityScale` 曲線參數抽出 | 之後真要校準時（本 PLAN 留 `// TODO(backtest)`） |
| `check-intraday-breakout.ts` 歷史回測（TPEx 盤中端點限制 → 可能只能對 TWSE 或用收盤近似） | ROADMAP 3.1 最後一項標注、實際回測在 3.3+ |
| 選股函式實際串進 Server Action / 回測引擎 | ROADMAP 4.1 / 回測 PLAN |
| `_poc` 背景任務檔案（`scripts/_poc/` + `lib/actions/poc.ts` + `components/PocRunner.tsx`）刪除 | **本 PLAN 順手刪**（PROGRESS 已記「回測 PLAN 開始時刪」，本批就是回測系列第一份）——見下 |

### 10.1 順手清理 `_poc`

PROGRESS 2026-08-28 記：「`_poc` 整組在下一份回測 PLAN 開始時刪除」。本 PLAN 是回測系列第一份，執行步驟 0 之前先刪：
- `scripts/_poc/`、`lib/actions/poc.ts`、`components/PocRunner.tsx`
- `app/page.tsx` 中引用 `PocRunner` 的部分
- `.gitignore` 的 `/data/_poc/` 可留（無害）
- PROGRESS 註明已刪。

> 若使用者希望 `_poc` 留到真正的 Layer 0 runner PLAN 再刪，此步跳過——實作前用一句話跟使用者確認。
