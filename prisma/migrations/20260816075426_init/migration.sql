-- CreateEnum
CREATE TYPE "SecurityType" AS ENUM ('stock', 'etf', 'preferred', 'warrant', 'bond', 'other');

-- CreateEnum
CREATE TYPE "Market" AS ENUM ('TWSE', 'TPEx');

-- CreateTable
CREATE TABLE "Sector" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Sector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "securityType" "SecurityType" NOT NULL,
    "sectorId" INTEGER,

    CONSTRAINT "Stock_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTag" (
    "stockCode" TEXT NOT NULL,
    "tagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTag_pkey" PRIMARY KEY ("stockCode","tagId")
);

-- CreateTable
CREATE TABLE "DailyQuote" (
    "id" SERIAL NOT NULL,
    "stockCode" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL,
    "change" DOUBLE PRECISION NOT NULL,
    "source" "Market" NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsArticle" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "sentiment" TEXT,
    "sentimentScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsStock" (
    "newsId" INTEGER NOT NULL,
    "stockCode" TEXT NOT NULL,

    CONSTRAINT "NewsStock_pkey" PRIMARY KEY ("newsId","stockCode")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "stockCode" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("stockCode")
);

-- CreateTable
CREATE TABLE "AnalysisResult" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "stockCode" TEXT,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sector_name_key" ON "Sector"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "DailyQuote_date_idx" ON "DailyQuote"("date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyQuote_stockCode_date_key" ON "DailyQuote"("stockCode", "date");

-- AddForeignKey
ALTER TABLE "Stock" ADD CONSTRAINT "Stock_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTag" ADD CONSTRAINT "StockTag_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTag" ADD CONSTRAINT "StockTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyQuote" ADD CONSTRAINT "DailyQuote_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsStock" ADD CONSTRAINT "NewsStock_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "NewsArticle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsStock" ADD CONSTRAINT "NewsStock_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
