import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

// ========================================================================
// Layer 0.5：forward-returns cache（ROADMAP 3.4 / PLAN §2）
//
// 對回測涉及的每個 (交易日 d, 全市場一般股票 code)，用 d 之後的 DailyQuote close
// 算 N 日（預設 5 / 10 / 20）報酬率，加上同期 benchmark（0050）報酬，
// 寫入 data/backtest-cache/forward-returns.jsonl（全域、非 run 專屬，跨策略共用）。
//
// - 「第 N 天」用【該股自己的報價序列】數（停牌股不誤算）；benchmark 用【全市場交易日曆】。
// - 不足 N 筆報價的 horizon 記 null（不跳過整行）。
// - 命中判定（retN > benchmarkRetN）不寫進 cache，留給 computeBacktestStats（§4）。
// - 去重：算過的 (date, code) 跳過；--force 才重算覆寫。
// ========================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CACHE_DIR = join(REPO_ROOT, "data", "backtest-cache");
const CACHE_PATH = join(CACHE_DIR, "forward-returns.jsonl");
const META_PATH = join(CACHE_DIR, "forward-returns.meta.json");

export const FORWARD_RETURN_HORIZONS = [5, 10, 20];
const BENCHMARK_CODE = "0050";

// 每個基準日一次 range query：撈「d 之後、date 在 d 後 N 個日曆日內」的全市場 close。
// 40 日曆日足以涵蓋 max(20) 交易日 + 農曆年等長假；不足時對該檔補一次單獨 query。
const LOOKAHEAD_CALENDAR_DAYS = 40;
// 每 N 個基準日 flush 一次（臨時檔 + rename 替換），避免中途中斷留半行。
const FLUSH_EVERY_DAYS = 50;

const RF_PRECISION = 6;
function r6(x: number | null | undefined): number | null {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  return Math.round(x * 1e6) / 1e6;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function makePrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export interface ForwardReturnRow {
  date: string;
  code: string;
  entryClose: number;
  benchmarkGapDays: number | null;
  // retN / benchmarkRetN 動態欄位（見 FORWARD_RETURN_HORIZONS）
  [key: string]: string | number | null;
}

export interface BuildForwardReturnsOptions {
  start: string; // YYYY-MM-DD，要算 forward-returns 的「基準日」下界
  end: string; // YYYY-MM-DD，基準日上界
  horizons?: number[]; // 預設 FORWARD_RETURN_HORIZONS
  codes?: string[]; // 選填，預設全市場一般股票
  prisma?: PrismaClient;
  force?: boolean; // true = 重算並覆寫已存在的 (date, code)
  onProgress?: (p: {
    totalDays: number;
    completedDays: number;
    currentDate: string | null;
  }) => void;
}

export async function buildForwardReturns(
  options: BuildForwardReturnsOptions,
): Promise<{ rowsWritten: number; rowsSkipped: number; cachePath: string }> {
  const prisma = options.prisma ?? makePrisma();
  const ownsPrisma = options.prisma === undefined;
  try {
    return await execute(prisma, options);
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

function keyOf(date: string, code: string): string {
  return `${date}|${code}`;
}

// 讀既有 jsonl → 保留原始行（force=false 用來去重；force=true 用來濾掉待重算的 key 後保留其餘）
function readExistingLines(): string[] {
  if (!existsSync(CACHE_PATH)) return [];
  const content = readFileSync(CACHE_PATH, "utf8");
  if (content.trim().length === 0) return [];
  return content.split("\n").filter((l) => l.trim().length > 0);
}

function parseKey(line: string): string | null {
  try {
    const o = JSON.parse(line) as { date?: string; code?: string };
    if (typeof o.date === "string" && typeof o.code === "string") return keyOf(o.date, o.code);
  } catch {
    /* 壞行略過 */
  }
  return null;
}

function atomicReplace(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

async function execute(
  prisma: PrismaClient,
  options: BuildForwardReturnsOptions,
): Promise<{ rowsWritten: number; rowsSkipped: number; cachePath: string }> {
  const horizons = (options.horizons ?? FORWARD_RETURN_HORIZONS).slice().sort((a, b) => a - b);
  const maxHorizon = horizons[horizons.length - 1]!;
  const startDate = new Date(options.start);
  const endDate = new Date(options.end);

  mkdirSync(CACHE_DIR, { recursive: true });

  // ---- 1. 交易日母體：全區間 DailyQuote distinct date（不只 start..end；要算 end 當天的 retMax
  //         需要 end 之後 +max 個交易日的報價，所以撈到「今天」為止）。 ----
  const allTradingDateRows = await prisma.dailyQuote.findMany({
    where: { stock: { securityType: "stock" } },
    distinct: ["date"],
    orderBy: { date: "asc" },
    select: { date: true },
  });
  const allTradingDates = allTradingDateRows.map((r) => r.date);
  const baseDates = allTradingDates.filter(
    (d) => d.getTime() >= startDate.getTime() && d.getTime() <= endDate.getTime(),
  );

  // 全市場交易日曆（給 benchmark 用）：Date[] 升冪 + index Map
  const calendarIndex = new Map<number, number>();
  allTradingDates.forEach((d, i) => calendarIndex.set(d.getTime(), i));

  // ---- 2. 既有 cache → 去重 ----
  const existingLines = readExistingLines();
  const existingKeys = new Set<string>();
  for (const line of existingLines) {
    const k = parseKey(line);
    if (k) existingKeys.add(k);
  }

  // ---- 3. 目標股票清單 ----
  let codes: string[];
  if (options.codes && options.codes.length > 0) {
    codes = options.codes;
  } else {
    const stockRows = await prisma.stock.findMany({
      where: { securityType: "stock" },
      select: { code: true },
    });
    codes = stockRows.map((r) => r.code);
  }
  const codeSet = new Set(codes);

  // ---- 4. 預載 benchmark：0050 全區間 DailyQuote（date → close）----
  const benchRows = await prisma.dailyQuote.findMany({
    where: { stockCode: BENCHMARK_CODE },
    orderBy: { date: "asc" },
    select: { date: true, close: true },
  });
  const benchByTime = new Map<number, number>();
  for (const r of benchRows) benchByTime.set(r.date.getTime(), r.close);

  // benchmark 報酬：d 之後第 N 個【全市場交易日曆】的 0050 close；缺該日往後找第一個有值
  function benchmarkReturn(
    d: Date,
    entry: number | undefined,
    n: number,
  ): { ret: number | null; gapDays: number | null } {
    if (entry === undefined || entry <= 0) return { ret: null, gapDays: null };
    const idx = calendarIndex.get(d.getTime());
    if (idx === undefined) return { ret: null, gapDays: null };
    let targetIdx = idx + n;
    if (targetIdx >= allTradingDates.length) return { ret: null, gapDays: null };
    let gap = 0;
    // 往後找第一個 0050 有 close 的交易日
    while (targetIdx < allTradingDates.length) {
      const t = allTradingDates[targetIdx]!.getTime();
      const c = benchByTime.get(t);
      if (c !== undefined && c > 0) {
        return { ret: ((c - entry) / entry) * 100, gapDays: gap === 0 ? null : gap };
      }
      targetIdx += 1;
      gap += 1;
    }
    return { ret: null, gapDays: null };
  }

  // ---- 5. 逐基準日 ----
  const newLines: string[] = [];
  let rowsWritten = 0;
  let rowsSkipped = 0;
  let daysSinceFlush = 0;

  // force 模式：先把「這次會重算的 (date, code)」從既有行濾掉，其餘保留
  const forceKeysToDrop = new Set<string>();

  const flush = () => {
    // 重寫整個檔案 = 保留行（force 時已濾掉待重算的）+ 這次新增行
    const keptLines = options.force
      ? existingLines.filter((l) => {
          const k = parseKey(l);
          return k === null || !forceKeysToDrop.has(k);
        })
      : existingLines;
    const content = [...keptLines, ...newLines].join("\n") + (keptLines.length + newLines.length > 0 ? "\n" : "");
    atomicReplace(CACHE_PATH, content);
  };

  for (let di = 0; di < baseDates.length; di++) {
    const d = baseDates[di]!;
    const dStr = toIsoDate(d);

    // 5a. 當天全市場 close（entryClose 來源）——一次撈
    const entryRows = await prisma.dailyQuote.findMany({
      where: { date: d, stock: { securityType: "stock" } },
      select: { stockCode: true, close: true },
    });
    const entryByCode = new Map<string, number>();
    for (const r of entryRows) {
      if (codeSet.has(r.stockCode)) entryByCode.set(r.stockCode, r.close);
    }

    // 5b. 該日之後、LOOKAHEAD_CALENDAR_DAYS 日曆日內、全市場的 close（一次 range query）
    const lookaheadEnd = new Date(d.getTime() + LOOKAHEAD_CALENDAR_DAYS * 86_400_000);
    const futureRows = await prisma.dailyQuote.findMany({
      where: {
        date: { gt: d, lte: lookaheadEnd },
        stock: { securityType: "stock" },
      },
      orderBy: { date: "asc" },
      select: { stockCode: true, date: true, close: true },
    });
    const futureByCode = new Map<string, { date: Date; close: number }[]>();
    for (const r of futureRows) {
      if (!codeSet.has(r.stockCode)) continue;
      let list = futureByCode.get(r.stockCode);
      if (!list) {
        list = [];
        futureByCode.set(r.stockCode, list);
      }
      list.push({ date: r.date, close: r.close });
    }

    for (const code of codes) {
      const entryClose = entryByCode.get(code);
      if (entryClose === undefined) continue; // 該股當天無報價

      const k = keyOf(dStr, code);
      if (existingKeys.has(k)) {
        if (!options.force) {
          rowsSkipped += 1;
          continue;
        }
        forceKeysToDrop.add(k);
      }

      // 該股 d 之後的報價序列（升冪）
      let future = futureByCode.get(code) ?? [];
      // 若 lookahead 窗內不足 maxHorizon 筆 → 對該檔補一次單獨 query
      if (future.length < maxHorizon) {
        const extra = await prisma.dailyQuote.findMany({
          where: { stockCode: code, date: { gt: d } },
          orderBy: { date: "asc" },
          take: maxHorizon,
          select: { date: true, close: true },
        });
        future = extra.map((r) => ({ date: r.date, close: r.close }));
      }

      const row: ForwardReturnRow = {
        date: dStr,
        code,
        entryClose: r6(entryClose)!,
        benchmarkGapDays: null,
      };

      let maxGap: number | null = null;
      for (const n of horizons) {
        const exit = future[n - 1];
        const retN =
          exit && entryClose > 0 ? ((exit.close - entryClose) / entryClose) * 100 : null;
        row[`ret${n}`] = r6(retN);

        const b = benchmarkReturn(d, entryByCode.get(BENCHMARK_CODE) ?? benchByTime.get(d.getTime()), n);
        row[`benchmarkRet${n}`] = r6(b.ret);
        if (b.gapDays !== null) maxGap = Math.max(maxGap ?? 0, b.gapDays);
      }
      row.benchmarkGapDays = maxGap;

      newLines.push(JSON.stringify(row));
      rowsWritten += 1;
    }

    daysSinceFlush += 1;
    if (daysSinceFlush >= FLUSH_EVERY_DAYS) {
      flush();
      daysSinceFlush = 0;
    }
    options.onProgress?.({
      totalDays: baseDates.length,
      completedDays: di + 1,
      currentDate: dStr,
    });
  }

  flush();

  // ---- 6. 重寫 meta ----
  const finalLines = readExistingLines();
  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (const line of finalLines) {
    try {
      const o = JSON.parse(line) as { date?: string };
      if (typeof o.date === "string") {
        if (minDate === null || o.date < minDate) minDate = o.date;
        if (maxDate === null || o.date > maxDate) maxDate = o.date;
      }
    } catch {
      /* 略過 */
    }
  }
  const meta = {
    horizons,
    benchmarkCode: BENCHMARK_CODE,
    coveredDateRange: { start: minDate, end: maxDate },
    rowCount: finalLines.length,
    lastBuiltAt: new Date().toISOString(),
    note: "0050 未還原股價，除息日 close 含假跌幅；benchmark 報酬有小誤差",
  };
  atomicReplace(META_PATH, JSON.stringify(meta, null, 2));

  return { rowsWritten, rowsSkipped, cachePath: CACHE_PATH };
}

// ---- CLI ----

function parseArgs() {
  const get = (k: string) => {
    const a = process.argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.split("=")[1]! : undefined;
  };
  const start = get("start");
  const end = get("end");
  const horizonsStr = get("horizons");
  const codesStr = get("codes");
  const force = process.argv.includes("--force");
  return {
    start,
    end,
    horizons: horizonsStr ? horizonsStr.split(",").map(Number).filter((n) => !Number.isNaN(n)) : undefined,
    codes: codesStr ? codesStr.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    force,
  };
}

async function main() {
  const args = parseArgs();
  if (!args.start || !args.end) {
    throw new Error(
      "用法：--start=YYYY-MM-DD --end=YYYY-MM-DD [--horizons=5,10,20] [--codes=2330,2454] [--force]",
    );
  }
  for (const [label, v] of [
    ["start", args.start],
    ["end", args.end],
  ] as const) {
    if (Number.isNaN(new Date(v).getTime())) throw new Error(`--${label} 格式錯誤: ${v}`);
  }

  const opts: BuildForwardReturnsOptions = {
    start: args.start,
    end: args.end,
    force: args.force,
    onProgress: (p) => {
      if (p.completedDays % 10 === 0 || p.completedDays === p.totalDays) {
        console.log(`  ${p.completedDays}/${p.totalDays} ${p.currentDate ?? ""}`);
      }
    },
  };
  if (args.horizons) opts.horizons = args.horizons;
  if (args.codes) opts.codes = args.codes;

  console.log(
    `建立 forward-returns cache：${args.start} → ${args.end}` +
      (args.force ? "（--force 重算）" : ""),
  );
  const { rowsWritten, rowsSkipped, cachePath } = await buildForwardReturns(opts);
  console.log(`\n完成。新增 ${rowsWritten} 行，跳過 ${rowsSkipped} 行（已存在）。`);
  console.log(`cache：${cachePath}`);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((err) => {
    console.error("forward-returns cache 建立失敗:", err);
    process.exit(1);
  });
}
