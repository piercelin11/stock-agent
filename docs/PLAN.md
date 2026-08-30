# PLAN：盤中即時掃描 tab（選股頁第三個策略，背景任務模式）

在既有 `/screening` 頁加第三個 tab「盤中即時掃描」，觸發 `check-intraday-breakout.ts` 對 `mis.twse.com.tw` 即時報價跑一次全市場快照。因為要打 ~16 批外部 API（120 檔/批 + 1.5 秒節流 → 20~30 秒），**不能像盤後兩支那樣同步 `await`**，改用 CLAUDE.md 記的「背景任務」模式：Server Action `spawn` detached 子進程 → 子進程逐批覆寫 `progress.json` → 另一個 Server Action 輪詢讀檔 → client `setInterval` poll 進度條，跑完讀結果檔。

這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識完成後回寫 `CLAUDE.md`，過程紀錄回寫 `docs/PROGRESS.md`，ROADMAP 對應項目打勾。

前置狀態：

- **選股頁 `/screening` 已完成**（上一份 PLAN，ROADMAP 4.1）：`components/screening/ScreeningPanel.tsx`（兩個 tab：breakout / accumulation，`useTransition` 同步跑）、`lib/actions/screening.ts`（`runScreening`）、可排序表格 + 行內展開明細 + 勾選加入觀察清單、`components/ui/Button.tsx`。
- **觀察清單頁 `/watchlist` 已完成**（ROADMAP 4.2）：`lib/actions/watchlist.ts` 的 `addToWatchlist({ codes, source })` 已支援任意 `source` 字串。
- **`checkIntradayBreakout({ prisma?, config?, now? })` 已參數化**（回測 3.1）：`main()` 是薄殼、可注入 `prisma`、`now`。但**回傳 `void`**——結果只 `writeFileSync` 到 `data/intraday-breakout-snapshots/{timestamp}.json`（`timestamp` = `now.toISOString().slice(0,19).replaceAll(":","-")`，例 `2026-08-24T07-44-34`）。
- **背景任務模式參考碼**：`feat/backtest-ui-3.6-3.7` 分支的 `lib/actions/backtest.ts`（`startLayer0Run` spawn / `getLayer0Progress` 讀檔）+ `components/BacktestRunner.tsx`（`setInterval` 2s 輪詢 + 進度條）。本 PLAN 照抄這套骨架，換成 intraday。

---

## 0. 這一批的邊界

**做四件事：**

1. **`check-intraday-breakout.ts` 加「進度回報」+「回傳結果」**：
   - 子進程執行時，每掃完一批 MIS 就覆寫 `data/intraday-breakout-snapshots/progress.json`（原子寫）。
   - `checkIntradayBreakout` 回傳型別從 `void` 改成含 `results` + `stats` + `queriedAt` + `elapsedRatio` 的物件（比照上一份 PLAN 對 breakout / accumulation 做的回傳擴充；不改落地行為、不改 CLI 輸出、不改 `results` 元素形狀）。
   - `CandidateResult` interface 改 `export`。

2. **`lib/actions/intraday.ts`（新檔）**：`startIntradayScan()`（spawn detached 子進程跑腳本，立刻回傳）、`getIntradayProgress()`（讀 `progress.json`）、`getIntradayResult()`（讀最新 `{timestamp}.json` 結果檔並轉成可序列化 rows）。

3. **`scripts/screening/_run-intraday-scan.ts`（新，薄 runner）**：被 spawn 的進入點——建立 `prisma`、呼叫 `checkIntradayBreakout({ prisma })`、包一層「開始/結束時覆寫 `progress.json` 的 `status`」。子進程的 stdout/stderr 導到檔案方便除錯。

4. **`ScreeningPanel.tsx` 加第三個 tab「盤中即時掃描」**：不同的互動（進度條 + 輪詢，不是 `useTransition`），跑完後**重用現有的表格 / 排序 / 展開明細 / 勾選加入觀察清單**（intraday rows 形狀跟 breakout rows 幾乎一樣，共用同一套 UI）。`source: "intraday"`。

**明確不在範圍**（留給後續）：

- **排程 / 自動化盤中掃描 / 通知管道** → ROADMAP 第 5 節。本批只做「手動按按鈕跑一次」，只是跑的方式是背景任務。
- **盤後兩支改成背景任務** → 不動。它們秒級、同步跑剛好，硬套背景模式是純負擔（見 CLAUDE.md「背景任務」段的判斷原則）。
- **非盤中時段的硬性阻擋** → 只在 UI 顯示警語（「盤中 09:00~13:30 才有效」+ 若 `elapsedRatio` 異常或 MIS 日期與 DB 最新相同則標紅字提示），不禁止使用者按。腳本內部已有這些 `console.warn`，本批把關鍵訊息一併寫進 `progress.json` / 結果檔的 `warnings` 陣列給 UI。
- **多個並行掃描 / 掃描歷史列表** → 同時只允許一個進行中的掃描（`progress.json` 是單檔，不帶 runId）。結果檔仍是 `{timestamp}.json` 一天可多筆，但 UI 只顯示「最近一次」。
- **`check` 的評分邏輯調整** → 完全不碰，`checkIntradayBreakout` 內部照舊（7 分項與 breakout 100% 共用）。
- **`data/intraday-breakout-snapshots/` 的 GC** → 不做（`.gitignore` 已含此目錄，手動清）。

---

## 1. 前置事實（已查證，實作時直接採用）

### 1.1 `check-intraday-breakout.ts` 現況

- `checkIntradayBreakout(options)` → `Promise<void>`。內部 `runSnapshot(prisma, config, now)` 做：抓全市場 `Stock`（`securityType="stock"`）→ `fetchAllMisQuotes`（**`for` 迴圈逐批**，`BATCH_SIZE=120`、`BATCH_DELAY_MS=1500`）→ 三層篩選（觸發 / 資格門檻 / 7 分項評分）→ `results.sort` + 編 `rank` → `console.table` → `writeFileSync`。
- `fetchAllMisQuotes(stocks)` 在 `scripts/screening/check-intraday-breakout.ts` **檔內私有函式**，`for (let i = 0; i < stocks.length; i += BATCH_SIZE)` 那個迴圈就是進度回報要插 hook 的地方。
- 落地內容：`{ queriedAt, elapsedRatio, gates, weights, stats: { totalQueried, failedCount, triggered, passedGates }, results }`。空結果分支（`passedCodes.length === 0`）也會落地一份 `results: []`。
- `CandidateResult`（**檔內未 export 的 interface**，line ~183）：`code` / `name` / `price` / `changePercent` / `volumeRatio` / `estimatedFullDayVolume` / `marketCap` / `scores{7 項}` / `totalScore` / `rank` / `degraded`。
- MIS 抓取常數（`MIS_URL` / `BATCH_SIZE` / `BATCH_DELAY_MS`）**不進 config**（CLAUDE.md 已載明），本批也不動。
- 檔頭 `import "dotenv/config"` + `import { mkdirSync, writeFileSync } from "node:fs"`——**這次要多 import `renameSync`**（原子寫 `progress.json`）。

### 1.2 背景任務模式（CLAUDE.md「背景任務」段 + `feat/backtest-ui-3.6-3.7` 參考碼）

- **spawn**：`spawn(process.execPath, [tsxCli, script, ...args], { detached: true, stdio: "ignore" | fd, cwd: REPO_ROOT })` + `child.unref()`。`tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs")`（`.npmrc` `node-linker=hoisted` → 扁平路徑解析得到）。**不要用 `pnpm tsx` / `npx tsx`**（detached 子進程解析 launcher 慢、PATH 依賴）。
- **子進程與 Next.js 連線池無關**：子進程是獨立 Node process，自己 `makePrisma()`。
- **原子寫 `progress.json`**：先寫 `.tmp` 再 `renameSync`（避免輪詢讀到寫一半）。
- **輪詢 action**：`existsSync` → `readFileSync` → `JSON.parse`，`catch` 回 `null`（可能剛好讀到 atomic write 之間空檔）。
- **client**：`useEffect` + `setInterval(async () => { const p = await getProgress(); if (p) setProgress(p); }, 2000)`，`status` 為 `done` / `error` 時 `clearInterval`。
- **REPO_ROOT**：`process.cwd()`（Next.js server 進程的工作目錄 = repo 根）。

### 1.3 選股頁現況（`ScreeningPanel.tsx`）

- `strategy: "breakout" | "accumulation"` 的 `useState`，`STRATEGY_LABELS` 對照表。
- `results: Partial<Record<ScreeningStrategy, ScreeningResult>>`——**各策略獨立保留結果**。
- `run()` 用 `startTransition(async () => setResults(...))`。
- 表格：`columns` 陣列（`breakoutColumns` / `accumulationColumns`），`Column<Row>` 型別（`key` / `label` / `get` / `render?` / `numeric?`）。可排序（`sortKey` / `sortDir` + `useMemo` sort）。行內展開（`expandedCode` state + `<Detail>` 子元件）。勾選（`selected: Set<string>` + `addToWatchlist({ codes, source: strategy })`）。
- `switchStrategy(next)` 會重置 `sortKey` / `sortDir` / `expandedCode` / `selected` / `addMsg` / `error`。

### 1.4 `addToWatchlist` 的 `source`

- `lib/actions/watchlist.ts` 的 `addToWatchlist({ codes, source?: string })`——`source` 是自由字串，直接傳 `"intraday"` 即可，schema `WatchlistItem.source` 是 `String?`（上一份 PLAN 加的）。

### 1.5 「盤中 rows」對「breakout rows」的差異（決定 UI 能共用到什麼程度）

| 欄位 | breakout row | intraday row | UI 處理 |
| --- | --- | --- | --- |
| 價格 | `close`（定案） | `price`（即時） | 欄位標題盤中版寫「即時價」 |
| 漲跌% | `changePercent` | `changePercent`（vs MIS 昨收） | 同 |
| 量比 | `volumeRatio`（定案量 / MA20） | `volumeRatio`（**估計全天量** / MA20） | 欄位加註「估」 |
| 分數 | `totalScore` + `scores{7}` | `totalScore` + `scores{7}`（**同一套評分函式**） | 展開明細完全共用 |
| `rank` / `degraded` | 有 | 有 | 同 |
| 額外 | — | `estimatedFullDayVolume` / `marketCap` | 可選顯示，非必要 |

→ **表格 columns 另開一份 `intradayColumns`**（標題文案不同），但 `Column` 型別、排序邏輯、`<Detail>` 展開（吃 `scores`）、勾選加入**全部共用**。

---

## 2. `check-intraday-breakout.ts` 改動（`scripts/screening/`）

### 2.1 進度回報 hook

`fetchAllMisQuotes` 加一個可選 callback 參數：

```ts
async function fetchAllMisQuotes(
  stocks: { code: string; market: Market }[],
  onBatch?: (done: number, total: number, failedSoFar: number) => void,
): Promise<{ quotes: Map<string, MisQuote>; failedCount: number }> {
  // ... for 迴圈內，每批結束後：
  onBatch?.(Math.min(i + BATCH_SIZE, stocks.length), stocks.length, failedCount);
}
```

- `runSnapshot` 呼叫 `fetchAllMisQuotes` 時把 callback 傳進去，callback 內原子寫 `progress.json`：
  ```jsonc
  {
    "status": "running",
    "phase": "fetching-quotes",   // "fetching-quotes" | "scoring" | "done" | "error"
    "queriedAt": "<now.toISOString()>",
    "fetchedBatches": 3, "totalBatches": 16,   // 或用 done/total 檔數
    "failedCount": 0,
    "startedAt": "<...>", "updatedAt": "<...>",
    "warnings": [],
    "error": null
  }
  ```
- `phase` 從 `fetching-quotes` → 抓完進 `scoring`（評分那段其實很快，可只覆寫一次）→ 結尾 runner 覆寫 `done`（見 §4）。
- **`progress.json` 路徑**：`join(__dirname, "..", "..", "data", "intraday-breakout-snapshots", "progress.json")`。`mkdirSync(dir, { recursive: true })` 沿用現有。
- 原子寫 helper（複製 backtest 的 `atomicWrite`）：`writeFileSync(path + ".tmp", content); renameSync(path + ".tmp", path);`——檔頭 import 加 `renameSync`。
- **`warnings`**：把 `runSnapshot` 內現有的關鍵 `console.warn`（開盤前 `elapsedRatioRaw < 0.05`、MIS 日期與 DB 最新相同）**同時 push 進一個 `warnings` 陣列**，寫進 `progress.json` 和結果檔。console.warn 保留。

### 2.2 回傳擴充

```ts
export interface CandidateResult { /* 改 export，形狀不變 */ }

export interface IntradaySnapshotOutput {
  queriedAt: string;
  elapsedRatio: number;
  stats: { totalQueried: number; failedCount: number; triggered: number; passedGates: number };
  warnings: string[];
  results: CandidateResult[];
}

export async function checkIntradayBreakout(
  options: CheckIntradayBreakoutOptions = {},
): Promise<IntradaySnapshotOutput> { /* ... */ }
```

- `runSnapshot` 回傳型別同步改 `Promise<IntradaySnapshotOutput>`。
- 兩個 `return` 點（空結果早退 line ~355、正常結束 line ~601）都改成 `return { queriedAt, elapsedRatio, stats, warnings, results }`（空結果 `results: []`）。
- **`writeFileSync` 落地完全不動**（結果檔的 `{timestamp}.json` 照舊，只多一個 `warnings` 欄位——落地物件加 `warnings` 是無害擴充，或不加也行，UI 從 action 回傳拿）。
- `main()` 薄殼不用改（`checkIntradayBreakout()` 現在有回傳但 `main` 不接也不影響）。

### 2.3 驗證

- `pnpm tsx scripts/screening/check-intraday-breakout.ts`（**盤中時段跑**，或非盤中跑看它印警告 + 落地空/舊資料）：
  - `data/intraday-breakout-snapshots/{timestamp}.json` 仍正常產出，結構與改動前一致（頂多多 `warnings`）。
  - 執行過程中 `data/intraday-breakout-snapshots/progress.json` 有被逐批更新（`fetchedBatches` 遞增）。
  - `console.table` 輸出照舊。
- 非交易日 / 非盤中跑不應 crash，`warnings` 有內容。

---

## 3. `lib/actions/intraday.ts`（新檔）

```ts
"use server";

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CandidateResult } from "../../scripts/screening/check-intraday-breakout";

const REPO_ROOT = process.cwd();
const SNAPSHOT_DIR = join(REPO_ROOT, "data", "intraday-breakout-snapshots");
const PROGRESS_PATH = join(SNAPSHOT_DIR, "progress.json");

export interface IntradayProgress {
  status: "running" | "done" | "error";
  phase: "fetching-quotes" | "scoring" | "done" | "error";
  queriedAt: string;
  fetchedBatches: number;
  totalBatches: number;
  failedCount: number;
  startedAt: string;
  updatedAt: string;
  warnings: string[];
  error: string | null;
}

export interface IntradayRow {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  volumeRatio: number;
  totalScore: number;
  rank: number;
  scores: CandidateResult["scores"];
  degraded: string[];
}

export interface IntradayResult {
  queriedAt: string;
  elapsedRatio: number;
  stats: Record<string, number>;
  warnings: string[];
  rows: IntradayRow[];
}

/** spawn detached 子進程跑掃描，立刻回傳。同時只允許一個進行中。 */
export async function startIntradayScan(): Promise<{ started: boolean; reason?: string }>;

/** 讀 progress.json */
export async function getIntradayProgress(): Promise<IntradayProgress | null>;

/** 讀「最新」一份 {timestamp}.json 結果檔（排除 progress.json），轉成可序列化 rows */
export async function getIntradayResult(): Promise<IntradayResult | null>;
```

實作要點：

1. **`startIntradayScan`**：
   - 先讀 `progress.json`，若 `status === "running"` 且 `updatedAt` 在最近 ~90 秒內 → 回 `{ started: false, reason: "已有掃描進行中" }`（避免重複 spawn）。（超過 90 秒沒更新視為死掉的舊掃描，允許重跑。）
   - `tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs")`；`script = join(REPO_ROOT, "scripts", "screening", "_run-intraday-scan.ts")`。
   - `spawn(process.execPath, [tsxCli, script], { detached: true, stdio: "ignore", cwd: REPO_ROOT })` + `child.unref()`。（子進程 heap 需求低，不用 `--max-old-space-size`。）
   - **在 spawn 前，這個 action 先原子寫一份 `progress.json`**（`status: "running"`, `phase: "fetching-quotes"`, `fetchedBatches: 0`, `startedAt` = now）——這樣即使子進程啟動有幾秒延遲，client 第一次輪詢也拿得到「running」狀態，不會誤判成「沒在跑」。
   - 回 `{ started: true }`。
2. **`getIntradayProgress`**：`existsSync` → `readFileSync` → `JSON.parse`，`catch` 回 `null`。
3. **`getIntradayResult`**：`readdirSync(SNAPSHOT_DIR)` → filter `/^\d{4}-\d{2}-\d{2}T/` 的 `.json`（排除 `progress.json`）→ 取檔名字典序最大（= 最新 timestamp）→ `readFileSync` + `JSON.parse` → 挑欄位組 `IntradayRow`（`CandidateResult` 已全是 `number` / `string`，無 `Decimal` / `Date` / `BigInt`，直接挑）。回傳 `stats` 用 `{ ...parsed.stats }`，`warnings` 用 `parsed.warnings ?? []`。
4. **錯誤處理**：子進程自己會在 `progress.json` 寫 `status: "error"` + `error` 訊息（見 §4）。action 不吞。
5. **auth**：本專案單人本機，不做。
6. **import 邊界**：`intraday.ts` 只 `import type { CandidateResult }`——**不 import `checkIntradayBreakout` 本體**（它 module-level `import "dotenv/config"` + `node:fs`，type-only import 不會把實作拉進 bundler，比照 backtest `load-forward-returns.ts` 只 import 型別的做法）。§6 build 驗證要確認。

---

## 4. `scripts/screening/_run-intraday-scan.ts`（新，薄 runner）

被 `startIntradayScan` spawn 的進入點。底線前綴 = 內部 runner（比照 `scripts/archive/` 慣例，不是給人手動跑的）。

```ts
import "dotenv/config";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { checkIntradayBreakout } from "./check-intraday-breakout";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRESS_PATH = join(__dirname, "..", "..", "data", "intraday-breakout-snapshots", "progress.json");

function atomicWrite(path: string, obj: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(obj, null, 2));
  renameSync(path + ".tmp", path);
}

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  const startedAt = new Date().toISOString();
  try {
    // checkIntradayBreakout 內部會逐批覆寫 progress.json（phase: fetching-quotes）
    const out = await checkIntradayBreakout({ prisma });
    atomicWrite(PROGRESS_PATH, {
      status: "done", phase: "done",
      queriedAt: out.queriedAt,
      fetchedBatches: 0, totalBatches: 0,   // 已無意義，done 態不看
      failedCount: out.stats.failedCount,
      startedAt, updatedAt: new Date().toISOString(),
      warnings: out.warnings, error: null,
    });
  } catch (err) {
    atomicWrite(PROGRESS_PATH, {
      status: "error", phase: "error",
      queriedAt: startedAt,
      fetchedBatches: 0, totalBatches: 0, failedCount: 0,
      startedAt, updatedAt: new Date().toISOString(),
      warnings: [],
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
```

- **職責分工**：`checkIntradayBreakout` 內部負責 `phase: "fetching-quotes"` 的逐批進度（§2.1）；runner 只在**最外層**覆寫 `done` / `error`。
- runner 不 `isMain` guard（它就是為了被 spawn 執行）。
- **stdio**：`startIntradayScan` 用 `stdio: "ignore"`。若除錯需要，可改導到 `data/intraday-breakout-snapshots/_last-run.log`（`openSync` 拿 fd 傳給 `spawn` 的 `stdio: ["ignore", fd, fd]`）——**優先 `"ignore"`，除錯再說**。

---

## 5. `ScreeningPanel.tsx` 加第三個 tab

### 5.1 tab 與狀態

- `ScreeningStrategy` 型別在 `lib/actions/screening.ts`——**新增 `"intraday"`**？還是 intraday 完全走另一條路？
  - **定案**：`ScreeningPanel` 內部把 tab 值擴成 `"breakout" | "accumulation" | "intraday"`（元件內 local 型別，不動 `runScreening` 的 `ScreeningStrategy`）。breakout / accumulation 兩 tab 照舊呼叫 `runScreening`；intraday tab 呼叫 `lib/actions/intraday.ts` 的三支。
- `STRATEGY_LABELS` 加 `intraday: "盤中即時掃描"`。
- intraday tab 專屬 state：`intradayProgress` / `intradayResult` / `intradayError` / `scanBusy`。**不放進 `results: Partial<Record<...>>`**（那是 `ScreeningResult` 形狀，intraday 不同），另開變數。
- `switchStrategy` 切到 / 切走 intraday 時：**不中斷正在跑的子進程**（它是 detached），只停掉 client 的輪詢 `setInterval`；切回來時若 `progress.json` 還 `running` 就重新開始輪詢（`useEffect` 依賴 `tab === "intraday"`）。

### 5.2 intraday tab 的互動

- **一顆「開始掃描」按鈕** → `startIntradayScan()`：
  - 回 `{ started: false, reason }` → 顯示 reason（「已有掃描進行中」），不清空現有結果。
  - 回 `{ started: true }` → 清空 `intradayResult`，設 `scanBusy = true`，啟動輪詢。
- **輪詢**（`useEffect`，`tab === "intraday" && scanBusy`）：`setInterval(2000)` → `getIntradayProgress()`：
  - `status === "running"` → 更新進度條（`fetchedBatches / totalBatches`，phase 文案「抓取即時報價中… 3/16 批」）。
  - `status === "done"` → `clearInterval`，`getIntradayResult()` → `setIntradayResult`，`scanBusy = false`。
  - `status === "error"` → `clearInterval`，顯示 `error`，`scanBusy = false`。
  - `null`（progress.json 還沒出現）→ 維持「啟動中…」。
- **進度條**：純 Tailwind（`<div>` 寬度 % ），不引入元件庫。
- **警語列**（tab 頂端常駐）：「盤中即時掃描：對 `mis.twse.com.tw` 即時報價跑全市場快照，約需 20–30 秒。收盤價 / 量 / OHLC / 布林上軌為即時或估計值，**與盤後結果不可直接比較**。僅盤中 09:00–13:30 有效。」
- **`result.warnings`** 非空 → 結果表格上方紅字列出（開盤前、MIS 日期異常等）。

### 5.3 結果表格（重用）

- 新增 `intradayColumns: Column<IntradayRow>[]`：`rank` / `code` / `name` / `即時價`(price) / `漲跌%`(changePercent, 漲紅跌綠) / `量比(估)`(volumeRatio) / `總分`(totalScore) / `降級項目`(degraded)。
- 排序 `useMemo`、行內展開 `<Detail>`（intraday 的 `scores` 7 分項跟 breakout 同形狀，`<Detail>` 加一個 `strategy === "intraday"` 分支或直接複用 breakout 分支的渲染）、勾選 `Set<string>` + `addToWatchlist({ codes: [...selected], source: "intraday" })` → 提示「已加入 N 檔，略過 M 檔」。
- 空結果（`rows.length === 0` 且 `status === "done"`）→ 「本次快照無符合條件的候選股」（不是錯誤）。

### 5.4 `app/screening/page.tsx`

- 不用改（`ScreeningPanel` 是 client 元件，`force-dynamic` 已在）。頁面說明文字可補一句「盤中即時掃描為背景執行，可切走再回來看進度」。

---

## 6. 驗證（本 PLAN 的驗收）

### 6.1 腳本改動

1. `pnpm tsx scripts/screening/check-intraday-breakout.ts`（盤中時段最佳；非盤中跑驗證不 crash + `warnings` 有內容）：
   - 執行中 `watch -n1 cat data/intraday-breakout-snapshots/progress.json` 看到 `fetchedBatches` 從 0 遞增到 `totalBatches`。
   - 結束後 `{timestamp}.json` 正常產出，`console.table` 照舊。
2. `pnpm exec tsc --noEmit`：`scripts/` 零新增錯誤（`CandidateResult` export、回傳型別改動、`renameSync` import）。

### 6.2 `_run-intraday-scan.ts` + actions

1. 直接跑 runner：`pnpm tsx scripts/screening/_run-intraday-scan.ts` →
   - 過程中 `progress.json` 有 `running` → 結束 `done`（或非盤中時 `done` 但 `results` 空 + `warnings` 有料）。
   - `data/intraday-breakout-snapshots/{timestamp}.json` 有新檔。
2. 模擬 action 邏輯（tsx 小腳本或 `pnpm dev` 手測）：
   - `startIntradayScan()` 連按兩次 → 第二次回 `{ started: false, reason: ... }`。
   - `getIntradayProgress()` 在跑的時候回 `running` + 遞增的 `fetchedBatches`。
   - `getIntradayResult()` 回最新那份、`rows` 已是 plain object（`JSON.stringify` 不丟錯）。

### 6.3 選股頁端到端（`pnpm dev`）

1. `/screening` →「盤中即時掃描」tab：
   - 頂端警語常駐。
   - 「開始掃描」→ 進度條出現，phase 文案「抓取即時報價中… N/16 批」，約 20–30 秒後跑完。
   - **切到「第一根突破」tab 再切回來** → 進度條/結果狀態還在（切走只停輪詢、沒中斷子進程）。
   - 跑完 → 候選表格出現，內容與 `data/intraday-breakout-snapshots/{最新}.json` 的 `results` 一致（rank / code / totalScore 對得上）。
   - 點列 → 展開 7 分項明細。
   - 點欄位標題 → 排序生效。
   - 勾 2 檔 → 「加入觀察清單」→ DB `WatchlistItem` 多 2 筆、`source = "intraday"`。再勾同 2 檔 → 「已加入 0 檔，略過 2 檔」。
   - 非盤中跑 → 警語列紅字（開盤前 / MIS 日期異常），表格可能空 → 顯示「本次快照無符合條件的候選股」，不白屏不報錯。
2. 「第一根突破」/「冷水區醞釀」兩 tab 行為**完全不變**（同步跑、`useTransition`）。

### 6.4 typecheck / build

- `pnpm exec tsc --noEmit`：`scripts/` + 根目錄零新增錯誤。
- `pnpm build`：通過。重點確認：
  - `lib/actions/intraday.ts` 只 `import type { CandidateResult }` → **不把 `check-intraday-breakout.ts` 的 `dotenv/config` / `node:fs` / MIS fetch 拉進 Turbopack bundle**（比照上一份 PLAN 對 `scripts/screening/*` import 的驗證結果——那次沒炸，這次 type-only 更安全）。
  - `_run-intraday-scan.ts` **不被任何 `app/` 或 `lib/` 檔 import**（只被 spawn 當獨立腳本跑）→ 不進 build。
  - `/screening` 靜態分析照舊（`force-dynamic`）。

### 6.5 舊行為不變

- `calculate-breakout-strength.ts` / `calculate-accumulation-score.ts` / `check-intraday-breakout.ts` 的 CLI 輸出與落地照舊（`check` 頂多結果檔多 `warnings` 欄位）。
- `daily-pipeline.ts` 不受影響。
- `/` Dashboard、`/watchlist` 不變。
- 盤後兩個 screening tab 不變。

---

## 7. 實作步驟（順序）

1. **`check-intraday-breakout.ts`**：`CandidateResult` 改 `export`；加 `IntradaySnapshotOutput` 回傳型別；`fetchAllMisQuotes` 加 `onBatch` callback；`runSnapshot` 傳 callback（原子寫 `progress.json`，`phase: "fetching-quotes"`）+ 收集 `warnings`；兩個 `return` 點回 `{ queriedAt, elapsedRatio, stats, warnings, results }`；檔頭 import 加 `renameSync`。CLI 跑一次驗落地/console 不變 + `progress.json` 有遞增。（§2、§6.1）
2. **`scripts/screening/_run-intraday-scan.ts`**：薄 runner，最外層覆寫 `done` / `error`。`pnpm tsx` 直接跑驗證。（§4、§6.2）
3. **`lib/actions/intraday.ts`**：`startIntradayScan`（spawn + 防重複 + spawn 前先寫一次 `running`）/ `getIntradayProgress` / `getIntradayResult`（讀最新結果檔 → plain rows）。（§3、§6.2）
4. **`ScreeningPanel.tsx`**：tab 值擴 `"intraday"`；`STRATEGY_LABELS` 加；intraday 專屬 state + 輪詢 `useEffect` + 進度條 + 警語列 + `intradayColumns` + 重用表格/排序/展開/勾選（`source: "intraday"`）。（§5、§6.3）
5. **`app/screening/page.tsx`**：說明文字補一句（可選）。
6. **驗證**：§6 全部（腳本、runner、actions、選股頁 E2E、typecheck、`pnpm build`、舊行為）。
7. **回寫文件**：
   - `CLAUDE.md`：
     - 「既有腳本 / `scripts/screening/`」段：`check-intraday-breakout.ts` 補「回傳現含 `IntradaySnapshotOutput`（`results` + `warnings` 等）供前端 action 取用；執行時逐批覆寫 `data/intraday-breakout-snapshots/progress.json`」；新增 `_run-intraday-scan.ts`（被 `lib/actions/intraday.ts` spawn 的 runner）。
     - 「前端（Next.js + Prisma）」段：`/screening` 補「第三個 tab『盤中即時掃描』走**背景任務模式**（spawn detached 子進程跑 `_run-intraday-scan.ts` → 子進程逐批寫 `progress.json` → `getIntradayProgress` 輪詢 → client `setInterval` 進度條），與盤後兩 tab 的同步跑不同；跑完重用同一套表格/排序/展開/勾選，`source: "intraday"`」；`lib/actions/` 補 `intraday.ts`。
     - 「背景任務」段：把「PoC 已刪、模式如上記錄」更新為「已有正式使用者：`lib/actions/intraday.ts`（盤中掃描）」。
   - `README.md`：「前端」段 / 「使用方式」的 `/screening` 說明補第三個 tab。
   - `docs/PROGRESS.md`：本批（`check` 進度回報 + 回傳擴充、背景任務模式首個正式落地、`_run-intraday-scan.ts` runner 的職責分工、`intraday.ts` type-only import 邊界、防重複 spawn 的 90 秒判斷、切 tab 不中斷子進程、非盤中警語處理、`pnpm build` 驗證結果）。
   - `docs/ROADMAP.md`：這是 ROADMAP 沒明列的加項（第 4 節聚焦盤後選股，盤中在第 5 節但那是「排程 + 通知」）。**在第 4 節或第 5 節前加一條註記**：「盤中即時掃描的**手動觸發 UI**（背景任務模式）已於 2026-08-30 併入 `/screening` 第三個 tab；第 5 節的『排程 + 通知管道』仍未做」。不動第 5 節既有 `- [ ]`。

---

## 8. 待決小事（實作時當場定）

| 項目 | 選項 | 傾向 |
| --- | --- | --- |
| intraday 是否併進 `ScreeningStrategy` 型別 | 併 / `ScreeningPanel` 內部 local 型別 | **local 型別**（`runScreening` 不服務 intraday，型別分開更清楚）|
| `progress.json` 帶不帶 runId | 帶（可並行多掃描）/ 不帶（單檔、單一進行中）| **不帶**（盤中掃描沒有並行需求，單檔最簡單）|
| 防重複 spawn 的判斷 | 純看 `status === "running"` / 加「`updatedAt` 超過 N 秒視為死掉」 | **加 90 秒 staleness**（子進程可能 crash 沒寫 error，不能永遠卡住）|
| 子進程 stdio | `"ignore"` / 導到 `_last-run.log` | **`"ignore"`**（除錯再改；`progress.json` 的 `error` 欄位已夠定位）|
| 進度粒度 | 每批寫 / 每 N 批寫 | **每批寫**（16 批、原子寫成本低，進度條更順）|
| 切 tab 時正在跑的掃描 | 中斷子進程 / 只停輪詢 | **只停輪詢**（detached 子進程本就該跑完；切回來重連進度）|
| 非盤中時段 | 禁止按鈕 / 只警語 | **只警語**（使用者可能想看「昨收凍結值」的樣子；腳本內部已防呆）|
| runner 檔名 | `_run-intraday-scan.ts` / `run-intraday-scan.ts` | **底線前綴**（內部 runner，非手動執行入口，跟 `scripts/_poc` 歷史慣例一致）|

---

## 9. 已知風險 / 待後續處理

| 項目 | 處理時機 |
| --- | --- |
| 排程自動盤中掃描 + Telegram 通知 + 「大漲大跌」判斷邏輯 | ROADMAP 第 5 節（依賴資料庫外部連線 + 通知模組，本批不碰）|
| `mis.twse.com.tw` 是社群逆向工程端點，格式可能無預警改 | 既有風險，本批不新增；`failedCount` / `warnings` 已能反映抓取失敗 |
| 盤中訊號的歷史回測（命中率回顧）| 回測系統撿回後（`feat/backtest-ui-3.6-3.7`），且受 TPEx 盤中/歷史端點限制（ROADMAP 3.1 已註記）|
| `data/intraday-breakout-snapshots/` 結果檔堆積 | 手動清（`.gitignore` 已含）；GC 策略待日後 |
| 子進程若在 `next dev` 熱重載 / server 重啟時被連累 | detached + `unref` 已隔離；最壞情況是 `progress.json` 停在 `running`，90 秒 staleness 會放行重跑 |
| Next.js server 部署到多實例時 `progress.json` 在本機檔案系統 | 本專案單機 `localhost`（ROADMAP 第 5 節前都是），多實例不在考量 |
| 同時有人在跑盤後 tab + 盤中 tab | 各自獨立（盤後同步、盤中背景），`prisma` 單例併發查詢無問題 |
