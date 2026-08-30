"use server";

import { prisma } from "../prisma";
import {
  calculateBreakoutStrength,
  type BreakoutResult,
} from "../../scripts/screening/calculate-breakout-strength";
import {
  calculateAccumulationScore,
  type AccumulationResult,
} from "../../scripts/screening/calculate-accumulation-score";

export type ScreeningStrategy = "breakout" | "accumulation";

export interface BreakoutRow {
  code: string;
  name: string;
  close: number;
  changePercent: number;
  volumeRatio: number;
  totalScore: number;
  rank: number;
  scores: BreakoutResult["scores"];
  degraded: string[];
}

export interface AccumulationRow {
  code: string;
  name: string;
  close: number;
  chipScore: number;
  readinessCoef: number;
  finalScore: number;
  rank: number;
  breakdown: AccumulationResult["breakdown"];
  detail: AccumulationResult["detail"];
  degraded: string[];
}

export interface ScreeningResult {
  strategy: ScreeningStrategy;
  date: string; // 實際跑的交易日
  isNonTradingDay: boolean;
  stats: Record<string, number>;
  breakoutRows?: BreakoutRow[];
  accumulationRows?: AccumulationRow[];
}

function toBreakoutRow(r: BreakoutResult): BreakoutRow {
  return {
    code: r.code,
    name: r.name,
    close: r.close,
    changePercent: r.changePercent,
    volumeRatio: r.volumeRatio,
    totalScore: r.totalScore,
    rank: r.rank,
    scores: r.scores,
    degraded: r.degraded,
  };
}

function toAccumulationRow(r: AccumulationResult): AccumulationRow {
  return {
    code: r.code,
    name: r.name,
    close: r.close,
    chipScore: r.chipScore,
    readinessCoef: r.readinessCoef,
    finalScore: r.finalScore,
    rank: r.rank,
    breakdown: r.breakdown,
    detail: r.detail,
    degraded: r.degraded,
  };
}

/**
 * 跑最新交易日的選股。`date` 參數預留給日後開歷史查詢，本批 UI 不傳。
 * 同步在 Next.js 進程內 import 呼叫純函式（單日約 1900 檔，秒級）；不 spawn 子進程。
 */
export async function runScreening(input: {
  strategy: ScreeningStrategy;
  date?: string; // YYYY-MM-DD，省略 = 最新交易日
}): Promise<ScreeningResult> {
  const { strategy } = input;

  let dateStr = input.date;
  if (!dateStr) {
    const latest = await prisma.dailyQuote.findFirst({
      where: { stock: { securityType: "stock" } },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (!latest) {
      return {
        strategy,
        date: "",
        isNonTradingDay: true,
        stats: {},
        ...(strategy === "breakout"
          ? { breakoutRows: [] }
          : { accumulationRows: [] }),
      };
    }
    dateStr = latest.date.toISOString().slice(0, 10);
  }

  // 傳前端 Prisma 單例，純函式偵測到 options.prisma !== undefined 時 ownsPrisma=false，不會 $disconnect。
  const target = new Date(dateStr);

  if (strategy === "breakout") {
    const out = await calculateBreakoutStrength(target, { prisma });
    return {
      strategy,
      date: out.date,
      isNonTradingDay: out.isNonTradingDay,
      stats: { ...out.stats },
      breakoutRows: out.results.map(toBreakoutRow),
    };
  }

  const out = await calculateAccumulationScore(target, { prisma });
  return {
    strategy,
    date: out.date,
    isNonTradingDay: out.isNonTradingDay,
    stats: { ...out.poolStats },
    accumulationRows: out.results.map(toAccumulationRow),
  };
}
