#!/bin/sh
# 一次跑完「6 年歷史回補 + 全段重算」四步接力：
#   1. 回補 6 年每日報價（FinMind 逐支，約 3.5 小時）
#   2. 回補 6 年三大法人買賣超（FinMind 逐支，約 3.5 小時）
#   3. 重算整段技術指標（純 DB 計算）
#   4. 重算整段產業熱度（純 DB 計算，--backfill 1600 涵蓋 6 年交易日）
#
# 用法：
#   nohup sh scripts/backfill-6y.sh > /dev/null 2>&1 &
# 看進度：
#   tail -f logs/backfill_6y_*.log
#
# 起始日預設 2020-01-01，要改就帶環境變數：
#   BACKFILL_START_DATE=2019-01-01 nohup sh scripts/backfill-6y.sh > /dev/null 2>&1 &
#
# 休眠／闔蓋不影響：process 會被暫停，開蓋後自動從暫停處接著跑，不會中斷、不會從頭。
# set -e：任一步驟失敗立刻停，不會拿半套資料往下算。

set -e
cd "$(dirname "$0")/.."
mkdir -p logs
LOG="logs/backfill_6y_$(date +%Y%m%d_%H%M%S).log"

echo "log 檔：$LOG"
echo "log 檔：$LOG" >> "$LOG"

run() {
  echo "=== $1 開始 $(date '+%F %T') ===" | tee -a "$LOG"
  # shellcheck disable=SC2086
  npx tsx "$2" $3 2>&1 | tee -a "$LOG"
  echo "=== $1 完成 $(date '+%F %T') ===" | tee -a "$LOG"
}

run "[1/4] 回補 6 年報價"       scripts/backfill-daily-quotes.ts
run "[2/4] 回補 6 年三大法人"   scripts/backfill-institutional-trading.ts
run "[3/4] 重算整段技術指標"    scripts/calculate-technical-indicators.ts
run "[4/4] 重算整段產業熱度"    scripts/calculate-industry-heat.ts "--backfill 1600"

echo "=== 全部完成 $(date '+%F %T') ===" | tee -a "$LOG"
