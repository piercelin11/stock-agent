// PLAN 2 §2：資料脈絡單一真相來源。
//
// 「盤中該用 DB 昨收還是 MIS 即時」的判斷 + 如何 fallback，收斂到這一支 helper。
// 物理上仍是 DB + JSON 兩來源（盤中衍生值不落 DB，遵循專案「衍生值不落地」哲學），
// 這裡只統一「判斷用哪個」。
//
// **非 "use server"**（純函式 + 讀檔，被多個 action 呼叫；比照 lib/dashboard-spark.ts / lib/latest-scan.ts）。
// 收 prisma（呼叫端傳前端單例）——比照 scripts/lib/market-regime.ts 一律外部傳。

import type { PrismaClient } from "../generated/prisma/client";
import { readLatestScan, type LatestScan } from "./latest-scan";

export type DataMode = "eod" | "intraday" | "stale";

export interface DataContext {
  mode: DataMode;
  //  eod      = DB 最新一般股票交易日 == 台北今日 → 用 DB（盤後定案）
  //  intraday = 非今日 + 現在台北平日 09:00–17:00 + 有「夠新」的掃描 JSON → 用 JSON
  //             （PLAN 3 §3 才真的有頁面走此分支）
  //  stale    = 非今日 + 盤外 / 無夠新 JSON → 用 DB 昨收（畫面標「收盤定案 {date}」）
  asOfDate: string; // 畫面該顯示的「截至」日期
  latestEodDate: string; // DB 最新一般股票交易日（YYYY-MM-DD）
  latestScan: LatestScan | null; // preferRealtime 讀到的最新掃描結果（intraday/stale 都附）
}

// 掃描 JSON「夠新」的上限。
//   盤中（09:00–13:30）：launchd 每 30 分跑 → 30 分間隔 + 5 分緩衝 = 35 分。
//     超過 = 伺服器沒開或 launchd 沒跑成 → 退 stale。
//   收盤後（13:30–17:00）：launchd 不再觸發掃描，最後一份（約 13:30 完成）就是當天定案盤中值
//     （估全日量已等於實際全日量、收盤即時價已定），比退回「昨收」合理太多。所以對這段時間
//     放寬到 CLOSED_STALE_MS——一路撐到 17:00 pipeline 跑完、DB 有當天資料切回 eod。
const INTRADAY_STALE_MS = 35 * 60_000;
const CLOSED_STALE_MS = 4 * 3600_000; // 13:30 那份撐到 ~17:30，足夠銜接 17:00 pipeline

// 台北交易時段（含收盤到 pipeline 之間的緩衝）：09:00–17:00 平日。
const SESSION_START_MIN = 9 * 60;
const MARKET_CLOSE_MIN = 13 * 60 + 30;
const SESSION_END_MIN = 17 * 60;

/** 台北現在時間（用 +8 偏移，避免依賴伺服器 TZ；專案其他地方也是這套路）。 */
function taipeiNow(now: Date): { iso: string; hour: number; minute: number; weekday: number } {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  return {
    iso: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(), // 0 = 週日
  };
}

/**
 * 台北平日 09:00–17:00（含收盤到 pipeline 之間）→ 允許走 intraday。
 * 回傳分鐘數（用來判斷是否已收盤、套哪個 staleness 上限）；非交易時段回 null。
 */
function taipeiSessionMinutes(t: {
  hour: number;
  minute: number;
  weekday: number;
}): number | null {
  if (t.weekday === 0 || t.weekday === 6) return null; // 週末
  const mins = t.hour * 60 + t.minute;
  if (mins < SESSION_START_MIN || mins > SESSION_END_MIN) return null;
  return mins;
}

export async function resolveDataContext(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<DataContext> {
  const latest = await prisma.dailyQuote.findFirst({
    where: { stock: { securityType: "stock" } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const latestEodDate = latest ? latest.date.toISOString().slice(0, 10) : "";

  const t = taipeiNow(now);
  const latestScan = readLatestScan({ preferRealtime: true, todayIso: t.iso });

  if (latestEodDate && latestEodDate === t.iso) {
    return { mode: "eod", asOfDate: t.iso, latestEodDate, latestScan };
  }

  const sessionMins = taipeiSessionMinutes(t);
  if (
    sessionMins !== null &&
    latestScan &&
    latestScan.source === "realtime" &&
    latestScan.timestamp
  ) {
    // 收盤前（≤13:30）套 35 分；收盤後（13:30–17:00）套 4 小時——讓 13:30 那份定案盤中值
    // 一路撐到 pipeline 跑完，不中途掉回昨收。
    const staleLimit =
      sessionMins <= MARKET_CLOSE_MIN ? INTRADAY_STALE_MS : CLOSED_STALE_MS;
    if (now.getTime() - new Date(latestScan.timestamp).getTime() < staleLimit) {
      return {
        mode: "intraday",
        asOfDate: latestScan.scanDate,
        latestEodDate,
        latestScan,
      };
    }
  }

  return { mode: "stale", asOfDate: latestEodDate, latestEodDate, latestScan };
}
