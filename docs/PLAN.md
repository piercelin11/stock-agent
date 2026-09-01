# PLAN 4：選股頁簡化——移除 toggle + realtime 背景任務，統一走 resolveDataContext

PLAN 1–3 已 merge 進 main。本份收尾「資料源統一」——把選股頁（`/screening`）拉回跟
觀察股頁（`/watchlist`）同一個心智模型：進頁一律問 `resolveDataContext()`，它說用哪份就用哪份。

**分支**：`feat/screening-simplify`。merge 時機等使用者發話。

**需求來源**：PLAN 3 收尾時的討論。選股頁目前保留 ROADMAP 4.5.3 時代的設計：

- **盤後/盤中 toggle**（`chosenMode` state + 兩顆切換按鈕）——讓使用者手動覆蓋自動判斷。
- **realtime 背景任務**：按「開始盤中掃描」→ `startSignalScan()` spawn detached 子進程
  `_run-signal-scan.ts` → 前端每 2 秒輪詢 `progress.json` 進度條 → 切走再回來「接管輪詢」。
- **進頁掛載 useEffect** 讀 `progress.json`，`status === "done"` 就撿 `getSignalScanResult()`。

PLAN 3 加了 `intraday-scan.ts`（launchd 每 30 分自動跑 realtime 掃描寫 JSON）之後，這套就過時了
——launchd 已經在背景產出 JSON，前端根本不需要自己 spawn 掃描 + 顧進度條。而且這套是「昨」badge
事故（PLAN 3 §4.3）的根因：`progress.json` 的 `done` 態無限期殘留，盤後進頁撿到幾小時前手動跑的
realtime 殘檔。PLAN 3 §4.3 只用 `DONE_STALE_MS`(30 分) 擋掉，本份是徹底解法。

**設計原則**：選股頁 = 「讀最新掃描結果顯示 + 一顆手動重跑按鈕」。「用哪份」由
`resolveDataContext()` 決定，跟 watchlist 完全一致。realtime 掃描的產出者只剩 `intraday-scan.ts`
（launchd）——前端不再自己 spawn。

---

## 0. 邊界

**動：**

- `components/screening/ScreeningPanel.tsx`：**大幅精簡**（~696 行 → 估 ~380 行）。見 §1–§4。
- `lib/actions/signal-scan.ts`：
  - `getScanMode()` → 改名/改回傳 `getScreeningContext()`，回
    `{ mode: DataMode; asOfDate; latestEodDate; hasScan: boolean }`（直接透傳 `resolveDataContext()`
    的關鍵欄位 + 「有沒有可顯示的掃描結果」）。
  - 新增 `getScreeningResult()`：**單一入口**，依 `resolveDataContext().mode` 回對應的
    `SignalScanView | null`：
    - `eod` → 同步 `runSignalScan(latestEodDate, { source: "eod" })`（秒級，現 `runSignalScanEod` 的body）。
    - `intraday` / `stale` → 讀 `ctx.latestScan`（`readLatestScan({ preferRealtime: true })` 的
      最新 realtime 檔）→ `toView()`。無 JSON → null。
  - **刪除**：`startSignalScan()` / `getSignalScanProgress()` / `SignalScanProgress` 型別 /
    `readProgress()` / `PROGRESS_PATH` 常數 / `STALE_MS`。
  - `runSignalScanEod()`：body 併入 `getScreeningResult()` 的 eod 分支後，這個 export 可留作
    「手動強制重跑盤後」用（見 §3），或直接讓 `getScreeningResult()` 帶一個 `force?: "eod"|"realtime"` 參數。
    傾向後者（少一個 export）。
  - `getLatestScanMeta()` / `getSignalScanResult()` / `readLatestRealtimeFile()`：**保留**
    （自動刷新仍用）。
- `scripts/screening/_run-signal-scan.ts`：**刪除**（`git rm`）。唯一呼叫者是被刪的
  `startSignalScan()`。realtime 掃描的背景執行者只剩 `intraday-scan.ts`（launchd）。
- `scripts/screening/run-signal-scan.ts`：`runRealtime` 內部的 `writeProgress()` /
  `writeProgressDone()` / `PROGRESS_PATH` / `atomicWrite` **保留**——`intraday-scan.ts` 走
  realtime 路徑時仍會寫 `progress.json`（無害的終態紀錄，且 `_run-signal-scan.ts` 刪掉後
  `runRealtime` 自己寫的那份就是唯一來源）。**但前端不再讀 `progress.json`**。
  - 可選清理：`runRealtime` 的 `writeProgress`（逐批進度）現在沒有前端在看了，可保留（CLI 手動
    跑時看得到）或簡化。傾向保留，改動最小。

**不動：**

- `lib/data-context.ts` / `lib/latest-scan.ts`：不動（PLAN 2/3 已就緒）。
- `scripts/pipeline/intraday-scan.ts` / `com.piercelin.intradayscan.plist`：不動。
- `lib/actions/watchlist.ts` / `components/watchlist/*`：不動（PLAN 3 已改好，本份不碰）。
- `components/screening/SignalDetail.tsx` / `BreakoutFactorBars.tsx` / `SignalSparkPanel.tsx` /
  表格欄位定義（`columns`）/ 階段 tab / 勾選加入 watchlist：**不動**。這些是「結果怎麼呈現」，
  本份只改「結果怎麼來」。
- `run-signal-scan.ts` 的評分邏輯、gate、豁免、`watchlistQuotes`：不動。

---

## 1. 移除 toggle

- 刪 `chosenMode` / `setChosenMode` state。
- 刪模式切換 UI（`["eod", "realtime"].map(...)` 那段兩顆按鈕）。
- 刪 `eodFallbackToRealtime` / `effectiveMode` / `isRealtime` 衍生變數。
- 刪 `runScan()` 的分派邏輯（`chosenMode === "eod" && mode?.source === "eod" ? runEod() : runRealtime()`）。
- 刪「選了盤後但今天還沒有盤後資料 → fallback 盤中」的警告框（`eodFallbackToRealtime` 那段）。

**取代**：頁面標題下顯示一行當前狀態（由 `getScreeningContext()` 給）：
- `eod` → 「盤後定案 · {asOfDate}」
- `intraday` → 「盤中即時 · 每 30 分自動更新 · 截至 {asOfDate}」
- `stale` → 「盤後未跑，顯示最近一次掃描（{asOfDate}）」或「尚無掃描結果」

---

## 2. 移除 realtime 背景任務機制

刪掉這些 state / ref / function：
- `progress` / `setProgress` state、`SignalScanProgress` 型別 import。
- `scanBusy` / `setScanBusy` state、`scanBusyRef`。
- `pollRef`、`stopPolling`、`startPolling`（2 秒輪詢 `progress.json`）。
- 「掛載時接管輪詢」的整個 useEffect（第 255–284 行，含 `STALE_MS` / `DONE_STALE_MS` /
  `doneFresh` / `p.status === "running"` 接管 / `p.status === "done"` 撿結果）——**這整段就是
  「昨」badge 的根因**，直接刪。
- `runRealtime()`（前端 spawn + 輪詢那個）。
- `useEffect(() => stopPolling, [stopPolling])`。
- 進度條 UI（`scanBusy && progress?.status === "running" && progress.totalBatches > 0` 那段）。
- 「啟動中…」/「抓取即時報價中… N/M 批」/「評分中…」狀態文字。
- realtime 常駐警語框可保留（改成「盤中即時掃描每 30 分由背景排程自動跑，收盤價/量為估計值，
  與盤後不可直接比較」），或移到 §1 的狀態行 tooltip。傾向保留精簡版。

`import` 清理：`startSignalScan` / `getSignalScanProgress` / `SignalScanProgress` 從
`lib/actions/signal-scan` 的 import 移除。

---

## 3. 進頁載入 + 「跑掃描」按鈕

### 3.1 進頁載入（取代原本三個搶著設 view 的 useEffect）

單一 useEffect，掛載時：

```ts
useEffect(() => {
  let cancelled = false;
  (async () => {
    const ctx = await getScreeningContext();
    if (cancelled) return;
    setCtx(ctx);
    const res = await getScreeningResult();  // 依 ctx.mode 回對應結果（見 §0）
    if (!cancelled) { setView(res); resetTableState(); }
  })();
  return () => { cancelled = true; };
}, []);
```

- `eod` 模式：`getScreeningResult()` 同步跑一次盤後掃描（秒級）→ 表格立即有正確的盤後結果，
  **使用者不用按任何按鈕**。「昨」badge 不會出現（eod 掃描帶當日法人）。
- `intraday` / `stale` 模式：讀最新 realtime JSON。無 JSON（launchd 還沒跑過）→ `view` 為 null，
  顯示「尚無盤中掃描結果，稍候（背景每 30 分自動跑）或按『立即掃描』」。

### 3.2 「跑掃描」按鈕

- `eod` 模式 → 按鈕文案「重跑盤後掃描」，按 = `getScreeningResult({ force: "eod" })` 重跑一次。
- `intraday` / `stale` 模式 → 按鈕文案「立即掃描」，按 = **同步** `getScreeningResult({ force: "realtime" })`。
  - **這裡會卡 UI 20–30 秒**（MIS 抓全市場）。按鈕轉 `isPending` 態、顯示「掃描中…（約 30 秒）」。
  - 不再 spawn 背景子進程。使用者按了就等。盤中主要靠 launchd 自動產出，這顆按鈕是「等不及、
    現在就要一份新的」的少用路徑。
  - `force: "realtime"` 時 `getScreeningResult` 內部 `runSignalScan(new Date(), { source: "realtime" })`
    同步跑（傳前端 prisma 單例），跑完寫 `{timestamp}.json` + 回 `toView()`。

### 3.3 `getScreeningResult({ force })` 簽章

```ts
export async function getScreeningResult(
  opts: { force?: "eod" | "realtime" } = {},
): Promise<SignalScanView | null> {
  const ctx = await resolveDataContext(prisma);
  const mode = opts.force ?? (ctx.mode === "eod" ? "eod" : "realtime");

  if (mode === "eod") {
    if (!ctx.latestEodDate) return { ...空, warnings: ["資料庫尚無 DailyQuote"] };
    const out = await runSignalScan(new Date(ctx.latestEodDate), { prisma, source: "eod" });
    return toView(out);
  }
  // realtime
  if (opts.force === "realtime") {
    const out = await runSignalScan(new Date(), { prisma, source: "realtime" });
    return toView(out);
  }
  // 不 force：讀最新 realtime JSON（intraday / stale 模式的一般進頁路徑）
  const rt = readLatestRealtimeFile();
  return rt ? toView(rt) : null;
}
```

---

## 4. 自動刷新（保留，微調）

PLAN 3 §4.2 的 `setInterval(60_000)` 自動刷新**保留**，但簡化守衛：

- 舊守衛：`scanBusyRef.current`（手動掃描中）+ `viewRef.current.source !== "realtime"`。
- 新：`scanBusy` state 已刪 → 改用 `isPending`（`useTransition`，手動重跑時為 true）。
  守衛變成 `if (isPendingRef.current) return;` + `if (viewRef.current?.source !== "realtime") return;`。
- 其餘不變：每 60 秒 `getLatestScanMeta()`（只讀最新 realtime `{timestamp}.json`），比 `view.queriedAt`
  新 → `getSignalScanResult()` 重載。
- **eod 模式下 `view.source === "eod"` → 守衛擋住 → 自動刷新不動作**。正確：盤後結果不該被
  launchd 的 realtime 掃描蓋掉。

---

## 5. UI 結果區（不動，確認）

`view` 有值後的渲染——表格、階段 tab、展開列、勾選加入 watchlist、warnings 框、estimated badge
——**全部沿用現況**。只有「查詢時間 / 交易日」那行狀態文字配合 §1 調整。

---

## 6. 收尾

- `pnpm exec tsc --noEmit` 乾淨。
- `pnpm tsx --test scripts/lib/signal-factors/factors.test.ts`（不受影響）。
- `git rm scripts/screening/_run-signal-scan.ts`。
- **驗證**（打使用者 dev server）：
  - **盤後**（DB 有今日資料）：進 `/screening` → 自動顯示盤後掃描結果、狀態行「盤後定案 · {date}」、
    **無「昨」badge**、無 toggle、無進度條。按「重跑盤後掃描」→ 秒級刷新。
  - **盤中**（模擬：刪掉今日 DailyQuote 或改判斷）：進頁 → 若 `data/signal-scan-results/` 有今日
    `{timestamp}.json` → 顯示它、狀態行「盤中即時 · 每 30 分自動更新」。按「立即掃描」→ 卡 ~30 秒
    → 新結果。60 秒自動刷新：手動跑一次 `intraday-scan.ts` 產新檔 → 頁面自動換上。
  - **stale**（無任何掃描 JSON）：進頁 → 「尚無掃描結果」提示 + 「立即掃描」按鈕。
  - 切走 `/screening` 再切回：不再有「接管輪詢」邏輯——就是重新跑一次 §3.1 的進頁載入。
- 更新 `docs/PROGRESS.md`：新增「選股頁簡化（PLAN 4）」段——記移除 toggle + 背景任務的理由
  （launchd 自動掃描後過時 + 「昨」badge 根因）、`getScreeningResult()` 單一入口、`_run-signal-scan.ts`
  刪除、「立即掃描」改同步卡 UI 的取捨。
- 更新 `CLAUDE.md`：
  - `signal-scan.ts` action 段——`getScanMode` → `getScreeningContext`；新增 `getScreeningResult({force})`；
    刪 `startSignalScan` / `getSignalScanProgress` / `SignalScanProgress`。
  - `/screening` 頁段——**大改**：移除 toggle / 背景任務 / 進度條的描述；改為「進頁 `getScreeningContext()`
    → `getScreeningResult()` 依 `resolveDataContext().mode` 回結果；eod 同步跑、intraday/stale 讀
    最新 realtime JSON；一顆按鈕手動重跑（realtime 同步卡 ~30 秒）；60 秒自動刷新僅 realtime 情境」。
  - 「背景任務」段——`_run-signal-scan.ts` + `startSignalScan()` 已移除；realtime 掃描的背景執行者
    只剩 `intraday-scan.ts`（launchd）。
  - `scripts/screening/` 段——`_run-signal-scan.ts` 移除。
- 更新 `README.md`：選股頁使用方式（無 toggle、進頁即顯示、按鈕重跑）。
- `docs/ROADMAP.md`：若有對應項打勾。

---

## 7. 風險 / 取捨（先講清楚）

1. **「立即掃描」盤中會卡 UI ~30 秒**。舊設計 spawn 背景不卡。取捨：盤中主要靠 launchd 每 30 分
   自動產出，手動按鈕變少用；且省掉「spawn 子進程 + 輪詢 progress.json + 接管」一大坨易錯的
   狀態機（「昨」badge 就是它造成的）。淨值得。
   - 若日後真的常需要「盤中不等 launchd、馬上要新的又不想卡 UI」→ 再考慮讓按鈕改觸發
     `intraday-scan.ts` 的輕量 spawn（但**不做進度條、不接管**，按完就等 60 秒自動刷新撿新檔）。
     本份先不做。

2. **`getScreeningResult()` 在 eod 模式進頁會同步跑一次全市場掃描**（秒級，PLAN 2 實測 ~數秒）。
   比「讀一份現成 JSON」慢。但 eod 掃描本來就沒有落地 JSON 的機制（只有 realtime 會寫
   `{timestamp}.json`，eod 寫 `{YYYY-MM-DD}.json` 但那是 `run-signal-scan.ts` CLI 行為，Server Action
   路徑的 `runSignalScanEod` 現況也是每次同步跑）。維持現狀，不新增 eod 結果快取。

3. **`run-signal-scan.ts` 的 `writeProgress` 逐批進度**：`_run-signal-scan.ts` 刪掉後，寫
   `progress.json` 的只剩 `runRealtime` 自己（CLI / `intraday-scan.ts` 走這條）。前端不讀了。
   保留無害（CLI 手動跑時 stdout 也有進度）。要不要順手刪 `writeProgress` 留給實作判斷——
   傾向保留，減少 diff。
