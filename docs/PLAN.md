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
- `lib/data-context.ts` / `lib/latest-scan.ts`：**不動**（PLAN 2 已按本份需求寫好 `intraday`
  分支與 `preferRealtime`）。
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

### 3.1 `mode === "eod"`（DB 有當日資料）

現況邏輯——`buildCardRow` 用該檔最新 `DailyQuote`（`dbQuote`），`dataFresh = true`（⚡）。
`priceSource = "eod"`，`refDate = quote.date`。**與現在完全相同。**

### 3.2 `mode === "intraday"`（盤中 + 有夠新掃描 JSON）

- **報價**：`ctx.latestScan.watchlistQuotesByCode.get(code)`（PLAN 2 §3.2 產出的即時報價）。
  - `close` / `changePercent` / `volume`（估全日量）/ `priceSource`（`"realtime"` 或 `"estimated"`）
    / `refDate` 直接取。
  - 該 code 不在 `watchlistQuotesByCode`（MIS 沒抓到 / z·h 皆缺）→ **退回該檔 `dbQuote` 昨收**
    （priceSource `"eod"`、`refDate` = dbQuote.date），視為個別 fallback，不影響其他檔。
- **分項**：`ctx.latestScan.resultByCode.get(code)`——
  - 有（觀察股在掃描 results[]，因 PLAN 2 豁免 gate，通常都有）→ 直接拿 `stage` / `scores` /
    `volumeRatio` / `inst` / `factors` / `preInst` / `degraded`。**不需前端現算。**
  - 沒有（掃描當下該股已下市 / MIS 全缺跳過 / 掃描還沒跑過觀察股）→ 前端現算 K棒/力道/位階
    （現況 `buildCardRow` 已有這段 `computeCandleShape` / `computeVolumeStrength` / `computeBase`），
    `stage` 用 `consecutiveAboveBand()` 現算（現況已有），`inst` / `factors` / `preInst` 走現況
    的「讀 eod 掃描結果」或 null。
- **強度 PR / 醞釀籌碼**：`resultByCode` 的 `scores.relativeStrength` / `preInst`（PLAN 2 豁免 gate
  後這些對觀察股都有值了）。現況「讀最近 eod 掃描」的 `readLatestScan()`（無 preferRealtime）
  改成統一走 `ctx.latestScan`。
- **freshness**：`dataFresh = false`（🕐——盤中即時，非今日交易日定案）。這與現況「抓到即時仍 🕐」一致。

### 3.3 `mode === "stale"`（盤外 / 無夠新 JSON）

- **報價**：該檔 `dbQuote` 昨收。`priceSource = "eod"`，`refDate = dbQuote.date`。
- **分項**：`ctx.latestScan`（`preferRealtime` 可能仍讀到今早最後一次掃描，也可能是昨天 eod）——
  - `resultByCode` 有 → 用（但 `refDate` 與掃描日期不符時，PR / 籌碼標「🕐」，現況已有
    `relativeStrengthStale` 這類欄位）。
  - 沒有 → 前端現算（同 §3.2 的 fallback）。
- **freshness**：`dataFresh = false`（🕐）。**卡片標「收盤定案 {ctx.latestEodDate}」**——這是本份
  對使用者的明確化：盤外看到的是收盤價，不是即時。

### 3.4 `WatchlistCardRow` 型別 / `FreshnessBadge` 語意

- `dataFresh: boolean`：僅 `mode === "eod"` 為 true（⚡）。`intraday` / `stale` 皆 false（🕐）。
  **與現況一致**（現況也是「只有 DB 當日交易日才 ⚡」）。
- `priceSource`：多一個實質狀態但 enum 不變（`"eod"` / `"realtime"` / `"estimated"`）。
  `intraday` 用 `"realtime"` / `"estimated"`；`stale` 一律 `"eod"`。
- 新增（optional）`asOfLabel?: string`：`stale` 時 = `"收盤定案 {latestEodDate}"`，其他 mode
  不帶。`WatchlistCard` 有此欄就在 `refDate` 附近顯示。或直接複用現有 `refDate` 顯示 + 一個
  `mode` 欄位讓卡片自己組字串——擇一，傾向後者（`WatchlistCardRow` 加 `mode: DataMode`）。
- `buildCardRow` 的簽章從 `(item, dataFresh, misQuotes, elapsedRatio, scan)` 改成
  `(item, ctx, scanResult?)`——`ctx` 帶 mode / latestScan，不再傳 misQuotes（MIS 不在這裡打了）。

### 3.5 移除的東西

- `listWatchlist` 開頭的 `fetchAllMisQuotes` 呼叫 + `computeElapsedRatio` + `misQuotes` / `elapsedRatio`
  參數傳遞。
- `import { fetchAllMisQuotes, computeElapsedRatio, type MisQuote } from "../../scripts/lib/mis-quotes"`
  ——若 `watchlist.ts` 其他地方沒用到 mis-quotes 就整行刪。
- `buildCardRow` 內所有 `mis`（MisQuote）分支：`mis && (mis.price !== null || mis.high !== null)` 那段
  改成讀 `ctx.latestScan.watchlistQuotesByCode`。

---

## 4. `getLatestScanMeta()` + `ScreeningPanel` 自動刷新

### 4.1 action

```ts
// lib/actions/signal-scan.ts
export async function getLatestScanMeta(): Promise<{
  timestamp: string;
  source: SignalSource;
  scanDate: string;
} | null> {
  const s = readLatestScan({ preferRealtime: true });
  if (!s) return null;
  return { timestamp: s.timestamp, source: s.source, scanDate: s.scanDate };
}
```

### 4.2 `ScreeningPanel` 輪詢

- 新 `useEffect`：`setInterval(async () => { ... }, 60_000)`，掛載啟動、卸載 `clearInterval`。
- 每次：`const meta = await getLatestScanMeta()`。若 `meta && view && new Date(meta.timestamp) > new Date(view.queriedAt)`
  → `const res = await getSignalScanResult(); setView(res); resetTableState();`（比照現況 realtime
  掃完的處理）。
- **不與手動掃描的 `pollRef` 衝突**：手動 realtime 掃描進行中（`scanBusy === true`）時，自動刷新
  輪詢跳過（`if (scanBusy) return;`）——避免掃到一半被半成品覆蓋。
- **eod 模式頁面也開輪詢無害**：eod 模式下 `getLatestScanMeta()` 回的是 eod 檔或早上的 realtime 檔，
  `timestamp` 不會比剛跑完的 eod `view.queriedAt` 新 → 不觸發重載。
- UI 提示：表格上方「查詢時間」旁，自動刷新啟用時加一個小字「每分鐘自動更新」（僅 realtime /
  intraday 語境；eod 不顯示）。

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

## 6. 三份 PLAN 完成後

本份 merge 後，「資料源統一 + 盤中即時性」這條線收尾。回覆使用者時確認：
- daily-pipeline 冷進程穩定性（PLAN 1）
- 資料脈絡判斷收斂到 `resolveDataContext()` 單一 helper（PLAN 2）
- 6226 PR / 醞釀籌碼空白已解（PLAN 2 豁免 gate）
- 盤中每 30 分自動掃描、screening / watchlist 頁不再各自打 MIS（PLAN 3）
並提醒可規劃下一輪內容（對照 `docs/ROADMAP.md`）。
