import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SHARES_PER_LOT = 1000;

type Condition =
  | { type: "bollinger_breakout"; direction: "upper" | "lower" }
  | { type: "volume_surge"; multiplier: number }
  | { type: "volume_min"; lots: number }
  | { type: "bandwidth_squeeze"; threshold: number; days: number };

interface Quote {
  close: number;
  change: number;
  volume: bigint;
}

interface Indicator {
  bollingerUpper: number | null;
  bollingerLower: number | null;
  bollingerBandwidth: number | null;
  volumeMa20: number | null;
}

function checkCondition(condition: Condition, quote: Quote, indicator: Indicator): boolean {
  if (condition.type === "bollinger_breakout") {
    if (condition.direction === "upper") {
      return indicator.bollingerUpper !== null && quote.close > indicator.bollingerUpper;
    }
    return indicator.bollingerLower !== null && quote.close < indicator.bollingerLower;
  }
  if (condition.type === "volume_surge") {
    return indicator.volumeMa20 !== null && Number(quote.volume) > indicator.volumeMa20 * condition.multiplier;
  }
  if (condition.type === "volume_min") {
    return Number(quote.volume) >= condition.lots * SHARES_PER_LOT;
  }
  return false;
}

function conditionLabel(condition: Condition): string {
  if (condition.type === "bollinger_breakout") {
    return `bollinger_breakout(${condition.direction})`;
  }
  if (condition.type === "volume_surge") {
    return `volume_surge(x${condition.multiplier})`;
  }
  if (condition.type === "volume_min") {
    return `volume_min(${condition.lots}張)`;
  }
  return `bandwidth_squeeze(<${(condition.threshold * 100).toFixed(0)}%, ${condition.days}天)`;
}

/**
 * 檢查某支股票「最新交易日」是否連續 N 天 bollingerBandwidth < threshold。
 * history 須已按日期新到舊排序，且僅包含該股票的記錄。
 */
function checkBandwidthPersistence(
  history: { bollingerBandwidth: number | null }[],
  threshold: number,
  days: number,
): boolean {
  if (history.length < days) return false;
  for (let i = 0; i < days; i++) {
    const bandwidth = history[i]?.bollingerBandwidth;
    if (bandwidth === null || bandwidth === undefined || bandwidth >= threshold) return false;
  }
  return true;
}

export async function runScreener(): Promise<{ date: string; candidateCount: number } | null> {
  const conditionsPath = join(__dirname, "screener-conditions.json");
  const conditions = JSON.parse(readFileSync(conditionsPath, "utf-8")) as Condition[];

  console.log(`篩選條件: ${conditions.map(conditionLabel).join(" AND ")}`);

  const latest = await prisma.dailyQuote.findFirst({
    orderBy: { date: "desc" },
    select: { date: true },
  });

  if (!latest) {
    console.log("資料庫裡沒有任何 DailyQuote 資料。");
    return null;
  }

  const targetDate = latest.date;
  console.log(`最新交易日: ${targetDate.toISOString().slice(0, 10)}`);

  const quotes = await prisma.dailyQuote.findMany({
    where: { date: targetDate },
    select: {
      stockCode: true,
      close: true,
      change: true,
      volume: true,
      stock: { select: { name: true } },
    },
  });

  const indicators = await prisma.technicalIndicator.findMany({
    where: { date: targetDate },
    select: {
      stockCode: true,
      bollingerUpper: true,
      bollingerLower: true,
      bollingerBandwidth: true,
      volumeMa20: true,
    },
  });
  const indicatorMap = new Map(indicators.map((i) => [i.stockCode, i]));

  const bandwidthConditions = conditions.filter(
    (c): c is Extract<Condition, { type: "bandwidth_squeeze" }> => c.type === "bandwidth_squeeze",
  );
  const maxBandwidthDays = Math.max(0, ...bandwidthConditions.map((c) => c.days));

  const bandwidthHistoryMap = new Map<string, { bollingerBandwidth: number | null }[]>();
  if (maxBandwidthDays > 0) {
    const recentDates = await prisma.technicalIndicator.findMany({
      where: { date: { lte: targetDate } },
      distinct: ["date"],
      orderBy: { date: "desc" },
      take: maxBandwidthDays,
      select: { date: true },
    });
    const fromDate = recentDates[recentDates.length - 1]?.date ?? targetDate;

    const history = await prisma.technicalIndicator.findMany({
      where: { date: { gte: fromDate, lte: targetDate } },
      orderBy: { date: "desc" },
      select: { stockCode: true, bollingerBandwidth: true },
    });
    for (const row of history) {
      const list = bandwidthHistoryMap.get(row.stockCode);
      if (list) {
        list.push(row);
      } else {
        bandwidthHistoryMap.set(row.stockCode, [row]);
      }
    }
  }

  interface Result {
    code: string;
    name: string;
    close: number;
    changePercent: number;
    triggeredConditions: string[];
  }

  const results: Result[] = [];

  for (const quote of quotes) {
    const indicator = indicatorMap.get(quote.stockCode);
    if (!indicator) continue;

    const triggeredConditions: string[] = [];
    let matchesAll = true;

    for (const condition of conditions) {
      const matched =
        condition.type === "bandwidth_squeeze"
          ? checkBandwidthPersistence(
              bandwidthHistoryMap.get(quote.stockCode) ?? [],
              condition.threshold,
              condition.days,
            )
          : checkCondition(condition, quote, indicator);

      if (matched) {
        triggeredConditions.push(conditionLabel(condition));
      } else {
        matchesAll = false;
      }
    }

    if (matchesAll && triggeredConditions.length > 0) {
      const prevClose = quote.close - quote.change;
      const changePercent = prevClose > 0 ? (quote.change / prevClose) * 100 : 0;
      results.push({
        code: quote.stockCode,
        name: quote.stock.name,
        close: quote.close,
        changePercent,
        triggeredConditions,
      });
    }
  }

  results.sort((a, b) => b.changePercent - a.changePercent);

  console.log(`\n符合全部條件的股票: ${results.length} 檔\n`);

  if (results.length > 0) {
    console.log(
      "代號".padEnd(8) + "名稱".padEnd(14) + "收盤價".padEnd(10) + "漲跌幅".padEnd(10) + "觸發條件",
    );
    console.log("-".repeat(70));
    for (const r of results) {
      console.log(
        r.code.padEnd(8) +
          r.name.padEnd(12) +
          r.close.toFixed(2).padEnd(10) +
          `${r.changePercent.toFixed(2)}%`.padEnd(10) +
          r.triggeredConditions.join(", "),
      );
    }
  }

  const outputDir = join(__dirname, "..", "..", "data", "screener-results");
  mkdirSync(outputDir, { recursive: true });
  const dateStr = targetDate.toISOString().slice(0, 10);
  const outputPath = join(outputDir, `${dateStr}.json`);
  writeFileSync(
    outputPath,
    JSON.stringify({ date: dateStr, conditions, results }, null, 2),
  );
  console.log(`\n結果已寫入 ${outputPath}`);

  return { date: dateStr, candidateCount: results.length };
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  runScreener()
    .catch((err) => {
      console.error("篩選執行失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
