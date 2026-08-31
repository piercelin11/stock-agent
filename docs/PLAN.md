# PLAN：技術指標只算當天 + 首頁「立即更新資料」按鈕（跑 daily pipeline）

兩個獨立小改，一次做：

1. **`calculateTechnicalIndicators` 加「只算最新一天」模式**，`daily-pipeline.ts` 第 4 步改用它 → pipeline 從 ~10 分鐘降到秒級。CLI 預設仍是全歷史重算，不影響任何現有手動用法。
2. **首頁「資料狀態」卡加一顆按鈕**，按下去 spawn 子進程跑 `daily-pipeline.ts`，粗粒度進度（跑多久 + 活著沒 + log 尾巴），可離開頁面、切回來重連。**不改 `daily-pipeline.ts` 的結構 / 介面 / 退出碼**（launchd 那條路照舊）。

分支：`feat/margin-trading`（延續，融資融券那批已做完）。

這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識回寫 `CLAUDE.md`，過程紀錄回寫 `docs/PROGRESS.md`。

---

## 0. 邊界

**做的事：**

1. `calculateTechnicalIndicators(codes?, options?)` 加 `options.mode: "full" | "latest"`（預設 `"full"`）。`"latest"` 模式：每支股票只撈最近約 250 筆 `DailyQuote` 當輸入、只 `upsert` 最新一筆日期的指標。
2. `daily-pipeline.ts` 第 4 步：`calculateTechnicalIndicators(undefined, { mode: "latest" })`。這是 pipeline 內唯一改動，對外行為只有「變快」。
3. `lib/actions/pipeline.ts`（新）：`runDailyPipeline()` spawn 子進程 + `getDailyPipelineStatus()` 讀狀態。單一任務鎖。
4. `components/dashboard/PipelineRunner.tsx`（新，client component）：按鈕 + 輪詢 + 粗進度顯示 + 切頁重連。
5. `app/page.tsx`：「資料狀態」卡塞 `<PipelineRunner />`（按鈕 + 狀態列）。
6. `.gitignore`：加 `/data/daily-pipeline-runs/`。

**明確不做：**

- **`daily-pipeline.ts` 加 `isMain` guard / progress callback / 7 步進度條** → 不做。它目前「import 即執行 `main()`」的特性正是 `lib/actions/pipeline.ts` 要利用的（spawn 它當獨立腳本跑）。進度只做粗粒度（子進程存活 + log tail），不做逐步。
- **技術指標「最近 N 天」** → 只做「當天」（`mode: "latest"` = 最新一筆日期）。使用者已拍板只算當天；pipeline 漏跑那天的指標事後手動 `calculate-technical-indicators.ts <code>` 補。
- **按鈕跑「單一步驟」（只補報價 / 只補融資融券…）** → 不做，這批只有「跑完整 pipeline」一顆按鈕。
- **`daily_pipeline.plist` 部署 / 修改** → 不碰（本來就還沒建立）。
- **並發多使用者 / 佇列** → 單機自用，`progress.json` 單檔鎖就夠。

---

## 1. `calculateTechnicalIndicators` 加 `mode: "latest"`

檔案：`scripts/pipeline/calculate-technical-indicators.ts`

### 1.1 現況

```ts
export async function calculateTechnicalIndicators(codes?: string[]): Promise<{ processed: number; indicatorsWritten: number }> {
  const stocks = await prisma.stock.findMany({ where: { OR: [{ securityType: "stock" }, { code: "TAIEX" }], ...(codes ? { code: { in: codes } } : {}) }, ... });
  for (const stock of stocks) {
    const quotes = await prisma.dailyQuote.findMany({
      where: { stockCode: stock.code },
      orderBy: { date: "asc" },
      select: { date: true, high: true, low: true, close: true, volume: true },
    });
    // ...對 quotes 每一筆 i 算指標 → rows
    for (const row of rows) {
      await prisma.technicalIndicator.upsert({ where: { stockCode_date: { stockCode: row.stockCode, date: row.date } }, update: row, create: row });
    }
  }
}
```

全歷史重算：~2149 支 × 每支 ~1600 筆 `upsert` ≈ 340 萬筆逐筆 await，實測 ~10 分鐘。

### 1.2 改法

**簽名**：

```ts
interface CalcOptions {
  mode?: "full" | "latest"; // 預設 "full"
}

export async function calculateTechnicalIndicators(
  codes?: string[],
  options: CalcOptions = {},
): Promise<{ processed: number; indicatorsWritten: number }> {
  const mode = options.mode ?? "full";
  // ...
}
```

**`quotes` 撈取**：`mode === "latest"` 時只取最近一段窗口。最長回看需求是 MA60（60）、bollinger（20）、rsi14（15）、atr20（21）、macd（26+9 EMA，但 EMA 需要更長 warm-up 才穩）、volatility20d（21）。MACD 的 EMA 拿 200 筆暖身足夠穩定。取 **`LOOKBACK = 250`** 給足餘裕：

```ts
const LOOKBACK = 250; // mode "latest" 每支撈最近這麼多筆 DailyQuote 當輸入，足夠算出最長窗口（MA60 / MACD EMA 暖身）

const quotes = mode === "latest"
  ? (await prisma.dailyQuote.findMany({
      where: { stockCode: stock.code },
      orderBy: { date: "desc" },
      take: LOOKBACK,
      select: { date: true, high: true, low: true, close: true, volume: true },
    })).reverse() // 反轉回 asc，下游計算不變
  : await prisma.dailyQuote.findMany({
      where: { stockCode: stock.code },
      orderBy: { date: "asc" },
      select: { date: true, high: true, low: true, close: true, volume: true },
    });
```

**`rows` → upsert**：`mode === "latest"` 時只寫最後一筆（最新日期）。指標函式吃的是整個 `closes` 陣列 + index，所以照算全部 `rows`，只挑 `rows.at(-1)` 寫：

```ts
const rowsToWrite = mode === "latest" ? rows.slice(-1) : rows;
for (const row of rowsToWrite) {
  await prisma.technicalIndicator.upsert({ ... });
  indicatorsWritten++;
}
```

> `rows.slice(-1)`：若某支 `quotes` 為空（新股當天才上市、還沒有 `DailyQuote`）→ `rows` 為空 → `slice(-1)` 也空 → 該支不寫，`processed++` 照常。與現狀一致（現狀空 `quotes` 也是不寫）。

**log**：開頭那行 `console.log(\`共 ${stocks.length} 支（含 TAIEX）待計算。\`)` 後面補模式：

```ts
console.log(`共 ${stocks.length} 支（含 TAIEX）待計算。模式：${mode === "latest" ? "只算最新一天" : "全歷史重算"}`);
```

`PROGRESS_INTERVAL` 那段（`已處理 N/M`）不動。

### 1.3 CLI 入口不變

```ts
const isMain = ...;
if (isMain) {
  const codeArgs = process.argv.slice(2).filter((a) => /^\d{4}[A-Z]?$/.test(a) || a === "TAIEX");
  calculateTechnicalIndicators(codeArgs.length > 0 ? codeArgs : undefined)
    // ← 不傳 options，維持 mode: "full"
    .catch(...)
    .finally(...);
}
```

CLI 永遠全歷史重算（回補報價後手動重算、debug 都要全歷史），不加 `--latest` flag（要就直接跑，沒必要）。

### 1.4 驗證

1. `pnpm tsx scripts/pipeline/calculate-technical-indicators.ts 2330`（不帶 options）→ 仍全歷史、`TechnicalIndicator` 2330 的筆數 = 該股 `DailyQuote` 筆數（跟改之前一樣）。
2. 寫一次性腳本呼叫 `calculateTechnicalIndicators(["2330"], { mode: "latest" })` → 只有 2330 最新一天那筆被 upsert（比對 `updatedAt` / `calculatedAt`），且該筆的 `ma60` / `bollingerBandwidth` / `rsi14` 數值與「全歷史重算」跑出來的同一天結果**一致**（誤差 0，因為 LOOKBACK=250 對這些窗口足夠）。
3. `pnpm exec tsc --noEmit` 乾淨。

---

## 2. `daily-pipeline.ts` 第 4 步改用 `mode: "latest"`

檔案：`scripts/pipeline/daily-pipeline.ts`

唯一改動：

```ts
// 4. 重新計算技術指標
try {
  const indicatorResult = await calculateTechnicalIndicators(undefined, { mode: "latest" });
  indicatorsProcessed = indicatorResult.processed;
} catch (err) {
  throw new PipelineStepError("計算技術指標", "計算失敗", err);
}
```

**注意**：第 5 步（大盤濾網）依賴第 4 步已更新 **TAIEX 的 `ma60`**。`mode: "latest"` 的 `stocks` where 仍是 `OR: [{ securityType: "stock" }, { code: "TAIEX" }]`，TAIEX 一樣會被算最新一天，`hasTaiexIndicatorForDate()` 對「今天」仍為 true → regime 走 `step2-full`。不受影響。

行為對外差異：`indicatorsProcessed` 數字不變（仍是處理股票數 ~2149），只是「寫入筆數」從 ~340 萬變 ~2149、耗時從 ~10 分鐘變數秒。退出碼 / 步驟數 / summary log 格式全不變。launchd 無感。

驗證：`pnpm tsx scripts/pipeline/daily-pipeline.ts`（非交易日會提前結束也行），確認第 4 步 log 印「模式：只算最新一天」且秒級完成、後續第 5/6 步照跑。

---

## 3. `lib/actions/pipeline.ts`（新）

**完全比照 `lib/actions/intraday.ts` 的骨架**（spawn detached + `progress.json` 原子寫 + STALE 判定），但簡化：`daily-pipeline.ts` 不寫進度檔，所以這裡的「進度」只有 `status` + 存活時間 + log 尾巴。

```ts
"use server";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const RUN_DIR = join(REPO_ROOT, "data", "daily-pipeline-runs");
const PROGRESS_PATH = join(RUN_DIR, "progress.json");

// daily-pipeline 正常跑完約數秒～數分鐘（技術指標改 latest 後）。
// 子進程 crash 沒寫終態 → progress.json 卡在 running。
// startedAt 超過這個秒數還 running → 視為死掉的舊執行，允許重跑。
const STALE_MS = 20 * 60_000; // 20 分鐘（保守，涵蓋偶發網路 retry 疊加）

export interface DailyPipelineStatus {
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  logTail: string[]; // log 檔最後 N 行
  logPath: string;   // 相對 repo root，給人 debug
}

function atomicWrite(path: string, obj: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(obj, null, 2));
  renameSync(`${path}.tmp`, path);
}

function readProgress(): DailyPipelineStatus | null {
  if (!existsSync(PROGRESS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) as DailyPipelineStatus;
  } catch {
    return null;
  }
}

function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}
```

### 3.1 `runDailyPipeline()`

```ts
export async function runDailyPipeline(): Promise<{ started: boolean; reason?: string }> {
  const current = readProgress();
  if (
    current &&
    current.status === "running" &&
    Date.now() - new Date(current.startedAt).getTime() < STALE_MS
  ) {
    return { started: false, reason: "pipeline 執行中" };
  }

  mkdirSync(RUN_DIR, { recursive: true });

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const logPath = join(RUN_DIR, `${stamp}.log`);
  const relLogPath = join("data", "daily-pipeline-runs", `${stamp}.log`);

  // 先寫 running，讓 client 第一次輪詢就有狀態
  atomicWrite(PROGRESS_PATH, {
    status: "running",
    startedAt,
    finishedAt: null,
    exitCode: null,
    logTail: [],
    logPath: relLogPath,
  } satisfies DailyPipelineStatus);

  const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(REPO_ROOT, "scripts", "pipeline", "daily-pipeline.ts");
  const out = openSync(logPath, "a");

  const child = spawn(process.execPath, [tsxCli, script], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: REPO_ROOT,
  });

  // 監聽結束，覆寫終態。detached + unref 後仍可在本 process 存活期間收到 exit；
  // 若 Next 進程自己重啟，靠 getDailyPipelineStatus() 的 STALE 判定兜底。
  child.on("exit", (code) => {
    atomicWrite(PROGRESS_PATH, {
      status: code === 0 ? "done" : "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      logTail: tailLines(logPath, 12),
      logPath: relLogPath,
    } satisfies DailyPipelineStatus);
  });
  child.unref();

  return { started: true };
}
```

> **為什麼用 `child.on("exit")` 而不是像 intraday 那樣讓子進程自己寫終態**：`daily-pipeline.ts` 不能改（要保持 launchd 用的那支乾淨）。所以由 parent（Next server action 進程）監聽 exit 覆寫。風險：dev 模式 Next 進程 hot-reload 重啟時這個 listener 會丟失 → `progress.json` 卡在 running。靠 `STALE_MS`（20 分）兜底：超時後 `getDailyPipelineStatus()` 回報 `error`（見 3.2），使用者可重按。生產 `pnpm start` 不 hot-reload，正常情況 listener 都在。

### 3.2 `getDailyPipelineStatus()`

```ts
export async function getDailyPipelineStatus(): Promise<DailyPipelineStatus | null> {
  const p = readProgress();
  if (!p) return null;

  // running 但超過 STALE → listener 可能已隨進程重啟丟失，回報 error（log tail 幫 debug）
  if (
    p.status === "running" &&
    Date.now() - new Date(p.startedAt).getTime() >= STALE_MS
  ) {
    return {
      ...p,
      status: "error",
      finishedAt: p.finishedAt ?? new Date().toISOString(),
      logTail: tailLines(join(REPO_ROOT, p.logPath), 12),
    };
  }

  // running 中：即時補上最新 log tail（progress.json 裡的 logTail 只在終態才寫）
  if (p.status === "running") {
    return { ...p, logTail: tailLines(join(REPO_ROOT, p.logPath), 12) };
  }

  return p;
}
```

**不 import 任何 `scripts/` 東西**（連 type 都不用），純檔案 IO + spawn。

---

## 4. `components/dashboard/PipelineRunner.tsx`（新）

Client component。骨架照 `ScreeningPanel.tsx` 的 intraday 輪詢段（`pollRef` + `setInterval` + 切頁 `useEffect` 重連 + 卸載 `clearInterval`）。

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { runDailyPipeline, getDailyPipelineStatus, type DailyPipelineStatus } from "../../lib/actions/pipeline";

const POLL_MS = 3000;

export function PipelineRunner() {
  const [status, setStatus] = useState<DailyPipelineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const s = await getDailyPipelineStatus();
      setStatus(s);
      if (s && s.status !== "running") {
        stopPolling();
        setBusy(false);
        // 跑完刷新頁面資料（覆蓋率 / 燈號）
        if (s.status === "done") window.location.reload();
      }
    }, POLL_MS);
  }, [stopPolling]);

  // 掛載時若已有 running 的執行（別的分頁 / 重整前觸發的）→ 接管輪詢
  useEffect(() => {
    (async () => {
      const s = await getDailyPipelineStatus();
      setStatus(s);
      if (s?.status === "running") { setBusy(true); startPolling(); }
    })();
    return stopPolling;
  }, [startPolling, stopPolling]);

  async function onRun() {
    setErr(null);
    setBusy(true);
    const r = await runDailyPipeline();
    if (!r.started) { setErr(r.reason ?? "無法啟動"); setBusy(false); return; }
    startPolling();
  }

  const running = status?.status === "running";
  const elapsed = status ? Math.round((Date.now() - new Date(status.startedAt).getTime()) / 1000) : 0;

  return (
    <div className="mt-2 space-y-2">
      <button
        onClick={onRun}
        disabled={busy || running}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-blue-500"
      >
        {running ? "更新中…" : "立即更新資料"}
      </button>

      {running && (
        <p className="text-sm text-slate-400">
          執行中… 已 {elapsed} 秒（可離開此頁，回來會接上進度）
        </p>
      )}
      {status?.status === "done" && !running && (
        <p className="text-sm text-emerald-400">上次更新完成（{status.finishedAt?.slice(11, 19)}）</p>
      )}
      {status?.status === "error" && (
        <p className="text-sm text-rose-400">
          上次執行失敗（exit {status.exitCode ?? "?"}）。log：{status.logPath}
        </p>
      )}
      {err && <p className="text-sm text-rose-400">{err}</p>}

      {status && status.logTail.length > 0 && (
        <pre className="max-h-40 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-400">
          {status.logTail.join("\n")}
        </pre>
      )}
    </div>
  );
}
```

要點：
- **切走頁面**：`useEffect` 的 cleanup `stopPolling` 停輪詢，子進程不受影響（detached）。**切回來**：重新掛載時 `getDailyPipelineStatus()` 若 `running` 就接管。
- **完成後 `window.location.reload()`**：`app/page.tsx` 是 `force-dynamic` server component，reload 會重新 `getDbHealth()` 抓到新覆蓋率 / 燈號。不用 `revalidatePath`（那要在 server action 裡、且這裡是 client 輪詢流程，reload 最直接）。
- **同時只有一個執行**：靠 server action 的 `progress.json` 鎖，按鈕本身也 `disabled={busy || running}`。

---

## 5. `app/page.tsx`

「資料狀態」Card 裡，「今日行情燈號」那個 `<div>` 下方或 Card 末尾加一段。放在 grid 之外、Card 內底部最單純：

```tsx
import { PipelineRunner } from "../components/dashboard/PipelineRunner";
// ...
<Card title="資料狀態">
  <div className="grid gap-8 sm:grid-cols-3">
    {/* ...現有三欄不動... */}
  </div>
  <PipelineRunner />
</Card>
```

（`Card` 的 children 是縱向流，grid 之後直接接 `<PipelineRunner />` 即可。若 `Card` 內部有 padding wrapper，`PipelineRunner` 的 `mt-2` 給一點間距，必要時加 `border-t border-slate-800 pt-4 mt-4`。）

---

## 6. `.gitignore`

```
/data/daily-pipeline-runs/
```

（比照既有的 `/data/market-regime/`、`/data/intraday-breakout-snapshots/` 等執行產物。）

---

## 7. 實作順序與驗證

1. **§1 技術指標 `mode` 參數** → §1.4 驗證（全歷史行為不變 + latest 模式數值一致）。
2. **§2 daily-pipeline 第 4 步** → 跑一次 pipeline 確認第 4 步秒級、log 有「只算最新一天」、第 5/6 步照跑。
3. **§3 `lib/actions/pipeline.ts`** → `pnpm exec tsc --noEmit`。
4. **§4 `PipelineRunner.tsx` + §5 `app/page.tsx` + §6 `.gitignore`** → `tsc` 乾淨 → `pnpm build` 通過。
5. **端到端**（需使用者 dev server，或臨時 `PORT=3123 pnpm dev` 自己起、收尾 kill 自己記的 PID）：
   - 開 `/`，按「立即更新資料」→ 按鈕變「更新中…」、出現「已 N 秒」+ log tail 滾動。
   - 切到 `/watchlist` 再切回 `/` → 狀態接上（仍顯示 running + 秒數繼續）。
   - 等 pipeline 跑完 → 頁面自動 reload、覆蓋率 / 燈號更新、狀態列顯示「上次更新完成」。
   - 立刻再按一次（趁還 running）→ 被 `progress.json` 鎖擋下、顯示「pipeline 執行中」。
   - `data/daily-pipeline-runs/{stamp}.log` 裡是完整 pipeline stdout。
6. **回寫文件**（§8）。

驗證命令：
- `pnpm exec tsc --noEmit`
- `pnpm build`
- 查資料用一次性 `pnpm tsx` 腳本（放 `scripts/_tmp-*.ts`，驗完刪）。

---

## 8. 完成後回寫

- **`CLAUDE.md`**：
  - 「既有腳本 → `scripts/pipeline/`」的 `calculate-technical-indicators.ts` 條目：補「`options.mode: "full" | "latest"`，`daily-pipeline.ts` 用 `latest`（只算並 upsert 最新一天，秒級）；CLI 與不帶 options 時仍 `full`（全歷史重算）」。
  - `daily-pipeline.ts` 條目：第 4 步改「算技術指標（`mode: "latest"`，只算當天）」；提一句「pipeline 漏跑那天的技術指標不會自動補，需手動 `calculate-technical-indicators.ts <code>`」。
  - 「前端 → Server Actions」清單：加 `pipeline.ts`（`runDailyPipeline` / `getDailyPipelineStatus`——首頁「立即更新資料」按鈕；spawn `daily-pipeline.ts` 當獨立腳本、log 落 `data/daily-pipeline-runs/{stamp}.log`、`progress.json` 粗粒度狀態、parent 監聽 `child.on("exit")` 寫終態、`STALE_MS` 20 分兜底 hot-reload 丟 listener）。
  - 「前端 → `/` Dashboard 頁」：「資料狀態」卡末尾多一顆 `<PipelineRunner />`（按鈕 + 粗進度 + log tail + 完成後 `window.location.reload()`）。
  - 「背景任務」段：補一句「另一個正式使用者：`lib/actions/pipeline.ts`（首頁跑 daily pipeline），但它 spawn 的是**未改造的 `daily-pipeline.ts` 本體**（該檔要保持給 launchd 用，不加 progress callback），所以進度是粗粒度（存活 + log tail），非逐步。」
- **`docs/PROGRESS.md`**：新增段落——技術指標 `full` vs `latest` 的取捨（只算當天的代價 = 漏跑不自動補）、LOOKBACK=250 的理由與數值一致性驗證結果、按鈕背景任務的做法（為何用 parent `child.on("exit")` 而非子進程自寫終態）、STALE 兜底、端到端驗證結果。
- **`docs/ROADMAP.md`**：這兩項不在現有 4.5.x todo 清單裡（是使用者臨時加的體驗改善）。在 4.5 節底下或適當位置補一條 `- [x]`：「首頁『立即更新資料』按鈕（背景跑 daily pipeline）+ 技術指標改只算當天（pipeline 提速）」。
- **`README.md`**：「目前功能 → Dashboard」段補「可從頁面一鍵觸發 daily pipeline（背景執行、可離開頁面）」；`daily-pipeline.ts` 描述的技術指標步驟補「只算當天」。
