# PLAN 5：盤中資料源強化

四份 PLAN（資料源統一 + 盤中即時性）+ 「昨」badge 修正上線後，盤中掃描能自動跑，但三個粗糙處：

1. **realtime 掃描結果累積成垃圾**：每次一個 `{timestamp}.json`，launchd 每 30 分 + 手動重跑 →
   一週 ~50 個檔（今天目錄已 5 個、昨天 4 個）。`readLatestRealtimeFile()` 每次 `readdir + sort + at(-1)`。
2. **`fetchMisBatch` 一批失敗就整批放棄**：開盤前 / 睡眠喚醒時 MIS 常整批掛（`failedCount` 是
   120 的倍數）。09-02 早上那次 7 批全掛（`failedCount: 840 / totalStocks: 1099`）。
3. **進頁沒有「掃描明顯缺失就重抓」的機制**：`getScreeningResult()` 的 realtime 分支只是讀最新
   `{timestamp}.json`，不管那份缺多少。

**分支**：`feat/intraday-source`。merge 時機等使用者發話。

**需求來源**：PLAN 4 收尾後的討論（2026-09-03）。ROADMAP §6 已記完整決定。

---

## 0. 邊界

**動：**

- `scripts/screening/run-signal-scan.ts`：
  - `runRealtime` 寫檔的檔名從 `{timestamp}.json` 改成 **`{台北今日 YYYY-MM-DD}-intraday.json`**
    （兩處 `const timestamp = now.toISOString()...; writeResult(timestamp, ...)`）。
  - `writeResult` 改用原子寫（先寫 `.tmp` 再 `renameSync`）——每 30 分覆蓋同一檔，避免輪詢讀到寫一半。
    （eod 路徑的 `writeResult(dateStr, ...)` 也順便套原子寫，無害。）
- `scripts/lib/mis-quotes.ts`：`fetchMisBatch` 的 `catch` / `!res.ok` 分支加 `sleep` 重試（見 §2）。
- `lib/actions/signal-scan.ts`：
  - `readLatestRealtimeFile()` 改成讀固定檔名 `{台北今日}-intraday.json`（不再 `readdir + sort`）。
  - `getScreeningResult()` 的 realtime 分支加「明顯缺失 → 同步重抓」（見 §3）。
- `components/screening/ScreeningPanel.tsx`：進頁 / 重抓時的 loading 文案配合 §3（「盤中資料不完整，
  正在重新抓取…」）。

**不動：**

- `data/signal-scan-results/{YYYY-MM-DD}.json`（eod 盤後檔）：**完全不動**。盤中檔用
  `-intraday` 後綴獨立，不合併——語意衝突（盤後定案 vs 即時估價）、`getScreeningResult` 的
  「有 `{date}.json` 就不重算」快取會誤讀、`data-context` 判 `intraday` 靠 `source === "realtime"` 分不出。
- `lib/data-context.ts`：`resolveDataContext()` 三態邏輯不動。`readLatestScan({ preferRealtime })`
  （`lib/latest-scan.ts`）它內部讀「最新 `{timestamp}.json`」的邏輯——**見 §1.3，要一起改**。
- `scripts/pipeline/intraday-scan.ts` / `com.piercelin.intradayscan.plist`：不動（plist 時段已於
  2026-09-03 改成 10:00–13:30 並部署，ROADMAP §6 記錄）。
- `_run-signal-scan.ts`：已於 PLAN 4 刪除。
- 評分邏輯、gate、豁免、`watchlistQuotes`、階段判定：不動。
- 三階段命名（`pre-breakout` 等）：**PLAN 6 才統一**，本份不碰。

---

## 1. 盤中 realtime 掃描改「單一檔覆蓋」

### 1.1 檔名

`data/signal-scan-results/{台北今日 YYYY-MM-DD}-intraday.json`

- 台北今日 = `runRealtime` 已有的 `dateStr = taipeiTodayIso(now)`。
- launchd 每 30 分跑 → 覆蓋同一天的這個檔。跨日自然換新檔名（前一天的 `-intraday.json` 留著，
  gitignored、無害，可日後加清理但 YAGNI）。

### 1.2 `run-signal-scan.ts` 改動

- `runRealtime` 兩處寫檔（正常結束 + `prevDate === null` 的 early return）：
  ```ts
  // 舊：const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  //     writeResult(timestamp, output, config);
  // 新：
  writeResult(`${dateStr}-intraday`, output, config);
  ```
- `writeResult` 改原子寫：
  ```ts
  function writeResult(nameStamp: string, out: SignalScanOutput, config: SignalScanConfig): void {
    mkdirSync(RESULT_DIR, { recursive: true });
    const outputPath = join(RESULT_DIR, `${nameStamp}.json`);
    const body = JSON.stringify({ ...out, params: config }, null, 2);
    writeFileSync(`${outputPath}.tmp`, body);
    renameSync(`${outputPath}.tmp`, outputPath);
    console.log(`\n結果已寫入 ${outputPath}`);
  }
  ```
  （`renameSync` 已從 `node:fs` import——檔頭已有 `mkdirSync, writeFileSync, renameSync`。）
- **eod 路徑 `writeResult(dateStr, ...)` 不用改檔名**（`{date}.json` 維持），但套原子寫沒差。

### 1.3 `lib/latest-scan.ts` 的 `readLatestScan({ preferRealtime })`

現在它讀「`data/signal-scan-results/` 裡最新的 `{timestamp}.json`」（`readdir` 過濾
`/^\d{4}-\d{2}-\d{2}T.*\.json$/` 再 sort）。改成讀固定檔名：

- `readLatestScan({ preferRealtime: true })` 的 realtime 部分 → 讀 `{台北今日}-intraday.json`。
  沒有 → 該來源視為不存在（回 null / 跳過），比照現況「沒有 `{timestamp}.json`」的處理。
- **注意**：`readLatestScan` 收 `now?` 嗎？現在沒有——它是純讀檔。要拿「台北今日」得在
  `latest-scan.ts` 自己算（`new Date(Date.now() + 8*3600_000).toISOString().slice(0,10)`，比照
  其他檔）。或讓呼叫端（`data-context.ts` 已有 `taipeiNow`）傳日期字串進去。傾向後者——
  `readLatestScan({ preferRealtime: true, todayIso })`，`data-context` 傳 `t.iso`。
- **跨日殘留防呆**：若 `{昨天}-intraday.json` 還在、`{今天}-intraday.json` 沒有（今天 launchd
  還沒跑第一次）→ 讀不到今天的 → `data-context` 走 `stale`（正確，今天還沒有盤中資料）。
  不要 fallback 去讀昨天的 `-intraday`。

### 1.4 `signal-scan.ts` 的 `readLatestRealtimeFile()`

```ts
// 舊：readdir RESULT_DIR，過濾 {timestamp}.json，sort，at(-1)，讀。
// 新：
function readLatestRealtimeFile(): SignalScanOutput | null {
  const todayIso = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const path = join(RESULT_DIR, `${todayIso}-intraday.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SignalScanOutput;
  } catch {
    return null;
  }
}
```

`getScreeningResult()` / `getScreeningContext()` 呼叫它的地方不用改。

---

## 2. `fetchMisBatch` 加重試

`scripts/lib/mis-quotes.ts`，`fetchMisBatch`：

- 現在：一次 `fetch` → `!res.ok` 或 `catch` → `return { quotes: [], failed: true }`。
- 改：包一層重試迴圈。

```ts
const BATCH_RETRIES = 2;        // 總嘗試 2 次（原 1 次 + 重試 1 次）
const BATCH_RETRY_DELAY_MS = 2000;

export async function fetchMisBatch(codes: {...}[]): Promise<{ quotes: MisQuote[]; failed: boolean }> {
  const url = ...; // 組 URL（不變）

  for (let attempt = 1; attempt <= BATCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        if (attempt < BATCH_RETRIES) {
          console.warn(`⚠ MIS 批次 ${res.status}，${BATCH_RETRY_DELAY_MS}ms 後重試（${codes.length} 檔）`);
          await sleep(BATCH_RETRY_DELAY_MS);
          continue;
        }
        console.warn(`⚠ MIS 批次請求失敗: ${res.status} ${res.statusText}（${codes.length} 檔）`);
        return { quotes: [], failed: true };
      }
      const body = ...;  // 解析（不變）
      return { quotes, failed: false };
    } catch (err) {
      if (attempt < BATCH_RETRIES) {
        console.warn(`⚠ MIS 批次例外，${BATCH_RETRY_DELAY_MS}ms 後重試: ${err instanceof Error ? err.message : err}（${codes.length} 檔）`);
        await sleep(BATCH_RETRY_DELAY_MS);
        continue;
      }
      console.warn(`⚠ MIS 批次請求例外: ${err instanceof Error ? err.message : String(err)}（${codes.length} 檔）`);
      return { quotes: [], failed: true };
    }
  }
  return { quotes: [], failed: true }; // 理論上到不了
}
```

- `sleep` helper 檔頭已有。
- **成本**：最壞情況每批多 2 秒。16 批全失敗 = 多 32 秒。但正常只 1–2 批偶爾失敗 → 多 2–4 秒。
  可接受（掃描本來 20–30 秒）。
- **共用**：`intraday-scan.ts`（launchd）、`getScreeningResult({ force: "realtime" })`（手動立即掃描）
  都走 `fetchAllMisQuotes` → `fetchMisBatch`，一起受益。

---

## 3. 進頁 fallback：明顯缺失 → 同步重抓

### 3.1 判定「明顯缺失」

`SignalScanOutput.stats` 有 `failedCount`（整批失敗的檔數）+ `totalStocks`。

```
明顯缺失 ⟺ failedCount / totalStocks > 0.10
```

- **只用 `failedCount` 佔比**。**不用 `estimatedCount`**——缺 `z` 用 `high` 代入是 MIS 端點
  常態（每份都 1600+ 檔 estimated），拿來當觸發條件會每次進頁都重跑。
- 今天實測對照：`120/1776 = 6.8%` → 不觸發（1 批掛可接受）；`840/1099 = 76%` → 觸發。
- `totalStocks === 0`（整份空 / 非交易日）→ 不套這個判定（走既有的 `isNonTradingDay` / 空結果處理）。

### 3.2 `getScreeningResult()` realtime 分支改動

```ts
// signal-scan.ts，getScreeningResult()，mode === "realtime" 且 !opts.force 的分支：
const rt = readLatestRealtimeFile();
if (!rt) return null;                       // 沒有今日 intraday 檔 → 前端顯示「尚無掃描結果」

const total = rt.stats.totalStocks ?? 0;
const failed = rt.stats.failedCount ?? 0;
const grosslyIncomplete = total > 0 && failed / total > 0.10;

if (grosslyIncomplete) {
  // 方案 A：直接同步重跑一次，覆蓋 {date}-intraday.json，回新結果。
  //   卡 Server Action ~30 秒（+ fetchMisBatch 重試最壞再多幾秒）。前端 loading 文案負責解釋。
  const out = await runSignalScan(new Date(), { prisma, source: "realtime" });
  return toView(out);
}
return toView(rt);
```

- `runSignalScan(realtime)` 內部就會寫 `{date}-intraday.json`（§1.2 改好），所以重跑 = 覆蓋。
- **`opts.force === "realtime"`（使用者按「立即掃描」）路徑不變**——本來就是同步重跑。
- **不做背景 spawn + 輪詢**（方案 C 排除，見 ROADMAP §6）。

### 3.3 前端 loading 文案

`ScreeningPanel.tsx` 進頁 `getScreeningResult()` 正在跑時（`loading` state）：

- 現況文案（PLAN 4）：大概是「載入中…」之類。
- 加判斷：如果 `ctx.mode` 是 `intraday` / `stale`，loading 文案顯示
  **「盤中資料不完整或尚未產出，正在抓取全市場即時報價…（約 20–30 秒）」**。
- 因為進頁時前端還不知道「這次是直接讀檔（快）還是要重抓（慢）」，文案寫成涵蓋兩種情況的
  中性版本即可。或：`getScreeningContext()` 多回一個 `willRefetch: boolean`（context 端先讀一次
  `{date}-intraday.json` 判 `failedCount` 佔比），前端據此決定顯示「載入中」還是「重新抓取中（約 30 秒）」。
  傾向後者——體感差很多（讀檔 <1 秒 vs 重抓 30 秒），值得讓文案準確。
- `getScreeningContext()` 加 `willRefetch`：
  ```ts
  // context 端：mode 非 eod 時，讀 {date}-intraday.json 判斷
  const rt = readLatestRealtimeFile();
  const willRefetch =
    ctx.mode !== "eod" &&
    (!rt || (rt.stats.totalStocks > 0 && (rt.stats.failedCount ?? 0) / rt.stats.totalStocks > 0.10));
  ```
  （`!rt` 也算 `willRefetch` = true？——沒有 intraday 檔時 `getScreeningResult` 回 null，不會重抓，
  前端顯示「尚無掃描結果 + 立即掃描按鈕」。所以 `willRefetch` 只在「有檔但缺很多」時 true。
  `!rt` 時 `willRefetch = false`。修正上面的 `!rt ||` → 拿掉。）

---

## 4. 收尾

- `pnpm exec tsc --noEmit` 乾淨。
- `pnpm tsx --test scripts/lib/signal-factors/factors.test.ts`（不受影響）。
- **驗證**：
  - **單一檔覆蓋**：手動跑兩次 `pnpm tsx scripts/pipeline/intraday-scan.ts`（非交易時段會 skip，
    可暫時註解時段判斷）→ `data/signal-scan-results/` 只多一個 `{今日}-intraday.json`、第二次覆蓋
    不新增檔。原子寫：跑的過程中 `ls` 看得到短暫的 `.tmp`。
  - **`readLatestRealtimeFile` / `readLatestScan`**：改讀固定檔名後，`getScreeningContext()` /
    `resolveDataContext()` 在 `intraday` 模式仍正確拿到那份。跨日殘留：把檔案改名成
    `{昨天}-intraday.json` → 進頁應走 `stale`，不誤讀昨天的。
  - **`fetchMisBatch` 重試**：不好造網路失敗，靠 code review 確認重試迴圈邏輯 + 至少跑一次
    完整掃描確認沒把正常流程改壞（`failed: false` 時第一次就 return，不進重試）。
  - **明顯缺失重抓**：造一份 `failedCount` 佔比 > 10% 的假 `{今日}-intraday.json`（手改 stats）→
    進 `/screening` → 應觸發同步重跑（loading 顯示「重新抓取中（約 30 秒）」）→ 跑完覆蓋、
    `failedCount` 正常。造一份 `failedCount` 佔比 6%（1 批）的 → 進頁應**直接讀檔顯示**，不重抓。
  - **盤中真實驗證**：下個交易日 10:00 後開著電腦，看 `logs/intraday_scan_stdout.log` 的
    `failedCount`（期望比之前低，重試生效）、`data/signal-scan-results/` 不再累積時間戳檔。
- 更新 `docs/PROGRESS.md`：新增「盤中資料源強化（PLAN 5）」段——單一檔覆蓋（+ 不合併盤後檔的
  理由）、`fetchMisBatch` 重試、明顯缺失 `failedCount>10%` → 方案 A 同步重抓（為何不用 estimatedCount /
  為何不用背景 spawn）、實測數字。
- 更新 `CLAUDE.md`：
  - `run-signal-scan.ts` 段——realtime 輸出檔名 `{timestamp}.json` → `{date}-intraday.json`（單一檔
    每 30 分原子覆蓋）；`writeResult` 原子寫。
  - `lib/latest-scan.ts` / `signal-scan.ts` action 段——`readLatestRealtimeFile` / `readLatestScan`
    改讀固定 `{今日}-intraday.json`；`getScreeningResult` realtime 分支加「`failedCount/totalStocks
    > 10%` → 同步重抓覆蓋」；`getScreeningContext` 加 `willRefetch`。
  - `scripts/lib/mis-quotes.ts` 段——`fetchMisBatch` 加 `BATCH_RETRIES=2` / `BATCH_RETRY_DELAY_MS=2000`。
  - `com.piercelin.intradayscan.plist` 段——時段 09:00–13:30 → 10:00–13:30（順手修正，2026-09-03 已部署）。
- 更新 `README.md`：若「使用方式」提及盤中掃描產出檔名 / 選股頁行為，同步。
- `docs/ROADMAP.md`：§6 四個 checkbox 完成的打勾（plist 那項已 `[x]`）；PLAN 5 完成後在回覆裡
  提醒使用者可接著開 PLAN 6。
- `git rm` 無。

---

## 5. 風險 / 取捨

1. **明顯缺失重抓會卡 Server Action ~30 秒**（+ `fetchMisBatch` 重試最壞再多 ~30 秒 = 最壞 ~60 秒）。
   `willRefetch` 讓前端文案先講清楚「約 30 秒」，但使用者不能跳過。取捨：launchd 加重試後
   `failedCount > 10%` 會變罕見（今天 12:30 後三份都 0 失敗批），這條 fallback 一週觸發不到一次。
   為「罕見情況」加背景 spawn + 輪詢（方案 C）= 把 PLAN 4 剛清掉的複雜度和「昨」bug 面請回來，不值。

2. **`fetchMisBatch` 重試把最壞情況掃描時間拉長**（16 批全失敗從 ~24 秒變 ~56 秒）。但「16 批全失敗」
   本來就是「MIS 整個掛 / 沒網路」，那種情況掃出來也是空的，多等 32 秒無實質差別。正常情況
   （1–2 批偶爾失敗）只多 2–4 秒。

3. **`{date}-intraday.json` 跨日殘留**：前一天的檔留在目錄裡。`readLatestScan` / `readLatestRealtimeFile`
   都讀「今日」固定檔名，讀不到就當沒有 → 走 `stale`，不會誤讀昨天的。舊檔是死檔，gitignored，
   要清另開小工作（`data/` 清理），本份不做。
