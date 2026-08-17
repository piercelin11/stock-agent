-- AlterTable
ALTER TABLE "AnalysisResult" ADD COLUMN     "dataQuality" JSONB;

-- CreateTable
CREATE TABLE "MonthRevenue" (
    "id" SERIAL NOT NULL,
    "stockCode" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "revenue" BIGINT NOT NULL,
    "revenueYoY" DOUBLE PRECISION,
    "revenueMoM" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthRevenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialStatement" (
    "id" SERIAL NOT NULL,
    "stockCode" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "quarter" INTEGER NOT NULL,
    "revenue" BIGINT,
    "grossProfit" BIGINT,
    "operatingIncome" BIGINT,
    "netIncome" BIGINT,
    "eps" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstitutionalTrading" (
    "id" SERIAL NOT NULL,
    "stockCode" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "foreignNetBuy" BIGINT,
    "investmentTrustNetBuy" BIGINT,
    "dealerNetBuy" BIGINT,
    "source" "Market" NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstitutionalTrading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicalIndicator" (
    "id" SERIAL NOT NULL,
    "stockCode" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "ma5" DOUBLE PRECISION,
    "ma10" DOUBLE PRECISION,
    "ma20" DOUBLE PRECISION,
    "ma60" DOUBLE PRECISION,
    "bollingerUpper" DOUBLE PRECISION,
    "bollingerMid" DOUBLE PRECISION,
    "bollingerLower" DOUBLE PRECISION,
    "volumeMa20" DOUBLE PRECISION,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicalIndicator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonthRevenue_stockCode_year_month_key" ON "MonthRevenue"("stockCode", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialStatement_stockCode_year_quarter_key" ON "FinancialStatement"("stockCode", "year", "quarter");

-- CreateIndex
CREATE INDEX "InstitutionalTrading_date_idx" ON "InstitutionalTrading"("date");

-- CreateIndex
CREATE UNIQUE INDEX "InstitutionalTrading_stockCode_date_key" ON "InstitutionalTrading"("stockCode", "date");

-- CreateIndex
CREATE INDEX "TechnicalIndicator_date_idx" ON "TechnicalIndicator"("date");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalIndicator_stockCode_date_key" ON "TechnicalIndicator"("stockCode", "date");

-- AddForeignKey
ALTER TABLE "MonthRevenue" ADD CONSTRAINT "MonthRevenue_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialStatement" ADD CONSTRAINT "FinancialStatement_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstitutionalTrading" ADD CONSTRAINT "InstitutionalTrading_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicalIndicator" ADD CONSTRAINT "TechnicalIndicator_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
