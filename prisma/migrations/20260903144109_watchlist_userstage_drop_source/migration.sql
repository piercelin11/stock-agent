-- CreateEnum
CREATE TYPE "SignalStage" AS ENUM ('setup', 'breakoutDay', 'extended');

-- AlterTable
ALTER TABLE "WatchlistItem" DROP COLUMN "source",
ADD COLUMN     "userStage" "SignalStage";
