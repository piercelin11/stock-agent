-- CreateTable
CREATE TABLE "MarginTrading" (
    "id" SERIAL NOT NULL,
    "stockCode" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "marginBalance" BIGINT NOT NULL,
    "marginBalancePrev" BIGINT NOT NULL,
    "marginQuota" BIGINT,
    "shortBalance" BIGINT NOT NULL,
    "shortBalancePrev" BIGINT NOT NULL,
    "offsetting" BIGINT,
    "source" "Market" NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarginTrading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarginTrading_date_idx" ON "MarginTrading"("date");

-- CreateIndex
CREATE UNIQUE INDEX "MarginTrading_stockCode_date_key" ON "MarginTrading"("stockCode", "date");

-- AddForeignKey
ALTER TABLE "MarginTrading" ADD CONSTRAINT "MarginTrading_stockCode_fkey" FOREIGN KEY ("stockCode") REFERENCES "Stock"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
