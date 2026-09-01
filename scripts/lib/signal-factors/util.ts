// 統一因子庫共用小工具。原本 breakout-shared.ts / accumulation-shared.ts 各有一份
// 一字不差的 clip / rankScore，目錄化時合併到這裡，其餘檔案一律從這裡拿。

export function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// cross-sectional percentile rank，0~100。lowerIsBetter=true 時數值越小排名分數越高。
// naScore：該欄位缺值時給的預設分數。
export function rankScore(
  values: (number | null)[],
  lowerIsBetter: boolean,
  naScore: number,
): number[] {
  const validEntries = values
    .map((v, i) => ({ v, i }))
    .filter((e): e is { v: number; i: number } => e.v !== null && !Number.isNaN(e.v));

  if (validEntries.length === 0) {
    return values.map(() => naScore);
  }

  const sorted = [...validEntries].sort((a, b) => (lowerIsBetter ? b.v - a.v : a.v - b.v));

  const result = new Array<number>(values.length).fill(naScore);
  for (let rank = 0; rank < sorted.length; rank++) {
    const percentile = ((rank + 1) / sorted.length) * 100;
    result[sorted[rank]!.i] = percentile;
  }
  return result;
}
