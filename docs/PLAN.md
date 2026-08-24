# 突破選股評分機制調整計劃

## 背景與目標

現行突破選股腳本（`breakout-shared.ts` / `calculate-breakout-strength.ts` / `check-intraday-breakout.ts`）評分機制存在一個結構性缺陷：所有維度都只用「收盤價」做單點比較，未使用當日 K 棒的 open/high/low，因此無法辨識「爆量突破但收黑或留長上影線」這種賣壓訊號。

本次調整經與使用者討論確認，範圍為：

1. **新增 K 棒型態評分維度**（`candleShape`），放在評分層，不放進觸發層或門檻層。
2. **權重重分配**：採用「方案一：保守等比例縮放」。
3. **修正 `breakoutMargin` 邏輯**：由現行「乖離越大分數越高（封頂）」改為「鐘型曲線」，避免獎勵過度乖離（跳空/追高風險）。
4. **`firstBar` 邏輯維持不動**（使用者刻意保留「已站上軌 3 天以上仍給 20 分」的緩衝，不做剔除）。
5. **`GATES.minMarketCap` 調降至 30 億台幣**；`GATES.minVolumeShares`（1000 張）維持不變。
6. **盤中量能線性外推問題暫不處理**（使用者掃描時間點在中午過後，誤差已大幅緩解，優先度最低，本次不動）。

---

## 任務一：`breakout-shared.ts`

### 1.1 新增 `computeCandleShape` 函式

在檔案中新增以下函式（可放在 `computeBreakoutMargin` 之後）：

```ts
export interface CandleInput {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
}

export function computeCandleShape(
  candle: CandleInput,
): { score: number; degraded: boolean } {
  const { open, high, low, close } = candle;

  if (open === null || high === null || low === null) {
    return { score: 50, degraded: true };
  }

  const range = high - low;
  if (range <= 0) {
    // 一字線（例如鎖漲停無量交易），視為最強型態
    return { score: 100, degraded: false };
  }

  // 上影線分數：無上影線=100分，上影線佔全天振幅40%以上=40分（floor），中間線性
  const upperShadowRatio = (high - Math.max(open, close)) / range;
  const shadowScore = clip(100 - (upperShadowRatio / 0.4) * 60, 40, 100);

  // 收盤位置分數：收在最高點=100分，收在最低點=40分（floor）
  const closeLocation = (close - low) / range;
  const locScore = clip(40 + closeLocation * 60, 40, 100);

  let score = shadowScore * 0.5 + locScore * 0.5;

  // 收黑（綠K）額外懲罰：不論上影線多短，當日表態轉弱是獨立警訊，直接封頂
  if (close < open) {
    score = Math.min(score, 50);
  }

  return { score: clip(score, 0, 100), degraded: false };
}
```

注意事項：
- `degraded: true` 的情境（open/high/low 缺值）沿用既有其他維度的降級風格，分數給 50、不當作扣分，但要記錄進 `degraded` 陣列。
- floor 統一設為 40（跟 `volumeStrength`、`breakoutMargin` 一致），維持整體分數量表風格一致。

### 1.2 更新 `WEIGHTS`

替換為「方案一：保守等比例縮放」的權重（原六項乘 0.85，讓出 0.15 給 candleShape，合計仍為 1.0）：

```ts
export const WEIGHTS = {
  candleShape: 0.15,
  volumeStrength: 0.17,
  breakoutMargin: 0.1275,
  firstBar: 0.17,
  base: 0.17,
  proximityToHigh: 0.1275,
  relativeStrength: 0.085,
};
```

驗收：`Object.values(WEIGHTS).reduce((a,b)=>a+b, 0)` 應約等於 1.0（浮點誤差可接受）。

### 1.3 修正 `computeBreakoutMargin`（鐘型曲線）

將現行：

```ts
export function computeBreakoutMargin(close: number, bollingerUpper: number): number {
  const marginPct = ((close - bollingerUpper) / bollingerUpper) * 100;
  const score = 40 + (marginPct / 3) * (100 - 40);
  return clip(score, 40, 100);
}
```

改為：

```ts
export function computeBreakoutMargin(close: number, bollingerUpper: number): number {
  const marginPct = ((close - bollingerUpper) / bollingerUpper) * 100;
  if (marginPct <= 3) {
    return clip(40 + (marginPct / 3) * 60, 40, 100);
  }
  // 超過3%乖離後，每多1%扣5分，下限60分（避免跟乖離不足的股票混在同一分數帶）
  return clip(100 - (marginPct - 3) * 5, 60, 100);
}
```

### 1.4 調整 `GATES.minMarketCap`

```ts
export const GATES = {
  minMarketCap: 3_000_000_000, // 30 億台幣（原 50 億）
  minVolumeShares: 1_000_000, // 1000 張，維持不變
};
```

---

## 任務二：`calculate-breakout-strength.ts`

### 2.1 `QuoteRow` 介面與 `fetchTodayQuotes`：補上 open/high/low

```ts
interface QuoteRow {
  stockCode: string;
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  volume: number;
  sharesOutstanding: number | null;
}
```

`fetchTodayQuotes` 的 Prisma `select` 需加上 `open: true, high: true, low: true`（欄位名稱請對照實際 schema，若命名不同請對應調整），並在 `.map()` 回傳物件中一併帶出。

### 2.2 匯入 `computeCandleShape`

在檔案頂部的 import 區塊加入：

```ts
import {
  // ...既有 imports
  computeCandleShape,
} from "./breakout-shared.js";
```

### 2.3 `BreakoutResult.scores` 型別新增欄位

```ts
scores: {
  candleShape: number;
  volumeStrength: number;
  breakoutMargin: number;
  firstBar: number;
  base: number;
  proximityToHigh: number;
  relativeStrength: number;
};
```

### 2.4 在 `results` 的 `.map()` 內計算並帶入

在既有 `volumeStrengthScore` / `breakoutMarginScore` 計算附近，新增：

```ts
const candleShapeResult = computeCandleShape({
  open: q.open,
  high: q.high,
  low: q.low,
  close: q.close,
});
if (candleShapeResult.degraded) degraded.push("candleShape");
```

並在 `scores` 物件與 `totalScore` 加總中補上：

```ts
const scores = {
  candleShape: candleShapeResult.score,
  volumeStrength: volumeStrengthScore,
  breakoutMargin: breakoutMarginScore,
  firstBar: firstBarResult.score,
  base: baseResult.score,
  proximityToHigh: proximityResult.score,
  relativeStrength: rs.score,
};

const totalScore =
  scores.candleShape * WEIGHTS.candleShape +
  scores.volumeStrength * WEIGHTS.volumeStrength +
  scores.breakoutMargin * WEIGHTS.breakoutMargin +
  scores.firstBar * WEIGHTS.firstBar +
  scores.base * WEIGHTS.base +
  scores.proximityToHigh * WEIGHTS.proximityToHigh +
  scores.relativeStrength * WEIGHTS.relativeStrength;
```

### 2.5（可選）console.log 表格加一欄

若要在終端機輸出也看到 candleShape 分數，可在表格 header 與資料列中加一欄；非必要，不影響 JSON 輸出，可視需求決定是否做。

---

## 任務三：`check-intraday-breakout.ts`

> 此檔案本次規劃時未能實際檢視內容，僅能依「共用 `breakout-shared.ts`」的架構推斷。實作前請先 `view` 這個檔案，確認以下事項後再套用對應修改：

1. 確認此檔案是否已經在盤中快照中撈取 open/high/low（intraday 版通常會需要「今日開盤價」與「盤中至今最高/最低價」，即使收盤尚未發生）。若沒有，需比照任務二的方式補上。
2. **重要語意差異**：盤中呼叫 `computeCandleShape` 時，`close` 參數應傳入「當下即時價」，`high`/`low` 應為「當日至今的盤中最高/最低」。這代表盤中算出來的 candleShape 分數是「當下這一刻的型態」，收盤前仍可能持續變化（例如尾盤才留下長上影線），跟收盤後 `calculate-breakout-strength.ts` 算出的最終分數不會完全一致，這是預期行為，不需要特別修正，但如果有輸出訊息或註解，建議註明這是「即時型態，收盤前可能變動」，避免使用者誤解為最終分數。
3. 若此檔案也有自己的 `WEIGHTS` 引用或加總邏輯（而非直接 import `breakout-shared.ts` 的 `WEIGHTS`），需要同步套用任務一的權重調整。
4. `GATES.minMarketCap` 若在此檔案有獨立引用，需確認調降至 30 億後生效。

---

## 整體驗收標準

- [ ] `WEIGHTS` 六項加新項共 7 項，總和為 1.0
- [ ] `computeCandleShape` 對 open/high/low 缺值、`high===low`（一字線）、正常紅K、正常綠K、長上影線紅K 等情境的回傳值符合預期（建議寫幾個單元測試或手動 case 驗證）
- [ ] `calculate-breakout-strength.ts` 跑一次後，輸出的 `results.json` 中每筆候選股的 `scores` 物件包含 `candleShape` 欄位，且 `totalScore` 有正確反映新權重
- [ ] `GATES.minMarketCap` 確認為 `3_000_000_000`，`minVolumeShares` 維持 `1_000_000`
- [ ] `computeBreakoutMargin` 對乖離 <3%、=3%、>3%（例如8%）三種情境分數符合鐘型曲線預期（>3%後應遞減，非持續封頂在100）
- [ ] `check-intraday-breakout.ts` 已核對並套用對應修改（若適用）
- [ ] TypeScript 編譯無錯誤（`tsc --noEmit` 或專案既有的 build/lint 指令）

## 本次不處理（保留原狀，供未來參考）

- `firstBar` 連續突破 >2 天的懲罰邏輯（使用者刻意保留 20 分緩衝，不做剔除）
- 盤中預估量能的線性外推偏誤（使用者掃描時間為中午後，優先度最低）