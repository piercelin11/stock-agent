import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

// 回測資料完整性檢查（ROADMAP 3.3 的「這步仍查 DB」）。
// 給定回測區間，掃 DailyQuote / TechnicalIndicator / InstitutionalTrading 三張表的覆蓋率，
// 抓出「整段缺日期」與「單股缺漏」，回報但不自動修。
// 獨立可跑（CLI），也被 run-layer0.ts 在開跑前呼叫。

function makePrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---- degraded 判定與 hard failure 門檻（PLAN §4.2）----
const HARD_FAILURE_COVERAGE_RATIO = 0.95; // 任一表覆蓋率低於此值 → 中止
const HARD_FAILURE_WARMUP_TRADING_DAYS = 60; // 區間 start 前 N 個交易日內的缺不算 hard failure（TechnicalIndicator 暖身期）
const THIN_STOCK_RATIO = 0.9; // 單股實際筆數 / 應有筆數 低於此值 → 列入 thinStocks
const MIN_TRADING_DAYS = 20; // 交易日母體低於此值 → 中止

export interface TableCoverage {
  totalRows: number;
  daysWithData: number; // 有資料的交易日數
  coverageRatio: number; // daysWithData / tradingDays
  medianRowsPerDay: number;
}

export interface ThinStock {
  code: string;
  table: "dailyQuote" | "technicalIndicator" | "institutionalTrading";
  actualDays: number;
  expectedDays: number; // 該股第一筆 DailyQuote 之後、區間內的交易日數
  ratio: number;
}

export interface CompletenessReport {
  range: { start: string; end: string };
  tradingDays: number;
  tables: {
    dailyQuote: TableCoverage;
    technicalIndicator: TableCoverage;
    institutionalTrading: TableCoverage;
  };
  missingDates: {
    technicalIndicator: string[];
    institutionalTrading: string[];
  };
  thinStocks: ThinStock[];
  hardFailures: string[]; // 空陣列 = 可跑
}

interface DateRow {
  date: Date;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export async function checkDataCompleteness(
  range: { start: string; end: string },
  options: { prisma?: PrismaClient; minTradingDays?: number } = {},
): Promise<CompletenessReport> {
  const prisma = options.prisma ?? makePrisma();
  const ownsPrisma = options.prisma === undefined;
  try {
    return await run(prisma, range, options.minTradingDays ?? MIN_TRADING_DAYS);
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

async function run(
  prisma: PrismaClient,
  range: { start: string; end: string },
  minTradingDays: number,
): Promise<CompletenessReport> {
  const start = new Date(range.start);
  const end = new Date(range.end);

  // ---- 1. 交易日母體：DailyQuote distinct date（securityType="stock"）在區間內 ----
  const tradingDateRows: DateRow[] = await prisma.dailyQuote.findMany({
    where: { date: { gte: start, lte: end }, stock: { securityType: "stock" } },
    distinct: ["date"],
    orderBy: { date: "asc" },
    select: { date: true },
  });
  const tradingDates = tradingDateRows.map((r) => r.date);
  const tradingDaySet = new Set(tradingDates.map((d) => d.getTime()));
  const tradingDays = tradingDates.length;

  const hardFailures: string[] = [];

  // 交易日母體太小 → 直接中止（後面的統計沒意義）。minTradingDays 可由呼叫端放寬（小區間驗證跑）。
  if (tradingDays < minTradingDays) {
    hardFailures.push(
      `交易日母體僅 ${tradingDays} 天（< ${minTradingDays}）：區間太短或 DailyQuote 本身缺資料`,
    );
  }

  // ---- 2. 各表的 distinct date 與每日筆數 ----
  const [dqCoverage, tiCoverage, itCoverage] = await Promise.all([
    tableCoverage(prisma, "dailyQuote", start, end, tradingDaySet, tradingDays),
    tableCoverage(prisma, "technicalIndicator", start, end, tradingDaySet, tradingDays),
    tableCoverage(prisma, "institutionalTrading", start, end, tradingDaySet, tradingDays),
  ]);

  // ---- 3. 整段缺日期：交易日母體 − 各表 distinct date ----
  const missingTechnicalIndicator = tradingDates
    .filter((d) => !tiCoverage.dateSet.has(d.getTime()))
    .map(toIsoDate);
  const missingInstitutionalTrading = tradingDates
    .filter((d) => !itCoverage.dateSet.has(d.getTime()))
    .map(toIsoDate);

  // 暖身期：區間 start 前 HARD_FAILURE_WARMUP_TRADING_DAYS 個交易日
  const warmupCutoff = tradingDates[HARD_FAILURE_WARMUP_TRADING_DAYS - 1] ?? tradingDates[tradingDates.length - 1];
  const warmupCutoffTime = warmupCutoff ? warmupCutoff.getTime() : start.getTime();

  // ---- 4. 單股缺漏（thinStocks）----
  const thinStocks = await findThinStocks(prisma, start, end, tradingDates, tradingDaySet);

  // ---- 5. hardFailures 匯總 ----
  for (const [name, cov] of [
    ["DailyQuote", dqCoverage],
    ["TechnicalIndicator", tiCoverage],
    ["InstitutionalTrading", itCoverage],
  ] as const) {
    if (tradingDays > 0 && cov.coverageRatio < HARD_FAILURE_COVERAGE_RATIO) {
      hardFailures.push(
        `${name} 覆蓋率 ${(cov.coverageRatio * 100).toFixed(1)}%（< ${HARD_FAILURE_COVERAGE_RATIO * 100}%）：區間內大範圍缺資料`,
      );
    }
  }
  // TechnicalIndicator：暖身期（前 60 交易日）內的缺只列出、不算 hard failure；之後的缺才算
  const tiMissingAfterWarmup = tradingDates.filter(
    (d) => !tiCoverage.dateSet.has(d.getTime()) && d.getTime() > warmupCutoffTime,
  );
  if (tiMissingAfterWarmup.length > 0) {
    hardFailures.push(
      `TechnicalIndicator 在暖身期後仍缺 ${tiMissingAfterWarmup.length} 個交易日（例：${toIsoDate(tiMissingAfterWarmup[0]!)}）`,
    );
  }
  // InstitutionalTrading：區間中段整段缺 → hard failure（PROGRESS 記載 2020-01-02 起就有）
  const itMissingAfterWarmup = tradingDates.filter(
    (d) => !itCoverage.dateSet.has(d.getTime()) && d.getTime() > warmupCutoffTime,
  );
  if (itMissingAfterWarmup.length > 0) {
    hardFailures.push(
      `InstitutionalTrading 在暖身期後仍缺 ${itMissingAfterWarmup.length} 個交易日（例：${toIsoDate(itMissingAfterWarmup[0]!)}）`,
    );
  }

  return {
    range: { start: range.start, end: range.end },
    tradingDays,
    tables: {
      dailyQuote: stripInternal(dqCoverage),
      technicalIndicator: stripInternal(tiCoverage),
      institutionalTrading: stripInternal(itCoverage),
    },
    missingDates: {
      technicalIndicator: missingTechnicalIndicator,
      institutionalTrading: missingInstitutionalTrading,
    },
    thinStocks,
    hardFailures,
  };
}

interface CoverageInternal extends TableCoverage {
  dateSet: Set<number>;
  datesWithData: number[];
}

function stripInternal(c: CoverageInternal): TableCoverage {
  return {
    totalRows: c.totalRows,
    daysWithData: c.daysWithData,
    coverageRatio: c.coverageRatio,
    medianRowsPerDay: c.medianRowsPerDay,
  };
}

type TableName = "dailyQuote" | "technicalIndicator" | "institutionalTrading";

async function tableCoverage(
  prisma: PrismaClient,
  table: TableName,
  start: Date,
  end: Date,
  tradingDaySet: Set<number>,
  tradingDays: number,
): Promise<CoverageInternal> {
  // 每個交易日的筆數：用 groupBy date。DailyQuote 限 securityType="stock"；另兩表本身就只有一般股票。
  const where =
    table === "dailyQuote"
      ? { date: { gte: start, lte: end }, stock: { securityType: "stock" as const } }
      : { date: { gte: start, lte: end } };

  const grouped = await (prisma[table] as any).groupBy({
    by: ["date"],
    where,
    _count: { _all: true },
  });

  const dateSet = new Set<number>();
  const rowsPerDay: number[] = [];
  let totalRows = 0;
  for (const g of grouped as { date: Date; _count: { _all: number } }[]) {
    // 只計入落在交易日母體內的日期（理論上都會，但保險）
    if (tradingDaySet.has(g.date.getTime())) {
      dateSet.add(g.date.getTime());
      rowsPerDay.push(g._count._all);
      totalRows += g._count._all;
    }
  }

  const daysWithData = dateSet.size;
  return {
    totalRows,
    daysWithData,
    coverageRatio: tradingDays > 0 ? daysWithData / tradingDays : 0,
    medianRowsPerDay: median(rowsPerDay),
    dateSet,
    datesWithData: [...dateSet],
  };
}

async function findThinStocks(
  prisma: PrismaClient,
  start: Date,
  end: Date,
  tradingDates: Date[],
  tradingDaySet: Set<number>,
): Promise<ThinStock[]> {
  if (tradingDates.length === 0) return [];

  // 每股在區間內的 DailyQuote 日期（一般股票），用來推「應有交易日數」= 該股第一筆之後、區間內的交易日數
  const dqRows = await prisma.dailyQuote.groupBy({
    by: ["stockCode"],
    where: { date: { gte: start, lte: end }, stock: { securityType: "stock" } },
    _count: { _all: true },
    _min: { date: true },
  });

  const tradingDatesAsc = tradingDates; // 已升冪
  function tradingDaysFrom(firstDate: Date): number {
    // 區間內、>= firstDate 的交易日數
    let count = 0;
    for (const d of tradingDatesAsc) {
      if (d.getTime() >= firstDate.getTime()) count += 1;
    }
    return count;
  }

  const expectedByCode = new Map<string, number>();
  const dqActualByCode = new Map<string, number>();
  for (const r of dqRows as {
    stockCode: string;
    _count: { _all: number };
    _min: { date: Date | null };
  }[]) {
    const first = r._min.date;
    if (!first) continue;
    expectedByCode.set(r.stockCode, tradingDaysFrom(first));
    dqActualByCode.set(r.stockCode, r._count._all);
  }

  const codes = [...expectedByCode.keys()];

  // 另兩表的每股筆數（限定在區間內、且股票在 codes 裡）
  const [tiRows, itRows] = await Promise.all([
    prisma.technicalIndicator.groupBy({
      by: ["stockCode"],
      where: { date: { gte: start, lte: end }, stockCode: { in: codes } },
      _count: { _all: true },
    }),
    prisma.institutionalTrading.groupBy({
      by: ["stockCode"],
      where: { date: { gte: start, lte: end }, stockCode: { in: codes } },
      _count: { _all: true },
    }),
  ]);
  const tiActualByCode = new Map(
    (tiRows as { stockCode: string; _count: { _all: number } }[]).map((r) => [
      r.stockCode,
      r._count._all,
    ]),
  );
  const itActualByCode = new Map(
    (itRows as { stockCode: string; _count: { _all: number } }[]).map((r) => [
      r.stockCode,
      r._count._all,
    ]),
  );

  const thin: ThinStock[] = [];
  for (const code of codes) {
    const expected = expectedByCode.get(code)!;
    if (expected <= 0) continue;

    const checks: [ThinStock["table"], number][] = [
      ["dailyQuote", dqActualByCode.get(code) ?? 0],
      ["technicalIndicator", tiActualByCode.get(code) ?? 0],
      ["institutionalTrading", itActualByCode.get(code) ?? 0],
    ];
    for (const [table, actual] of checks) {
      const ratio = actual / expected;
      if (ratio < THIN_STOCK_RATIO) {
        thin.push({ code, table, actualDays: actual, expectedDays: expected, ratio });
      }
    }
  }

  thin.sort((a, b) => a.ratio - b.ratio);
  return thin;
}

// ---- CLI ----

function parseArgs(): { start: string; end: string } {
  const startArg = process.argv.find((a) => a.startsWith("--start="));
  const endArg = process.argv.find((a) => a.startsWith("--end="));
  if (!startArg || !endArg) {
    throw new Error("用法：--start=YYYY-MM-DD --end=YYYY-MM-DD");
  }
  const start = startArg.split("=")[1]!;
  const end = endArg.split("=")[1]!;
  for (const [label, v] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (Number.isNaN(new Date(v).getTime())) throw new Error(`--${label} 格式錯誤: ${v}`);
  }
  return { start, end };
}

function printReport(report: CompletenessReport): void {
  const { range, tradingDays, tables, missingDates, thinStocks, hardFailures } = report;
  console.log(`\n=== 資料完整性檢查 ${range.start} → ${range.end} ===`);
  console.log(`交易日母體（DailyQuote distinct date, securityType=stock）：${tradingDays} 天\n`);

  console.log("表覆蓋率：");
  console.log(
    "表".padEnd(24) + "筆數".padEnd(14) + "有資料日".padEnd(12) + "覆蓋率".padEnd(10) + "每日中位數",
  );
  console.log("-".repeat(76));
  for (const [name, cov] of [
    ["DailyQuote", tables.dailyQuote],
    ["TechnicalIndicator", tables.technicalIndicator],
    ["InstitutionalTrading", tables.institutionalTrading],
  ] as const) {
    console.log(
      name.padEnd(24) +
        String(cov.totalRows).padEnd(14) +
        String(cov.daysWithData).padEnd(12) +
        `${(cov.coverageRatio * 100).toFixed(1)}%`.padEnd(10) +
        String(cov.medianRowsPerDay),
    );
  }

  console.log(`\n整段缺日期：`);
  console.log(
    `  TechnicalIndicator：${missingDates.technicalIndicator.length} 天` +
      (missingDates.technicalIndicator.length > 0
        ? `（前 5：${missingDates.technicalIndicator.slice(0, 5).join(", ")}${missingDates.technicalIndicator.length > 5 ? " …" : ""}）`
        : ""),
  );
  console.log(
    `  InstitutionalTrading：${missingDates.institutionalTrading.length} 天` +
      (missingDates.institutionalTrading.length > 0
        ? `（前 5：${missingDates.institutionalTrading.slice(0, 5).join(", ")}${missingDates.institutionalTrading.length > 5 ? " …" : ""}）`
        : ""),
  );

  console.log(`\n單股缺漏（實際筆數 / 應有筆數 < ${THIN_STOCK_RATIO}）：${thinStocks.length} 筆`);
  for (const t of thinStocks.slice(0, 30)) {
    console.log(
      `  ${t.code.padEnd(8)} ${t.table.padEnd(20)} ${t.actualDays}/${t.expectedDays}（${(t.ratio * 100).toFixed(0)}%）`,
    );
  }
  if (thinStocks.length > 30) console.log(`  … 其餘 ${thinStocks.length - 30} 筆略`);

  console.log(`\nHard failures：${hardFailures.length === 0 ? "無（可跑 Layer 0）" : ""}`);
  for (const h of hardFailures) console.log(`  ✗ ${h}`);
  console.log("");
}

async function main() {
  const { start, end } = parseArgs();
  const report = await checkDataCompleteness({ start, end });
  printReport(report);
  if (report.hardFailures.length > 0) process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((err) => {
    console.error("資料完整性檢查失敗:", err);
    process.exit(1);
  });
}
