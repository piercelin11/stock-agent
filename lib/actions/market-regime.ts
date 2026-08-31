"use server";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DimensionScore,
  RegimeLabel,
} from "../../scripts/lib/market-regime";

// 大盤濾網 Server Action。PLAN §4。
// 純讀檔：讀 data/market-regime/ 目錄裡檔名最大（日期最新）的 {date}.json，回可序列化物件。
// **不碰 DB**——不 import lib/prisma.ts。
// 只 import type（不 import market-regime.ts 本體，避免把非型別的東西拉進 bundler；
// 比照 intraday.ts 只 import type { CandidateResult } 的做法）。

const REGIME_DIR = join(process.cwd(), "data", "market-regime");

export interface MarketRegimeView {
  available: boolean;
  date: string | null;
  label: RegimeLabel | null;
  totalScore: number | null;
  stage: string | null;
  dimensions: {
    indexPosition: DimensionScore | null;
    ma60Slope: DimensionScore | null;
    breadth: DimensionScore | null;
  };
  advice: string; // 三段對應的部位建議文字（見 4.1）
  generatedAt: string | null;
}

const ADVICE: Record<RegimeLabel, string> = {
  bullish: "大盤偏多，正常執行選股與部位計畫。",
  neutral:
    "大盤中性，建議降低單筆風險預算（例如從 1.5% 調到 1%），選股照跑。",
  bearish:
    "大盤偏空，訊號照看但單筆風險預算建議壓到 0.5–1%；資料持續累積，之後可回頭驗證空頭進場績效。",
};

const UNAVAILABLE_ADVICE =
  "尚無大盤濾網資料（TAIEX 或技術指標未更新）。";

function countDegraded(dims: MarketRegimeView["dimensions"]): number {
  return [dims.indexPosition, dims.ma60Slope, dims.breadth].filter(
    (d) => d !== null && d.degraded,
  ).length;
}

function emptyView(): MarketRegimeView {
  return {
    available: false,
    date: null,
    label: null,
    totalScore: null,
    stage: null,
    dimensions: { indexPosition: null, ma60Slope: null, breadth: null },
    advice: UNAVAILABLE_ADVICE,
    generatedAt: null,
  };
}

export async function getMarketRegime(): Promise<MarketRegimeView> {
  let files: string[];
  try {
    files = await readdir(REGIME_DIR);
  } catch {
    return emptyView(); // 目錄還不存在
  }

  const jsonFiles = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const latest = jsonFiles.at(-1);
  if (!latest) return emptyView();

  let parsed: {
    date: string;
    label: RegimeLabel;
    totalScore: number;
    stage: string;
    dimensions: MarketRegimeView["dimensions"];
    generatedAt?: string;
  };
  try {
    parsed = JSON.parse(await readFile(join(REGIME_DIR, latest), "utf8"));
  } catch {
    return emptyView();
  }

  const dimensions = {
    indexPosition: parsed.dimensions?.indexPosition ?? null,
    ma60Slope: parsed.dimensions?.ma60Slope ?? null,
    breadth: parsed.dimensions?.breadth ?? null,
  };

  let advice = ADVICE[parsed.label] ?? UNAVAILABLE_ADVICE;
  const degraded = countDegraded(dimensions);
  if (degraded > 0) {
    advice += "（部分維度資料不足，判斷僅供參考）";
  }

  return {
    available: true,
    date: parsed.date,
    label: parsed.label,
    totalScore: parsed.totalScore,
    stage: parsed.stage,
    dimensions,
    advice,
    generatedAt: parsed.generatedAt ?? null,
  };
}
