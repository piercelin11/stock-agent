-- AlterTable
ALTER TABLE "Stock" ADD COLUMN     "sharesOutstanding" BIGINT,
ADD COLUMN     "sharesOutstandingUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StockValuation" (
    "id" SERIAL NOT NULL,
    "stockCode" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "peRatio" DECIMAL(10,2),
    "pbRatio" DECIMAL(10,2),
    "dividendYield" DECIMAL(6,2),
    "closePrice" DECIMAL(10,2),
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockValuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndustryHeatSnapshot" (
    "id" SERIAL NOT NULL,
    "sectorId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "avgChangePercent" DECIMAL(8,4) NOT NULL,
    "risingCount" INTEGER NOT NULL,
    "fallingCount" INTEGER NOT NULL,
    "totalCount" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndustryHeatSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockValuation_date_idx" ON "StockValuation"("date");

-- CreateIndex
CREATE UNIQUE INDEX "StockValuation_stockCode_date_key" ON "StockValuation"("stockCode", "date");

-- CreateIndex
CREATE INDEX "IndustryHeatSnapshot_date_idx" ON "IndustryHeatSnapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "IndustryHeatSnapshot_sectorId_date_key" ON "IndustryHeatSnapshot"("sectorId", "date");

-- AddForeignKey
ALTER TABLE "StockValuation" ADD CONSTRAINT "StockValuation_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndustryHeatSnapshot" ADD CONSTRAINT "IndustryHeatSnapshot_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
