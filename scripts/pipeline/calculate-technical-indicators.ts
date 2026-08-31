import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const PROGRESS_INTERVAL = 100;

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values: number[], mean: number): number {
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function movingAverage(closes: number[], index: number, period: number): number | null {
  if (index + 1 < period) return null;
  return average(closes.slice(index + 1 - period, index + 1));
}

// 近 20 日「日報酬率」標準差（%）
function volatility20d(closes: number[], index: number): number | null {
  if (index + 1 < 21) return null; // 需要 21 筆收盤價才能算出 20 個報酬率
  const window = closes.slice(index - 20, index + 1);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    if (prev <= 0) continue;
    returns.push(((window[i]! - prev) / prev) * 100);
  }
  if (returns.length === 0) return null;
  const mean = average(returns)!;
  return stdDev(returns, mean);
}

// 近 20 日內從任一高點到之後低點的最大跌幅（%，負值）
function maxDrawdown20d(closes: number[], index: number, period = 20): number | null {
  if (index + 1 < period) return null;
  const window = closes.slice(index + 1 - period, index + 1);
  let peak = window[0]!;
  let maxDrawdown = 0;
  for (const close of window) {
    if (close > peak) peak = close;
    if (peak > 0) {
      const drawdown = ((close - peak) / peak) * 100;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }
  }
  return maxDrawdown;
}

// 近 20 日 True Range 平均值
function atr20(highs: number[], lows: number[], closes: number[], index: number, period = 20): number | null {
  if (index + 1 < period + 1) return null; // 需要前一日收盤才能算 TR
  const trueRanges: number[] = [];
  for (let i = index - period + 1; i <= index; i++) {
    const prevClose = closes[i - 1]!;
    const tr = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - prevClose),
      Math.abs(lows[i]! - prevClose),
    );
    trueRanges.push(tr);
  }
  return average(trueRanges);
}

// 14 日 RSI（標準公式：漲幅平均 / (漲幅平均 + 跌幅平均) x 100）
function rsi14(closes: number[], index: number, period = 14): number | null {
  if (index + 1 < period + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) gainSum += diff;
    else lossSum += -diff;
  }
  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;
  if (avgGain + avgLoss === 0) return 50; // 完全無波動，視為中性
  return (avgGain / (avgGain + avgLoss)) * 100;
}

function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const result: (number | null)[] = new Array(values.length).fill(null);
  let prevEma: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < period) continue;
    if (prevEma === null) {
      prevEma = average(values.slice(i + 1 - period, i + 1));
    } else {
      prevEma = values[i]! * k + prevEma * (1 - k);
    }
    result[i] = prevEma;
  }
  return result;
}

// 用 12/26/9 EMA 算 MACD 線與訊號線，回傳最新交叉後的持續狀態
function macdStatusSeries(closes: number[]): (string | null)[] {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => {
    const a = ema12[i] ?? null;
    const b = ema26[i] ?? null;
    return a !== null && b !== null ? a - b : null;
  });
  const macdValues = macdLine.filter((v): v is number => v !== null);
  const signalOnValid = ema(macdValues, 9);

  // 把只在「有效 macdLine」序列上算出的 signal 值對回原本的日期索引
  const signalLine: (number | null)[] = new Array(closes.length).fill(null);
  let validIndex = -1;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) continue;
    validIndex++;
    signalLine[i] = signalOnValid[validIndex] ?? null;
  }

  const status: (string | null)[] = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const macd = macdLine[i];
    const signal = signalLine[i];
    if (macd == null || signal == null) continue;

    if (macd > signal) {
      status[i] = "bullish";
    } else if (macd < signal) {
      status[i] = "bearish";
    } else {
      status[i] = null;
    }
  }
  return status;
}

// codes 傳入時只重算這幾支（例：某支股票事後補齊報價後單獨補指標），不傳則跑全市場一般股票 + TAIEX。
// TAIEX（securityType=index）的 MACD/RSI/ATR 等分項算出來無妨，大盤濾網只讀 ma60 和 bollingerBandwidth。
// mode "latest" 每支只撈最近這麼多筆 DailyQuote 當輸入，足夠算出最長窗口
// （MA60 需 60、MACD 的 EMA 需更長暖身才穩，250 給足餘裕）。
const LATEST_LOOKBACK = 250;

interface CalcOptions {
  // "full"（預設）= 對每支的全部歷史 DailyQuote 逐日重算並 upsert（回補報價後手動重算、debug 用）。
  // "latest" = 每支只撈最近 LATEST_LOOKBACK 筆當輸入、只 upsert 最新一筆日期（daily-pipeline 每日跑，秒級）。
  mode?: "full" | "latest";
}

export async function calculateTechnicalIndicators(
  codes?: string[],
  options: CalcOptions = {},
): Promise<{ processed: number; indicatorsWritten: number }> {
  const mode = options.mode ?? "full";
  const stocks = await prisma.stock.findMany({
    where: {
      OR: [{ securityType: "stock" }, { code: "TAIEX" }],
      ...(codes ? { code: { in: codes } } : {}),
    },
    select: { code: true },
    orderBy: { code: "asc" },
  });

  console.log(
    `共 ${stocks.length} 支（含 TAIEX）待計算。模式：${mode === "latest" ? "只算最新一天" : "全歷史重算"}`,
  );

  let processed = 0;
  let indicatorsWritten = 0;

  for (const stock of stocks) {
    const quotes =
      mode === "latest"
        ? (
            await prisma.dailyQuote.findMany({
              where: { stockCode: stock.code },
              orderBy: { date: "desc" },
              take: LATEST_LOOKBACK,
              select: { date: true, high: true, low: true, close: true, volume: true },
            })
          ).reverse() // 反轉回 asc，下游計算不變
        : await prisma.dailyQuote.findMany({
            where: { stockCode: stock.code },
            orderBy: { date: "asc" },
            select: { date: true, high: true, low: true, close: true, volume: true },
          });

    const highs = quotes.map((q) => q.high);
    const lows = quotes.map((q) => q.low);
    const closes = quotes.map((q) => q.close);
    const volumes = quotes.map((q) => Number(q.volume));
    const macdStatuses = macdStatusSeries(closes);

    const rows = quotes.map((quote, i) => {
      const ma5 = movingAverage(closes, i, 5);
      const ma10 = movingAverage(closes, i, 10);
      const ma20 = movingAverage(closes, i, 20);
      const ma60 = movingAverage(closes, i, 60);
      const volumeMa20 = movingAverage(volumes, i, 20);

      let bollingerUpper: number | null = null;
      let bollingerLower: number | null = null;
      let bollingerBandwidth: number | null = null;
      if (ma20 !== null) {
        const window = closes.slice(i + 1 - 20, i + 1);
        const sd = stdDev(window, ma20);
        bollingerUpper = ma20 + 2 * sd;
        bollingerLower = ma20 - 2 * sd;
        bollingerBandwidth = ma20 !== 0 ? (bollingerUpper - bollingerLower) / ma20 : null;
      }

      return {
        stockCode: stock.code,
        date: quote.date,
        ma5,
        ma10,
        ma20,
        ma60,
        bollingerMid: ma20,
        bollingerUpper,
        bollingerLower,
        bollingerBandwidth,
        volumeMa20,
        volatility20d: volatility20d(closes, i),
        maxDrawdown20d: maxDrawdown20d(closes, i),
        atr20: atr20(highs, lows, closes, i),
        rsi14: rsi14(closes, i),
        macdStatus: macdStatuses[i] ?? null,
      };
    });

    // mode "latest"：只寫最新一筆日期（rows 已按 date asc，最後一筆即最新）。
    // quotes 為空（新股當天才上市、還沒有 DailyQuote）→ rows 空 → slice(-1) 也空，該支不寫。
    const rowsToWrite = mode === "latest" ? rows.slice(-1) : rows;
    for (const row of rowsToWrite) {
      await prisma.technicalIndicator.upsert({
        where: { stockCode_date: { stockCode: row.stockCode, date: row.date } },
        update: row,
        create: row,
      });
      indicatorsWritten++;
    }

    processed++;
    if (processed % PROGRESS_INTERVAL === 0) {
      console.log(`已處理 ${processed}/${stocks.length}`);
    }
  }

  console.log("\n===== 技術指標計算完成 =====");
  console.log(`處理股票數: ${processed}`);
  console.log(`寫入 TechnicalIndicator 筆數: ${indicatorsWritten}`);

  return { processed, indicatorsWritten };
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  // 可選：傳股票代號當參數，只重算那幾支（pnpm tsx scripts/pipeline/calculate-technical-indicators.ts 4104 2330 TAIEX）
  const codeArgs = process.argv.slice(2).filter((a) => /^\d{4}[A-Z]?$/.test(a) || a === "TAIEX");
  calculateTechnicalIndicators(codeArgs.length > 0 ? codeArgs : undefined)
    .catch((err) => {
      console.error("技術指標計算失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
