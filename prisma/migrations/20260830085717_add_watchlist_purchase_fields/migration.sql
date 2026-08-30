-- AlterTable
ALTER TABLE "WatchlistItem" ADD COLUMN     "buyDate" DATE,
ADD COLUMN     "buyPrice" DECIMAL(10,2),
ADD COLUMN     "isPurchased" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "stopLossPrice" DECIMAL(10,2),
ADD COLUMN     "targetPrice" DECIMAL(10,2);
