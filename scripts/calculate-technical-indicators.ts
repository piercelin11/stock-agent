import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

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

export async function calculateTechnicalIndicators(): Promise<{ processed: number; indicatorsWritten: number }> {
  const stocks = await prisma.stock.findMany({
    where: { securityType: "stock" },
    select: { code: true },
    orderBy: { code: "asc" },
  });

  console.log(`共 ${stocks.length} 支一般股票待計算。`);

  let processed = 0;
  let indicatorsWritten = 0;

  for (const stock of stocks) {
    const quotes = await prisma.dailyQuote.findMany({
      where: { stockCode: stock.code },
      orderBy: { date: "asc" },
      select: { date: true, close: true, volume: true },
    });

    const closes = quotes.map((q) => q.close);
    const volumes = quotes.map((q) => Number(q.volume));

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
      };
    });

    for (const row of rows) {
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
  calculateTechnicalIndicators()
    .catch((err) => {
      console.error("技術指標計算失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
