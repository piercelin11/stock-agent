# PLAN 3：盤中自動掃描 + watchlist 頁改讀 JSON

三份計劃的第三份（最後一份）。PLAN 1（daily-pipeline 穩定性）、PLAN 2（資料層統一 +
掃描腳本改造）已 merge 進 main。本份才真正改變使用者看到的東西：盤中掃描自動化、
screening 頁自動刷新、watchlist 頁改讀掃描 JSON 不再進頁打 MIS。

**分支**：`feat/intraday-auto`。merge 時機等使用者發話。

**需求來源**：使用者 2026-09-01 討論定案的三步方向——
1. 伺服器開著時，台北平日 09:00–13:30 固定整點 / 半點自動抓盤中資料並更新 screening
   （掃描變自動非手動）。
2. 掃描後**不寫 DB**（衍生值不落地），寫 JSON（PLAN 2 已鋪好 `watchlistQuotes` /
   `resultByCode` / `preferRealtime` 讀取）。
3. 選股頁 + 觀察類股頁不管時間為何都從「統一資料層」取（`resolveDataContext()`，
   PLAN 2 已建），不再各自判斷 + 各自 fallback。

**PLAN 2 已就緒的前置**：`lib/data-context.ts` 的 `resolveDataContext()` 三態
（`eod` / `intraday` / `stale`）、`intraday` 分支（台北平日 09:00–13:30 + realtime
掃描 JSON 在 `INTRADAY_STALE_MS`=35 分內）；`lib/latest-scan.ts` 的
`readLatestScan({ preferRealtime: true })` + `resultByCode` / `watchlistQuotesByCode`；
`run-signal-scan.ts` 輸出的 `watchlistQuotes` + `fromWatchlist`。本份直接消費。

---

## 0. 邊界

**新增：**

- `scripts/pipeline/intraday-scan.ts`：**新**——盤中掃描薄殼。內部判「台北平日 09:00–13:30？」
  否 → `console.log` + `process.exit(0)`（靜默）；是 → `runSignalScan(new Date(), { source: "realtime" })`
  寫 `{timestamp}.json`（`runSignalScan` 本體已負責）。**不寫 DB。** 與 `_run-signal-scan.ts`
  的差異：`_run-signal-scan.ts` 是被 Server Action `startSignalScan()` spawn 的、要寫 progress.json
  終態給前端輪詢；`intraday-scan.ts` 是被 launchd 排程觸發的、無前端在等、只需靜默跑完寫 JSON。
- `~/Library/LaunchAgents/com.piercelin.intradayscan.plist`：**新**——每日 Hour 9–13 ×
  Minute 0/30 觸發 `intraday-scan.ts`。照 `com.piercelin.dailypipeline.plist` 格式
  （node 絕對路徑 + tsx cli + 目標腳本、WorkingDirectory、log 導向）。

**動：**

- `lib/data-context.ts`：**執行中追加（原列「不動」）**——把 `intraday` 時段上界從 09:00–13:30
  延到 09:00–17:00，並依「是否已收盤」套不同 staleness（盤中 35 分 / 收盤後 4 小時）。理由：
  13:30 launchd 最後一次掃描產出的是「當天定案盤中值」（估全日量已 = 實際全日量、收盤即時價已定），
  14:00 卻掉回昨收體驗倒退。詳見 §3.6。**launchd plist 與 `intraday-scan.ts` 的時段判斷不動**
  （收盤後不需要再跑掃描，改的只是「頁面顯示哪份」）。
- `lib/actions/signal-scan.ts`：新增 `getLatestScanMeta()`——輕量 action，回
  `{ timestamp: string; source: SignalSource; scanDate: string } | null`（讀
  `readLatestScan({ preferRealtime: true })` 只取三個欄位）。給 `ScreeningPanel` 輪詢比對用。
- `components/screening/ScreeningPanel.tsx`：加一個「自動刷新」`setInterval(60_000)`
  ——輪詢 `getLatestScanMeta()`，若回傳的 `timestamp` 比目前畫面 `view.queriedAt` 新
  → 呼叫 `getSignalScanResult()`（realtime 檔）重載表格 + `resetTableState()`。手動
  「跑掃描」按鈕保留。輪詢在元件掛載即啟動，卸載清除（比照既有 `pollRef` 模式）。
- `lib/actions/watchlist.ts`：`listWatchlist` / `buildCardRow` 改成三分支資料來源
  （見 §3）。**移除進頁 `fetchAllMisQuotes` 呼叫**——MIS 只由 `intraday-scan.ts` 打。
  `WatchlistCardRow` 型別基本不變（`dataFresh` / `priceSource` / `refDate` 語意微調，見 §3.4）。
- `components/watchlist/WatchlistCard.tsx`：`FreshnessBadge` 的 `fresh` 判定、`priceSource`
  === "estimated" 的「估」badge、`refDate` 顯示——配合 §3.4 的語意（多一個「盤中」狀態）。
  `fromWatchlist` 目前 watchlist 頁不需顯示（本來就是觀察股），忽略該欄。

**不動：**

- `scripts/screening/run-signal-scan.ts`：**完全不改**。PLAN 2 已把 `watchlistQuotes` /
  `fromWatchlist` 加好，本份只消費。
- `scripts/screening/_run-signal-scan.ts`：不動（screening 頁 realtime 手動掃描仍用它）。
- `scripts/lib/*`、`scripts/pipeline/daily-pipeline.ts`、`com.piercelin.dailypipeline.plist`：不動。
- `prisma/schema.prisma`：不動。盤中掃描結果只寫 JSON。
- `lib/latest-scan.ts`：**不動**（PLAN 2 已按本份需求寫好 `preferRealtime` + `resultByCode` /
  `watchlistQuotesByCode`）。
- `lib/data-context.ts`：PLAN 2 已寫好三態骨架，本份原列「不動」，執行中因 §3.6 追加了
  「收盤後 intraday 延伸」的小改（見上「動」段）。
- `lib/actions/dashboard.ts`：不動——dashboard 的「觀察類股今日表現」是「帶量帶價第一根視角」
  的盤後分析，維持純讀 DB（`getWatchlistPerformance` 現況）。盤中即時性由 watchlist 頁負責，
  dashboard 不追。

---

## 1. `scripts/pipeline/intraday-scan.ts`

```ts
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { runSignalScan } from "../screening/run-signal-scan.js";

// 台北平日 09:00–13:30 才跑（launchd 週末也會觸發、腳本自己 skip；最後一道防線）。
// 09:00 就跑第一次也 OK——runRealtime 的 elapsedRatio < 0.05 會 push「開盤前量能不準」警語，
// 不中斷。13:30 收盤後 launchd 不再有觸發點（plist 只排到 13:00 / 13:30）。
function taipeiNow(): { hour: number; minute: number; weekday: number } {
  const s = new Date(Date.now() + 8 * 3600_000);
  return { hour: s.getUTCHours(), minute: s.getUTCMinutes(), weekday: s.getUTCDay() };
}

async function main() {
  const t = taipeiNow();
  const mins = t.hour * 60 + t.minute;
  if (t.weekday === 0 || t.weekday === 6 || mins < 9 * 60 || mins > 13 * 60 + 30) {
    console.log(`[intraday-scan] 非台北交易時段（週${t.weekday} ${t.hour}:${t.minute}），跳過。`);
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
```

- **不寫 progress.json 終態**——`runSignalScan` 的 `runRealtime` 內部已在成功時 `writeProgressDone()`
  （見 run-signal-scan.ts 第 790 行附近）。`intraday-scan.ts` 不是被 `startSignalScan()` spawn 的，
  沒有前端在輪詢它，但寫 done 態無害（下次手動掃描前會被覆蓋）。
- **與手動 realtime 掃描共存**：兩者都寫 `{timestamp}.json` 到同一目錄，檔名帶秒不會撞。
  `readLatestScan({ preferRealtime: true })` 永遠取 `queriedAt` 最新的。若使用者手動掃描時
  剛好 launchd 也觸發 → 兩份結果，取較新，無害（`progress.json` 單檔可能短暫互相覆蓋，
  但 `intraday-scan` 不看 progress，手動掃描的前端輪詢最壞是多轉一次）。

---

## 2. `com.piercelin.intradayscan.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.piercelin.intradayscan</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/piercelin/.nvm/versions/node/v22.16.0/bin/node</string>
    <string>/Users/piercelin/Desktop/web-developement/Projects/stock-agent/node_modules/tsx/dist/cli.mjs</string>
    <string>/Users/piercelin/Desktop/web-developement/Projects/stock-agent/scripts/pipeline/intraday-scan.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/piercelin/Desktop/web-developement/Projects/stock-agent</string>

  <!-- 台北平日 09:00–13:30，整點 + 半點。launchd 依系統本地時區觸發——使用者機器在 Asia/Taipei，
       所以 Hour 9–13 直接對應台北時間。週末靠 intraday-scan.ts 內部 skip（launchd 的
       StartCalendarInterval 無「僅平日」選項）。 -->
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>30</integer></dict>
  </array>

  <key>StandardOutPath</key>
  <string>/Users/piercelin/Desktop/web-developement/Projects/stock-agent/logs/intraday_scan_stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/piercelin/Desktop/web-developement/Projects/stock-agent/logs/intraday_scan_stderr.log</string>
</dict>
</plist>
```

- **一次掃描 ~20–30 秒**，兩次觸發間隔 30 分，不會重疊。launchd 對 `StartCalendarInterval`
  若上次還沒跑完會排隊，實務上不會發生。
- **13:30 那次**：收盤瞬間，`elapsedRatio` 已到 1.0，估全日量 = 實際全日量，這次結果最接近盤後。
- **無 `.ok` 標記機制**（不像 daily-pipeline）——盤中就是要每 30 分覆蓋一次，重跑是預期行為。

**部署步驟**（本份最後一個任務項，先給使用者看 plist 內容再執行）：

```bash
which node   # 確認 plist 裡 node 路徑仍有效（與 dailypipeline.plist 同一個；換過 nvm 版本要同步改兩個檔）
launchctl unload ~/Library/LaunchAgents/com.piercelin.intradayscan.plist 2>/dev/null || true
launchctl load  ~/Library/LaunchAgents/com.piercelin.intradayscan.plist
launchctl list | grep piercelin.intradayscan   # 確認登錄
# 驗證（非交易時段跑會看到 skip 訊息；交易時段跑會實際掃描）：
launchctl kickstart -k gui/$(id -u)/com.piercelin.intradayscan
cat logs/intraday_scan_stdout.log
```

---

## 3. `listWatchlist` 三分支資料來源

`resolveDataContext(prisma)` 回的 `ctx.mode` 決定：

**實作時的需求調整（2026-09-01）**：醞釀中卡片的 **K棒 / 力道 / 位階三個「單檔現算」分數**
（`candleScore` / `volumeScore` / `baseScore` + 相關 `degraded`）從 `WatchlistCardRow` 與
`FactorList` pre-breakout 分支**整個移除**。那三個正是「盤中要現算還是讀 JSON」岔路的來源；
拿掉後三個模式一律不現算它們，`buildCardRow` 也不再有「單檔現算 vs 讀 `resultByCode`」的分歧
——`stage` 一律 `consecutiveAboveBand()` 現算、`volumeRatio` 一律現算（需要當前 volume）、
PR / 醞釀籌碼一律讀 `ctx.latestScan`。醞釀中卡片底排只留「量增」。突破卡片
（`breakout-day` / `extended`）不動。

### 3.1 `mode === "eod"`（DB 有當日資料）

`buildCardRow` 用該檔最新 `DailyQuote`（`dbQuote`），`dataFresh = true`（⚡）。
`priceSource = "eod"`，`refDate = quote.date`。**與改版前輸出相同。**

### 3.2 `mode === "intraday"`（盤中 + 有夠新掃描 JSON）

- **報價**：`ctx.latestScan.watchlistQuotesByCode.get(code)`（PLAN 2 §3.2 產出的即時報價）。
  - `close` / `changePercent` / `volume`（估全日量）/ `priceSource`（`"realtime"` 或 `"estimated"`）
    / `refDate` 直接取。
  - 該 code 不在 `watchlistQuotesByCode`（MIS 沒抓到 / z·h 皆缺）→ **退回該檔 `dbQuote` 昨收**
    （priceSource `"eod"`、`refDate` = dbQuote.date），視為個別 fallback，不影響其他檔。
- **volumeRatio**：一律現算 = `effectiveVolume`（上面的估全日量）÷ T-1 `volumeMa20`。
- **stage**：`consecutiveAboveBand()` 現算（[0] 用當下 close、歷史筆用 DB `quoteWindow` 真實收盤，
  上軌是 T-1 的，可接受）。
- **強度 PR / 醞釀籌碼**：`ctx.latestScan` 的 `prByCode`（`relativeStrength`）/ `preInstByCode`
  （`trustScore` / `otherInstScore` / detail）。PLAN 2 豁免 gate 後這些對觀察股都有值。
  `preferRealtime: true` 讀取，眼下就是剛跑完的 intraday 掃描結果。
- **freshness**：`dataFresh = false`（🕐——盤中即時，非今日交易日定案）。
- **卡片日期字串**：`盤中 {refDate}`。

### 3.3 `mode === "stale"`（盤外 / 無夠新 JSON）

- **報價**：該檔 `dbQuote` 昨收。`priceSource = "eod"`，`refDate = dbQuote.date`。
- **volumeRatio / stage / PR / 醞釀籌碼**：同 §3.2（volumeRatio 用 DB 當日量現算；
  PR / 籌碼讀 `ctx.latestScan`——`preferRealtime` 可能讀到今早最後一次掃描或昨天 eod，
  `relativeStrengthStale` = `scan.scanDate !== refDate` 時卡片 PR 旁加 🕐）。
- **freshness**：`dataFresh = false`（🕐）。**卡片標「收盤定案 {ctx.latestEodDate}」**——盤外看到的
  是收盤價、不是即時，本份對使用者的明確化。

### 3.4 `WatchlistCardRow` 型別 / `FreshnessBadge` 語意

- **移除欄位**：`candleScore` / `volumeScore` / `baseScore` / `degraded`（見本節開頭的需求調整）。
- `dataFresh: boolean`：僅 `mode === "eod"` 為 true（⚡）。`intraday` / `stale` 皆 false（🕐）。
- `priceSource`：enum 不變（`"eod"` / `"realtime"` / `"estimated"`）。`intraday` 用
  `"realtime"` / `"estimated"`；`eod` / `stale` 一律 `"eod"`。
- 新增 `mode: DataMode` + `latestEodDate: string`：`WatchlistCard` 據此自組日期字串
  （`stale` → `收盤定案 {latestEodDate}`、`intraday` → `盤中 {refDate}`、`eod` → `{refDate}`）。
- `buildCardRow` 簽章從 `(item, dataFresh, misQuotes, elapsedRatio, scan)` 改成 `(item, ctx)`
  ——`ctx: DataContext` 帶 `mode` / `latestScan` / `latestEodDate`，不再傳 misQuotes。

### 3.5 移除的東西

- `listWatchlist` 開頭的 `fetchAllMisQuotes` 呼叫 + `computeElapsedRatio` + `misQuotes` /
  `elapsedRatio` 參數傳遞。
- `import { fetchAllMisQuotes, computeElapsedRatio, type MisQuote } from "../../scripts/lib/mis-quotes"`
  整行刪（`watchlist.ts` 其他地方沒用到）。
- `buildCardRow` 內所有 `mis`（MisQuote）分支 → 讀 `ctx.latestScan.watchlistQuotesByCode`。
- `computeCandleShape` / `computeBase` import + K棒/力道/位階現算段 + `BASE_MIN_HISTORY` /
  `taipeiTodayIso` 常數/helper（隨三分數移除一併清掉）。`FactorList.tsx` 的 `ScoreCell` /
  `scoreClass` 移除，pre-breakout 分支只留一個「量增」`Cell`。

### 3.6 收盤後 intraday 延伸（`lib/data-context.ts` 執行中追加）

**問題**：`intraday` 分支原本只在台北 09:00–13:30 成立。13:30 launchd 最後一次掃描產出的
JSON 是「當天定案盤中值」——`elapsedRatio` 已到 1.0、估全日量 = 實際全日量、收盤即時價已定，
是當天最準的一份。但 14:06（超過 35 分 staleness）就掉回 `stale`（DB 昨收），13:00 看即時、
14:00 看昨收，體驗倒退。

**改法**（只動 `lib/data-context.ts`）：
- `intraday` 時段上界 09:00–13:30 → **09:00–17:00**（`SESSION_END_MIN = 17*60`）。
- staleness 依「是否已收盤」分兩段：
  - 盤中（≤13:30，`MARKET_CLOSE_MIN`）→ `INTRADAY_STALE_MS`（35 分，launchd 每 30 分跑 + 緩衝）。
  - 收盤後（13:30–17:00）→ `CLOSED_STALE_MS`（4 小時）——讓 13:30 那份 JSON 撐到 ~17:30，
    足夠銜接 17:00 pipeline 跑完切 `eod`。
- `isTaipeiTradingHours()`（回 boolean）改成 `taipeiSessionMinutes()`（回分鐘數 / null），
  用分鐘數判斷套哪個上限。

**不動**：`com.piercelin.intradayscan.plist`（維持 09:00–13:30 那 10 個觸發點——收盤後不需
再跑掃描）、`intraday-scan.ts` 內部的 09:00–13:30 skip 判斷（那是「要不要跑掃描」，正確）。
改的只是「頁面該顯示哪份資料」。

**一天狀態**：`stale`（半夜）→ `intraday`（09:00 起，盤中每半小時更新）→ `intraday`
（13:30–17:00 顯示定案盤中值）→ `eod`（17:00 pipeline 跑完）。純邏輯模擬 10 案全過
（scratchpad，不入 repo）。

---

## 4. `getLatestScanMeta()` + `ScreeningPanel` 自動刷新

### 4.1 action

```ts
// lib/actions/signal-scan.ts
// 最終版：只讀最新 realtime {timestamp}.json（不用 readLatestScan / preferRealtime 去比 eod）。
// getSignalScanResult() 共用同一個 readLatestRealtimeFile()。
function readLatestRealtimeFile(): SignalScanOutput | null { /* readdir {timestamp}.json 取最新 */ }

export async function getLatestScanMeta(): Promise<{
  timestamp: string;
  source: SignalSource;
  scanDate: string;
} | null> {
  const rt = readLatestRealtimeFile();
  if (!rt) return null;
  return { timestamp: rt.queriedAt, source: rt.source, scanDate: rt.date };
}
```

理由：自動刷新是「盤中每半小時換上新掃描」的機制，只在 realtime 情境有意義。用
`preferRealtime` 去比 eod 檔的 `queriedAt`，會在「同一天既跑過盤後又跑過盤中、realtime 檔
`queriedAt` 剛好較新」時把正式盤後結果蓋掉（2026-09-01 事故，見 §4.3）。

### 4.2 `ScreeningPanel` 輪詢

- 新 `useEffect`：`setInterval(async () => { ... }, 60_000)`，掛載啟動、卸載 `clearInterval`。
  interval callback 讀 `viewRef` / `scanBusyRef`（`useRef` 鏡射 state），不因 state 變動重建 interval。
- 每次：跳過條件 `scanBusyRef.current`（手動掃描進行中）**或 `viewRef.current.source !== "realtime"`**
  （畫面在盤後結果時不該撿 realtime 檔）。否則 `const meta = await getLatestScanMeta()`，若
  `new Date(meta.timestamp) > new Date(v.queriedAt)` → `getSignalScanResult()` → `setView` +
  `resetTableState()`。
- UI 提示：`view.source === "realtime"` 時「查詢時間」旁顯示「每分鐘自動更新」。

### 4.3 進頁載入邏輯修正（「昨」badge 事故，2026-09-01）

**問題**：`ScreeningPanel` 掛載時的 useEffect（原本給「realtime 背景掃描切走又回來接管」用）有一段
`p?.status === "done" && !view → getSignalScanResult() → setView`。`progress.json` 的 `done` 態
**會無限期殘留**（上次 realtime 掃描終態，直到下次掃描才覆蓋）。盤後進頁時：`getScanMode()` 回
`eod`（`resolveDataContext()` 判斷正確），但**它只改「跑掃描」按鈕的文案，不碰 `view`**；而這段
掛載 useEffect 卻讀到幾小時前手動 `--source=realtime` 留下的 `done`，撿回那份 realtime 殘檔顯示
→ 表格每檔 `inst.todayTrustDir === null` → 前端掛「昨」badge（realtime 路徑刻意不採當日法人）。

**根因**：`done` 分支只看 `status === "done" && !view`，沒有 staleness 檢查（`STALE_MS` 只擋
`running` 殘檔），也沒問「現在是不是 realtime 模式」。「統一入口」`resolveDataContext()` 統一的是
「用哪份**資料**」，沒統一「選股頁進頁時把 `view` 設成哪份**掃描結果**」——那條路 PLAN 3 只有
`getScanMode()`（決定按鈕行為）接了，掛載 useEffect 沒接。

**最小修法**（本份）：`done` 分支加 staleness——`DONE_STALE_MS = 30 * 60_000`（對齊 launchd 盤中
掃描間隔）。`p.status === "done" && !view && (now - updatedAt) < DONE_STALE_MS` 才撿。盤後手動跑的
realtime 殘檔通常都超過 30 分 → 不撿 → 「昨」消失。盤中 launchd 每 30 分產出、`done` 一直夠新 →
維持接管行為。
（不加 `mode` 守衛：`mode` 由另一個 useEffect 非同步設，掛載即跑時可能還是 null；`DONE_STALE_MS`
已足夠。徹底解法是 PLAN 4——移除 toggle + 背景任務，選股頁進頁一律走 `resolveDataContext()`。）

---

## 5. 收尾

- `pnpm exec tsc --noEmit` 乾淨。
- `pnpm tsx --test scripts/lib/signal-factors/factors.test.ts`（不受影響）。
- **`intraday-scan.ts` 驗證**：
  - 非交易時段直接 `pnpm tsx scripts/pipeline/intraday-scan.ts` → 印「非台北交易時段，跳過」、exit 0。
  - 交易時段（或臨時把時段判斷註解掉）跑一次 → 寫出 `{timestamp}.json`，含 `watchlistQuotes` +
    觀察股 `fromWatchlist` results。log 印「完成：全市場 N · 過 gate M · 觀察股豁免 K」。
- **launchd 部署 + 驗證**：§2 的部署步驟。`launchctl kickstart` 冷觸發一次看 log。
- **watchlist 頁三分支驗證**（打使用者 dev server `curl http://localhost:3000/watchlist`）：
  - `eod`（daily-pipeline 跑過、今天有 DailyQuote）→ 卡片 ⚡、數字同改版前。
  - `intraday`（今天沒 DailyQuote、盤中、intraday-scan 剛跑過）→ 卡片 🕐、報價來自
    `watchlistQuotes`（即時價 / 估價 badge）、PR 與醞釀籌碼有值（豁免 gate 之效）、
    **無 MIS 呼叫**（觀察 dev server log 沒有打 mis.twse.com.tw）。
  - `stale`（盤外）→ 卡片 🕐 + 「收盤定案 {date}」、報價 = DB 昨收。
  - 三態切換可用「臨時改 `resolveDataContext` 的判斷 / 改系統時間 / 刪掉今天的 DailyQuote」
    其中一種手法驗，或直接等隔天盤中自然驗。
- **screening 頁自動刷新驗證**：realtime 模式開著頁面 → 手動跑一次 `intraday-scan.ts` 產生新
  `{timestamp}.json` → 60 秒內畫面表格自動更新（`view.queriedAt` 變新）。
- 更新 `docs/PROGRESS.md`：新增「盤中自動掃描 + watchlist 改讀 JSON」段——記 launchd 每 30 分、
  intraday-scan 與 _run-signal-scan 的分工、watchlist 三分支、移除進頁 MIS 的理由（MIS 只打一次）、
  screening 自動刷新、實測。
- 更新 `CLAUDE.md`：
  - `scripts/pipeline/` 段——新增 `intraday-scan.ts`（盤中掃描薄殼，launchd 每 30 分、台北平日
    09:00–13:30，內部判時段 skip，不寫 DB）。
  - `com.piercelin.intradayscan.plist` —— 新增段（Hour 9–13 × Minute 0/30，週末靠腳本 skip，
    **已部署到 launchd**）。
  - `/screening` 頁段——補「realtime / intraday 模式每 60 秒輪詢 `getLatestScanMeta()` 自動刷新表格」。
  - `/watchlist` 頁段——**大改**：資料源從「A 方案：一進頁自動打 MIS」改成「三分支：
    `resolveDataContext().mode` → `eod` 讀 DB / `intraday` 讀最新 realtime 掃描 JSON 的
    `watchlistQuotes` + `resultByCode` / `stale` 讀 DB 昨收 + 標『收盤定案』。**進頁不再打 MIS**，
    盤中即時報價由 `intraday-scan.ts`（launchd 每 30 分）統一產出」。
  - `signal-scan.ts` action 段——補 `getLatestScanMeta()`。
  - 「背景任務」段——補：`intraday-scan.ts` 是 launchd 觸發的排程（不是 Server Action spawn），
    與 `_run-signal-scan.ts`（`startSignalScan()` spawn）並存、寫同一個 `{timestamp}.json` 目錄。
- 更新 `README.md`：「使用方式」補 `intraday-scan.ts` 與盤中自動掃描說明；「目前功能」的觀察清單
  / 選股頁描述若提及資料來源，同步。
- `docs/ROADMAP.md`：若 4.5.x 有「盤中即時性 / 自動掃描」相關 todo 項，打勾；本輪三份 PLAN
  完成後，若整段完成，回覆時提醒使用者。
- `git rm` 無。

---

## 6. 本份 merge 後

「資料源統一 + 盤中即時性」的第一輪收尾。已達成：
- daily-pipeline 冷進程穩定性（PLAN 1）
- 資料脈絡判斷收斂到 `resolveDataContext()` 單一 helper（PLAN 2）
- 6226 PR / 醞釀籌碼空白已解（PLAN 2 豁免 gate）
- 盤中每 30 分 launchd 自動掃描、watchlist 頁改讀 JSON 不再進頁打 MIS（PLAN 3）
- 收盤後 intraday 延伸到 17:00（§3.6）、自動刷新只認 realtime 檔（§4.1）、進頁 done 殘檔
  加 staleness 擋「昨」badge（§4.3）

**留給 PLAN 4**：選股頁 `ScreeningPanel` 仍有 toggle（盤後/盤中）+ realtime 背景任務
（`_run-signal-scan.ts` spawn + `progress.json` 輪詢 + 進頁接管）這套 ROADMAP 4.5.3 時代的
設計。launchd 每 30 分自動產出 JSON 之後，這套已過時——前端不需要自己 spawn 掃描 + 顧進度。
PLAN 4 移除 toggle、移除背景任務，讓選股頁進頁一律走 `resolveDataContext()`（跟 watchlist 同
心智模型），「昨」bug 的完整解法也在 PLAN 4（本份 §4.3 只是 staleness 擋掉）。
