// PLAN 3 §1：盤中掃描薄殼。
//
// launchd（com.piercelin.intradayscan.plist）每日 09:00–13:30 整點 / 半點觸發。
// 內部判「台北平日 09:00–13:30？」否 → console.log + return（靜默，exit 0）；
// 是 → runSignalScan(new Date(), { source: "realtime" }) 寫 {timestamp}.json（runSignalScan 本體負責）。
// **不寫 DB。** 盤中衍生值不落地，遵循專案「衍生值不落地」哲學。
//
// PLAN 4 起這是 realtime 掃描唯一的背景執行者——前端不再自己 spawn（_run-signal-scan.ts +
// startSignalScan() 已刪）。選股頁進頁只讀最新 {timestamp}.json；「立即掃描」按鈕改成 Server
// Action 內同步跑（卡 UI ~30 秒），也不 spawn。
//   （runSignalScan 的 runRealtime 內部仍會 writeProgressDone() 寫 progress.json，無害——
//    前端不讀了，只剩 CLI 手動跑時的紀錄。）

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { runSignalScan } from "../screening/run-signal-scan";

// 台北現在時間（用 +8 偏移，避免依賴伺服器 TZ；專案其他地方也是這套路）。
function taipeiNow(): { hour: number; minute: number; weekday: number } {
  const s = new Date(Date.now() + 8 * 3600_000);
  return { hour: s.getUTCHours(), minute: s.getUTCMinutes(), weekday: s.getUTCDay() };
}

async function main() {
  const t = taipeiNow();
  const mins = t.hour * 60 + t.minute;
  // 台北平日 09:00–13:30 才跑（launchd 週末也會觸發、腳本自己 skip；最後一道防線）。
  // 09:00 就跑第一次也 OK——runRealtime 的 elapsedRatio 很小會 push「開盤前量能不準」警語，不中斷。
  if (t.weekday === 0 || t.weekday === 6 || mins < 9 * 60 || mins > 13 * 60 + 30) {
    console.log(
      `[intraday-scan] 非台北交易時段（週${t.weekday} ${t.hour}:${String(t.minute).padStart(2, "0")}），跳過。`,
    );
    return;
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const out = await runSignalScan(new Date(), { prisma, source: "realtime" });
    console.log(
      `[intraday-scan] 完成：全市場 ${out.stats.totalStocks} · 過 gate ${out.stats.passedGate} · ` +
        `觀察股豁免 ${out.stats.watchlistExempt ?? 0} · 寫入 ${out.date}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[intraday-scan] 失敗:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
