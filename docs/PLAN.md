# PLAN 7：觀察股卡片資料跨分類 100% 統一

**一句話**：`/watchlist` 卡片不管落在哪個階段 tab（不管是 `autoStage` 自動判定、還是使用者手動改 `userStage`），
卡片上的所有區塊——法人籌碼區塊、底排因子——都要有完整資料，不再因為「這檔在掃描 JSON 裡是另一個階段」而空白。

**分支**：接續 `feat/watchlist-manual-stage`（PLAN 6 已 commit 在上面），或使用者指定新分支。
**merge 時機等使用者發話。**

**需求來源**：PLAN 6 收尾後的討論（2026-09-03）。使用者觀察到觀察股卡片「強度 PR 全空白」，
追查後確認：`buildCardRow` 按 `stage` 分支只算一半欄位、另一半留 `null` → 前端空白；
且 setup 階段的 `SignalResult.scores` 根本沒寫 `relativeStrength` key。使用者要求「手動換分類後資訊 100% 一致」。

---

## 0. 背景與根因

### 現況：`buildCardRow` 按 stage 分支，只算一半

[lib/actions/watchlist.ts](../lib/actions/watchlist.ts) `buildCardRow()` 在 `if (stage === "setup") { ... } else { ... }`：

| 欄位 | setup 分支 | breakout 分支 |
|---|---|---|
| `preInst`（20 格日曆 + 兩條進度條） | ✅ 算 | ❌ `null` |
| `inst`（法人 diverging bar） | ❌ `null` | ✅ 算 |
| `factors`（距年高、突破幅度、強度 PR） | ❌ `null` | ✅ 算 |

`stage = item.userStage ?? autoStage`。使用者把一檔實際 `autoStage="setup"` 的股票手動改成
`userStage="breakoutDay"` → `stage` 變 `breakoutDay` → 走 else 分支 → 要 `inst` / `factors`，
但這檔在掃描 JSON 裡是 setup 列、`prByCode` 沒有它 → `factors.relativeStrength` = `null` → 卡片「強度 PR」空白。
反方向（breakout 股改 setup）→ 要 `preInst` 的兩條進度條分數（`trustScore` / `otherInstScore`）→
掃描 JSON 的 pre-breakout 名單沒有它 → 進度條無值。

### 三個層次的缺口（討論結論）

1. **值已算好、只是沒帶過去** — `relativeStrength`：`run-signal-scan.ts` 對**全市場 gate 前**算好
   `rsByCode`，但 setup 分支組 `SignalResult.scores` 時沒放這個 key（setup 合成公式不吃 RS）。
   → **補 1 行**（eod + realtime 兩路徑各一）。
2. **值沒算、但輸入資料 `buildCardRow` 手上已有** — `inst` / `factors.proximityLongPct` /
   `factors.breakoutMarginPct`：三個共用 DB 查詢（`indicatorWindow` / `instWindow` / `quoteWindow`）
   **在 `if/else` 之前就撈了、不分 stage**。把計算移出分支即可，**0 新查詢**。
   例外：`otherInstRatio`（外資分子）需要「20 日外資+自營 ÷ 20 日成交量」，`instWindow` 目前只帶
   投信 + `foreignNetBuy`，缺 `dealerNetBuy` 與 20 日量序列 → **小幅擴充查詢**。
3. **值沒算、輸入也要另外撈、且需要全市場母體** — `preInst.trustScore` / `otherInstScore`
   （兩條進度條寬度）：是**全 setup 候選池的 rankScore 百分位**，watchlist 幾檔算不出，只能讀掃描 JSON；
   而突破股不在 setup 母體。→ **要改 `run-signal-scan.ts`**：對 breakout 階段那 ~20 檔也算 accumulation
   籌碼分。因為突破+延續合計才 ~20 檔（vs setup ~495），**成本增加是個位數秒，realtime 掃描不需要為此加嚴 gate**。

### 為什麼「統一欄位」不會簡化 `run-signal-scan.ts`

`totalScore` 的合成公式**按階段本質不同**（setup = 乘法 `chipScore × readinessCoef`；
breakout = 8 分項加權和），這個 `if` 拿不掉。統一的只是「輸出物件多帶哪些欄位」，不是「分數怎麼算」。
`SignalResult` 型別**早已把 `inst` / `factors` / `preInst` 定義成 optional**，
`breakoutExtras()` / `preBreakoutExtras()` 兩個 helper 也都存在——本 PLAN 只是讓它們對「另一階段」也跑。

---

## 1. 邊界

### 動

- **`scripts/screening/run-signal-scan.ts`**
  - eod 路徑（`runEod`，約 L602–L780）+ realtime 路徑（`runRealtime`，約 L1145–L1316）：
    - **setup `scores` 補 `relativeStrength`**（值取 `rsByCode.get(s.code)?.score`）。
    - **breakout 階段補 accumulation 籌碼分**（`trustScore` / `otherInstScore` / `preInst`），
      用「插值不進母體」法（見 §3）。
  - fetch 段：`fetchAccumulationRawInputs` 的 code 清單從 `preCodes` 擴為 `[...preCodes, ...breakoutCodes]`。
  - 新增小 helper `percentileOf(value, sortedPopulation)`（15~20 行，二分查找回百分位）。
  - **`SignalResult` 型別不動**（`inst` / `factors` / `preInst` 已是 optional，且結構相容）。
- **`lib/actions/watchlist.ts`**
  - `buildCardRow()`：**移除 `if (stage === "setup") { ... } else { ... }` 骨架**，
    `inst` / `factors` / `preInst` 三者無條件計算並回傳。
  - `instWindow` 查詢擴充：加 `dealerNetBuy`；另加一個近 20 日 `DailyQuote.volume` 序列查詢
    （或併進既有的 `quoteWindow`，它已 `take: max(SPARK_WINDOW, proximityLongWindow+1)` ≥ 20，
    直接從 `quoteWindow` 取前 20 筆 volume 即可 → **不用新查詢**，確認 `quoteWindow` select 有 `volume`：
    目前 select 是 `{ date, close }`，**需加 `volume`**）。
  - **`WatchlistCardRow` 的 `inst` / `factors` / `preInst` 去掉 `| null`**（見 §4）——
    統一後 `buildCardRow` 每條路徑都給值，型別收緊讓 TS 擋「某路徑漏給」。degraded 情形
    用欄位內部的 `degraded: boolean` 表達，不再整個 null。
- **`lib/latest-scan.ts`**
  - `buildLatestScan()` 建 `preInstByCode` 的 `if (r.stage === "setup")` 守衛**放寬**：
    breakout 階段的 `r` 現在也帶 `preInst`（含 `trustScore` / `otherInstScore`）→ 也要進 `preInstByCode`。
  - `prByCode` 現在 setup 列也有 `relativeStrength` → 自然被收進來，**這行不用改**。
- **`components/signal/PreBreakoutInstitutional.tsx`**
  - `inScan`（`preInst.trustScore !== null`）分支簡化：統一後所有階段的觀察股都有進度條分數，
    「不在掃描名單」的降級文案（L77–L79 tooltip、L85 外資列 `inScan &&` 守衛）保留但預期極少觸發
    （只剩「該檔完全不在最近一次掃描結果」，例如剛加入、掃描還沒跑過）。
- **`components/watchlist/WatchlistCard.tsx`**
  - L113–L119 的「`row.stage === "setup" ? <PreBreakoutInstitutional> : <InstitutionalFlowPanel>`」
    **維持**——這是「醞釀看籌碼累積 / 突破看流向」的刻意設計，兩個元件視覺本就不同。
  - `inst` / `factors` / `preInst` 去 nullable 後，**刪掉冗餘的 null 檢查**：
    - L36–L41 `chip`：`row.inst ? resolveInstChip(row.inst, []) : null` → `resolveInstChip(row.inst, [])`。
    - L113–L119：內層 `row.preInst ? <…> : null` / `row.inst ? <…> : null` 拿掉，直接
      `row.stage === "setup" ? <PreBreakoutInstitutional preInst={row.preInst}/> : <InstitutionalFlowPanel inst={row.inst}/>`。
- **`components/signal/FactorList.tsx`**
  - setup 分支（L27–L33）目前只有「量增」一個 Cell。**維持**——這是 PLAN 3 的刻意決定
    （醞釀中卡片底排不放 K棒/力道/位階）。**本 PLAN 不在 setup 底排加「距年高 / 強度 PR / 突破%」**，
    因為那些對「使用者手動歸類為醞釀」的股票語意仍怪（未突破，突破% 為負）。
    → **底排因子維持按 `row.stage` 分支**；統一的是「法人籌碼區塊」+ `factors` 物件本身有值。
  - breakout 分支（L35–L69）：`const f = row.factors` 去 nullable 後，`f == null || …` /
    `f == null ? "—" : …`（L38、L45–46、L63–64）的 `f == null` 半邊是死碼，簡化成只留
    `f.relativeStrength === null` 的判斷。功能不變。

### 不動

- **`prisma/schema.prisma`**：無 migration。純計算層與前端。
- **`totalScore` 合成 / `rankWithinStages` / gate 門檻**：一律不動。統一欄位 ≠ 改分數。
- **`run-signal-scan.ts` 的 `stats.*`**：`preBreakout` / `breakoutDay` / `extended` 計數語意不變
  （仍是 `results.filter(r => r.stage === ...)`）。
- **`/screening` 頁與 `components/screening/*`**：使用者無法在 screening 頁改股票分類，
  展開列一律按 `SignalResult.stage` 渲染。breakout 列現在多帶 `preInst`、setup 列多帶 `relativeStrength`,
  但 `SignalDetail.tsx` 按 stage 選元件的邏輯不變 → **screening 頁視覺不變**（多出來的欄位它不讀）。
- **加嚴 setup gate（布林帶寬收斂 / close > ma60）**：本 PLAN 明確**不做**。討論確認：那是獨立優化，
  且觀察股豁免 gate，跟本需求無關。要做另開 PLAN。
- **進度條改畫 netRatio 絕對值 / 換手率正規化**：討論過但本 PLAN**不做**（維持全市場 rankScore 百分位）。
  若日後要改視覺，另開 PLAN。

---

## 2. `lib/actions/watchlist.ts` 改法

### 2.1 查詢擴充

`buildCardRow` 開頭 `Promise.all` 內：

- `quoteWindow` 的 `select` 從 `{ date: true, close: true }` → 加 `volume: true`
  （`take` 已 ≥ 20，取前 20 筆當「20 日成交量序列」，新到舊）。
- `instWindow`（`take: PRE_INST_WINDOW` = 20）的 `select` 加 `dealerNetBuy: true`。

→ **0 個新查詢**（都是既有查詢加欄位）。

### 2.2 移除 stage 分支，三者無條件算

現在（L238–L331 概念）：

```ts
let inst = null; let factors = null; let preInst = null;
if (stage === "setup") {
  // 算 preInst（日曆 + 讀 scan 的 trustScore/otherInstScore）
} else {
  // 算 inst（computeInstitutionalFlow）
  // 算 factors（computeProximityToHigh + breakoutMarginPct + prByCode 的 relativeStrength）
}
```

改為：

```ts
// ── preInst（20 格日曆 + 兩條進度條）── 一律算
const trustSeriesNewToOld = instWindow.map(r => Number(r.investmentTrustNetBuy ?? 0));
const foreignPlusDealerNewToOld = instWindow.map(
  r => Number(r.foreignNetBuy ?? 0) + Number(r.dealerNetBuy ?? 0),
);
const vol20NewToOld = quoteWindow.slice(0, PRE_INST_WINDOW).map(q => Number(q.volume));
// 日曆
const dataDays = trustSeriesNewToOld.length;
const buyDayFlags = trustSeriesNewToOld.map(v => v > 0);
// ...consecutiveBuyDays 同現行...
// 分數 / detail：優先讀最近掃描結果（現在 breakout 列也有 preInst → 都讀得到）
const fromScan = scan?.preInstByCode.get(code) ?? null;
// trustNetRatio / otherInstRatio：掃描結果有就用，否則 action 現算
let trustNetRatio = fromScan?.trustNetRatio ?? null;
if (trustNetRatio === null && dataDays >= PRE_INST_MIN_DAYS && sharesOutstanding) {
  trustNetRatio = trustSeriesNewToOld.reduce((s,v)=>s+v,0) / Number(sharesOutstanding);
}
let otherInstRatio = fromScan?.otherInstRatio ?? null;
if (otherInstRatio === null && dataDays >= PRE_INST_MIN_DAYS) {
  const { ratio } = computeOtherInstitutionRatio(
    foreignPlusDealerNewToOld, vol20NewToOld,
    PRE_INST_WINDOW, /* minDaysRatio 用 accumulation.ts 的預設 */,
  );
  otherInstRatio = ratio;
}
preInst = {
  buyDayFlags: buyDayFlags.reverse(),
  buyDays, consecutiveBuyDays, dataDays,
  trustScore: fromScan?.trustScore ?? null,      // 進度條寬度——仍只來自 scan（全市場母體）
  otherInstScore: fromScan?.otherInstScore ?? null,
  trustNetRatio, otherInstRatio,
  degraded: dataDays < PRE_INST_MIN_DAYS,
};

// ── inst（法人 diverging bar）── 一律算
const bollingerUpper = indicatorWindow[0]?.bollingerUpper ?? null;
const trustSeries = instWindow.map(r => Number(r.investmentTrustNetBuy ?? 0));
const foreignSeries = instWindow.map(r => Number(r.foreignNetBuy ?? 0));
const instToday = institutional && isoDate(institutional.date) === refDate ? institutional : null;
const flow = computeInstitutionalFlow({ /* 同現行 */ });
inst = { trustRatio: flow.trustRatio, foreignRatio: flow.foreignRatio,
         todayTrustDir: flow.todayTrustDir, todayForeignDir: flow.todayForeignDir };

// ── factors（距年高 / 突破幅度 / 強度 PR）── 一律算
const closeHistory = quoteWindow.slice(1).map(q => q.close);
const prox = computeProximityToHigh(close, closeHistory, score.proximityShortWindow, score.proximityLongWindow);
const breakoutMarginPct = bollingerUpper && bollingerUpper > 0
  ? ((close - bollingerUpper) / bollingerUpper) * 100 : 0;   // setup 股票此值為負，屬正常
const pr = scan?.prByCode.get(code);
factors = {
  proximityLongPct: prox.longPct,
  breakoutMarginPct,
  relativeStrength: typeof pr === "number" ? pr : null,
  relativeStrengthStale: scan != null && scan.scanDate !== refDate,
};
```

### 2.3 import 補充

`lib/actions/watchlist.ts` 頂部加：

```ts
import { computeOtherInstitutionRatio } from "../../scripts/lib/signal-factors";
```

（`computeInstitutionalFlow` / `computeProximityToHigh` 已 import。`minInstitutionalDaysRatio` 的預設值
從 `scripts/lib/signal-factors` 的 `DEFAULT_ACCUMULATION_CONFIG` 取，或直接沿用 `PRE_INST_MIN_DAYS`
的既有語意 —— 確認 `PRE_INST_MIN_DAYS = ceil(20 * 0.5) = 10` 與 accumulation 的 `minInstitutionalDaysRatio`
一致，一致就直接傳 `PRE_INST_WINDOW` + 讓函式內部用同一 ratio。）

---

## 3. `scripts/screening/run-signal-scan.ts` 改法

### 3.1 setup `scores` 補 `relativeStrength`（eod + realtime）

eod 路徑 `preStaged.forEach` 的 `results.push({ ... scores: { trustScore, otherInstScore, ... } })`：

```ts
scores: {
  trustScore, otherInstScore, squeezeScore, quietVolumeScore, chipScore, readinessCoef,
  relativeStrength: rsByCode.get(s.code)?.score ?? config.breakout.naScore,  // ← 加這行
},
```

realtime 路徑同一處（L1235 附近）同樣加。

- `rsByCode` 在兩條路徑都已對全市場 gate 前算好（eod L473、realtime 對應處）。
- **不影響 `totalScore`**：setup 的 `combineFinalScore(chipScore, readinessCoef)` 不讀 `scores.relativeStrength`。
- `lib/latest-scan.ts` 的 `prByCode` 從 `r.scores["relativeStrength"]` 建 → setup 列自動被收進來。

### 3.2 breakout 階段補 accumulation 籌碼分（插值法）

**目標**：`breakoutDay` / `extended` 的 `SignalResult` 也帶 `preInst`（含 `trustScore` / `otherInstScore`），
讓使用者把突破股手動歸類到「醞釀中」tab 時，`PreBreakoutInstitutional` 的兩條進度條有值。

**母體策略：插值不進母體**（討論結論——避免「百分位語意改變」污染既有 setup 分數）：

1. fetch 段：`fetchAccumulationRawInputs(prisma, date, [...preCodes, ...breakoutCodes], ...)`
   （多 ~20 檔的 20 日投信/外資/量能序列 + 布林帶寬歷史，量小）。
2. setup 迴圈**照舊**：`rankScore` 的母體仍是 `preStaged`（495 檔），
   `trustNetRatioScores` / `otherInstScores` 一如現行。
3. **新增**：把 setup 母體的 `trustRaw.map(t => t.netRatio)`、`otherRaw.map(o => o.ratio)`
   各自 `.filter(非null).sort()` 存成 `sortedTrustNetRatio` / `sortedOtherInstRatio`（升冪）。
4. breakout 迴圈內，對每檔 breakout 股：
   - `computeTrustRawMetrics(accInputs.get(s.code)?.trustNetBuyNewestFirst ?? [], shares, ...)` → `t`
   - `computeOtherInstitutionRatio(fi.foreignPlusDealerNewestFirst, fi.instVolumeNewestFirst, ...)` → `o`
   - `trustScore`：
     - `buyFreqScore` = `percentileOf(t.buyFrequency, sortedTrustBuyFreq)`（同樣 sort setup 的 buyFrequency）
     - `netRatioScore` = `t.netRatio === null ? null : percentileOf(t.netRatio, sortedTrustNetRatio)`
     - `combineTrustScore(buyFreqScore, netRatioScore, pb.trustSubWeights)`
     - `t.degraded` → `pb.neutralScore`（同 setup 邏輯）
   - `otherInstScore` = `o.ratio === null ? pb.neutralScore : percentileOf(o.ratio, sortedOtherInstRatio)`
   - `...preBreakoutExtras(accInputs.get(s.code)?.trustNetBuyNewestFirst ?? [], trustScore, otherInstScore,
      t.netRatio, o.ratio, ceil(pb.institutionalWindowDays * pb.minInstitutionalDaysRatio))`
      加進該 breakout 股的 `results.push({ ... })`。
   - **`totalScore` / `scores`（8 分項）/ `rank` 一律不動**——`preInst` 是純附加回傳欄位。

**語意**：breakout 股拿到的 `trustScore` = 「這檔的投信 20 日買超佔比，若拿去跟今天所有醞釀股比，排第幾百分位」。
正是使用者切到「醞釀中」tab 檢視它時想看的。setup 股的分數一個都沒變。

### 3.3 新 helper `percentileOf`

```ts
/** value 落在已升冪排序的 population 中的百分位（0~100）。population 空 → 回 naScore。 */
function percentileOf(value: number, sortedAsc: number[], naScore: number): number {
  if (sortedAsc.length === 0) return naScore;
  // 二分找第一個 > value 的位置 = 有幾個 <= value
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid]! <= value) lo = mid + 1; else hi = mid;
  }
  return (lo / sortedAsc.length) * 100;
}
```

放在 `run-signal-scan.ts` 檔內（跟 `breakoutTotalScore` 等私有 helper 一起）。
與 `rankScore` 的百分位定義對齊（`rankScore` 是 `(rank+1)/N*100`，`percentileOf` 是 `count(<=v)/N*100`，
語意都是「贏過多少比例」，差一個名次的邊界不影響 UI 呈現）。

### 3.4 `lib/latest-scan.ts`

`buildLatestScan()`：

```ts
for (const r of out.results ?? []) {
  resultByCode.set(r.code, r);
  const rs = r.scores?.["relativeStrength"];
  if (typeof rs === "number") prByCode.set(r.code, rs);   // setup 列現在也命中
  if (r.preInst) {                                        // ← 從「r.stage === setup」改成「有 preInst 就收」
    preInstByCode.set(r.code, {
      trustScore: r.preInst.trustScore ?? null,
      otherInstScore: r.preInst.otherInstScore ?? null,
      trustNetRatio: r.preInst.trustNetRatio ?? null,
      otherInstRatio: r.preInst.otherInstRatio ?? null,
    });
  }
}
```

（現行是讀 `r.scores?.["trustScore"]` 等——改成直接讀 `r.preInst.*`，因為 breakout 的
`r.scores` 是 8 分項、沒有 `trustScore`，但 `r.preInst` 有。setup 的 `r.preInst` 也有，一致。）

---

## 4. 型別收緊

統一後「某階段一定沒有這欄位」的理由消失，收緊讓 TS 擋「`buildCardRow` 漏給」：

- **`lib/actions/watchlist.ts` `WatchlistCardRow`：`inst` / `factors` / `preInst` 從 `X | null` → `X`**。
  - `buildCardRow` 現在每條 return 路徑都給值。degraded 情形用欄位內部的 `degraded: boolean`
    表達，**不再整個 null**——實作時確認每條路徑（含資料嚴重不足）給的是 degraded 骨架而非 `null`。
  - 連帶簡化前端冗餘 null 檢查（見 §1 的 `WatchlistCard.tsx` / `FactorList.tsx` 條目）——
    約 10~15 行，方向是刪死碼、變乾淨，非新增。
- **`SignalResult`（`run-signal-scan.ts`）：`inst` / `factors` / `preInst` 維持 optional**
  —— `/screening` 的 `SignalDetail` 按 stage 只讀其一，且 JSON 體積考量（setup 列不需要
  `factors` 的 6 個突破欄位）。取捨：**JSON 保持精簡，watchlist 缺的那一半由 `buildCardRow` 自己補**。
  唯一新增的是 breakout 列多一個 `preInst`（~10 個小欄位 × ~20 檔，可忽略）。

---

## 5. Commit 切分

單一主題，建議 **1 個 commit**（改動集中、互相依賴——latest-scan 讀的欄位靠 run-signal-scan 產出）：

```
feat: 觀察股卡片跨分類資料統一——buildCardRow 去 stage 分支 + breakout 補醞釀籌碼分
```

若想分兩個：
- commit 1：`run-signal-scan.ts` + `lib/latest-scan.ts`（產資料端：setup 補 RS、breakout 補 preInst）
- commit 2：`lib/actions/watchlist.ts` + 前端元件（消費端：去分支、型別收緊）

---

## 6. 驗證

### 6.1 靜態

- `pnpm exec tsc --noEmit` 乾淨。
- `pnpm tsx --test scripts/lib/signal-factors/factors.test.ts`（既有 31 案不回歸；
  若加 `percentileOf` 單測放這裡或 `run-signal-scan` 旁）。

### 6.2 掃描產出

- `pnpm tsx scripts/screening/run-signal-scan.ts --date=<最近交易日>` 重跑 eod。
- 檢查 `data/signal-scan-results/<date>.json`：
  - 每個 `stage === "setup"` 的 `results[].scores.relativeStrength` 有數字（不再 undefined）。
  - 每個 `stage === "breakoutDay" | "extended"` 的 `results[]` 多了 `preInst` 物件，
    `preInst.trustScore` / `otherInstScore` 是 0~100 數字。
  - `stats` 計數不變、`totalScore` 與改動前逐檔比對**完全一致**（本 PLAN 不動分數）。
    → 用 `git stash` 前後各跑一次 diff `results[].totalScore`。

### 6.3 watchlist 頁（需 dev server，curl 或使用者確認）

- 取一檔實際 `autoStage="setup"` 的觀察股，`/watchlist` 手動點「延續爆發」按鈕改 `userStage`：
  - 卡片切到「延續爆發」tab，法人 diverging bar 有柱、底排「強度 PR」有 `PRxx`、
    「距年高」有 %、「突破」顯示**負** %（如 `-2.3%`，正常——未站上上軌）。
  - 標頭「⚠ 自動判定：醞釀中」chip 仍在。
- 取一檔實際 `autoStage="breakoutDay"` 的觀察股，手動改成「醞釀中」：
  - 卡片切到「醞釀中」tab，`PreBreakoutInstitutional` 的 20 格日曆有格、
    **投信進度條有寬度、外資進度條有寬度**（不再是空的或「不在掃描名單」）。
- 改回原分類 → 卡片內容與改動前一致（無回歸）。

### 6.4 screening 頁（curl 或使用者確認）

- `/screening` 三個 tab 展開列視覺**與改動前一致**（多出來的 JSON 欄位它不讀）。
- 特別確認 breakout 展開列沒有因為多了 `preInst` 而誤渲染醞釀元件。

---

## 7. 風險與回退

| 風險 | 說明 | 對策 |
|---|---|---|
| `totalScore` 意外變動 | 若插值法不小心把 breakout 股塞進 setup 的 `rankScore` 母體 | §6.2 逐檔 diff `totalScore`；插值一定用 `percentileOf`（獨立函式、不 push 進 `rankScore` 輸入陣列） |
| `otherInstRatio` 在 watchlist 現算與掃描不一致 | `buildCardRow` 用 `quoteWindow` 的 `volume` 當分母、掃描用 `instVolumeNewestFirst` | 優先讀 `fromScan?.otherInstRatio`；現算只在該檔不在掃描結果時 fallback，且 tooltip 標「近日資料」 |
| setup 底排要不要加突破因子的爭議 | 使用者可能回頭想要 setup tab 也顯示「距年高 / 強度 PR」 | 本 PLAN `factors` 物件已一律有值，前端 `FactorList` setup 分支加 Cell 是 5 行的事，留給後續 |
| nullable 收緊漏掉某條 return 路徑 | `buildCardRow` degraded 分支給了 `null` 而非 degraded 骨架 → 收緊後編譯報錯（正是要的，但實作時要處理） | 逐條檢查 `buildCardRow` return 路徑；degraded 一律回 `{ ...骨架, degraded: true }` |

**回退**：純計算 + 前端，無 migration。`git revert` 單 commit 即復原；
`data/signal-scan-results/*.json` 重跑一次掃描即回舊格式（setup 無 `relativeStrength`、breakout 無 `preInst`）。

---

## 8. 對 CLAUDE.md / docs 的後續更新（實作完成後）

- **CLAUDE.md**
  - `/watchlist` 頁段落：「醞釀中卡片已無 K棒/力道/位階」保留；新增「`buildCardRow` 不再按 stage
    分支——`inst` / `factors` / `preInst` 一律計算，使用者手動改 `userStage` 後三區塊都有資料」。
  - `SignalResult` 段落：「`preInst?` 只在 setup 有值」→ 改為「setup + breakout 皆有；breakout 的
    `preInst.trustScore` / `otherInstScore` 是對 setup 母體的插值百分位（不進母體、不影響 setup 分數）」。
  - `lib/latest-scan.ts` 段落：`preInstByCode` 來源從「只 setup」→「有 `preInst` 的都收」。
  - `signal-factors` 段落：`run-signal-scan.ts` 新增私有 `percentileOf` helper。
- **docs/PROGRESS.md**：新增「PLAN 7：觀察股卡片跨分類統一」段，記實測（逐檔 `totalScore` diff = 0、
  breakout 股改醞釀 tab 進度條有值的截圖/描述）。
- **docs/ROADMAP.md**：若 ROADMAP 有對應 todo 打勾；無則在 watchlist 相關段補一行。
