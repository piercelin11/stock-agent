# PLAN 6：三階段命名統一 + 廢除 source + 觀察股手動分類

一份 PLAN 三件事，**commit 分兩個**（先重構 §1–§2、再功能 §3，出問題好回溯）。

**分支**：`feat/watchlist-manual-stage`。merge 時機等使用者發話。

**需求來源**：PLAN 5 收尾後的討論（2026-09-03）。ROADMAP §7 已記完整決定，本份是實作規格。

**背景**：
- 全專案三階段用**兩套詞**：程式碼識別字 `"pre-breakout"` / `"breakout-day"` / `"extended"`（含連字號的字串值）、UI 中文「醞釀中 / 首次突破 / 延續爆發」（`labels.ts` 單一出處）。`WatchlistItem.source` 又是**第三套** `"breakout"` / `"accumulation"` / `"manual"`（歷史遺留，只寫入無讀取）。
- `/watchlist` 階段 tab 是 `consecutiveAboveBand()` 即時自動判定分的。使用者要「手動指定分類」，但保留自動評估拿來比對（「我昨天挑的醞釀股今天發動了，看卡片標示就知道」）。

---

## 0. 邊界

### 動（§1–§2 重構 commit）

- **`prisma/schema.prisma`**：
  - 新增 `enum SignalStage { setup breakoutDay extended }`。
  - `WatchlistItem`：**移除 `source String?`**；**新增 `userStage SignalStage?`**（nullable）。
  - migration（`pnpm prisma migrate dev --name watchlist-userstage-drop-source`）。
- **`scripts/lib/signal-factors/staging.ts`**：`consecutiveAboveBand` 相關若有 `SignalStage` 型別
  或字串值——改。註解裡的 `pre-breakout / breakout-day / extended` 順手更新（非必須）。
  **實際檢查**：grep 顯示 staging.ts 只有註解提到，沒有字串值——若確認只有註解，本檔只改註解。
- **`scripts/screening/run-signal-scan.ts`**：
  - `export type SignalStage = "pre-breakout" | "breakout-day" | "extended"` → `"setup" | "breakoutDay" | "extended"`。
  - 所有 `stage = "pre-breakout"` / `"breakout-day"` 賦值、`s.stage === "pre-breakout"` /
    `!== "pre-breakout"` 比對、`stage as "breakout-day" | "extended"` type assertion → 換新值。
  - **JSON 輸出的 `stage` 欄位值跟著變**（`SignalResult.stage`）。
  - **不要動** `config.preBreakout`（設定物件屬性名）、`stats.preBreakout` / `stats.breakoutDay`
    （統計欄位名）、`preBreakoutExtras()`（函式名）——那些是 camelCase 識別字，不是 `SignalStage` 值，
    跟本次改名無關。只改「`stage` 這個欄位會出現的字串值」。
- **`lib/actions/signal-scan.ts`**：`export type { SignalStage }` re-export——型別跟著 run-signal-scan
  變，不用改 code。
- **`lib/latest-scan.ts`**：`if (r.stage === "pre-breakout")` → `=== "setup"`。
- **`lib/actions/watchlist.ts`**：
  - 第 16 行 `export type SignalStage = "pre-breakout" | "breakout-day" | "extended"`——**刪掉這份
    本地 union**，改 `import type { SignalStage } from "./signal-scan"`（或直接從 run-signal-scan，
    看 bundle 考量——現在刻意不 import run-signal-scan 本體，但 `import type` 會被 erase，安全）。
  - `stage` 計算的三元判斷（第 216–221）：`"pre-breakout"` / `"breakout-day"` / `"extended"` → 新值。
  - `if (stage === "pre-breakout")`（第 239）→ `=== "setup"`。
  - `WatchlistCardRow.source` 欄位移除、`return` 的 `source: item.source` 移除。
  - `addToWatchlist` 的 `source?` 參數移除、`createMany` 裡 `...(input.source ? {...} : {})` 移除。
- **`components/signal/labels.ts`**：`STAGE_ORDER` 陣列值、`STAGE_LABELS` key、`STAGE_PILL_CLASS` key
  → 新值。中文標籤（`"醞釀中"` 等）**不變**。
- **`components/signal/FactorList.tsx`**：`row.stage === "pre-breakout"` → `=== "setup"`。
- **`components/signal/pre-breakout-chip.ts`** / **`PreBreakoutInstitutional.tsx`**：grep 命中——
  檢查是否有 `SignalStage` 值比對，有就改（多半是型別 import + 中文，可能不用動）。
- **`components/watchlist/WatchlistCard.tsx`**：`row.stage === "pre-breakout"`（第 31、97）→ `=== "setup"`。
- **`components/watchlist/WatchlistGallery.tsx`**：`useState<SignalStage>("breakout-day")` 預設值、
  `countByStage` 的 `Record<SignalStage, ...>` key（`"breakout-day"` / `"extended"` / `"pre-breakout"`）→ 新值。
- **`components/screening/ScreeningPanel.tsx`**：
  - `stageToSource()` 函式**整個刪除**（§2 廢 source）+ 加入 watchlist 時的 `bySource` 分組邏輯簡化成
    直接 `addToWatchlist({ codes: [...selected] })`（不再帶 source）。
  - `useState<StageFilter>("breakout-day")` 預設、`setStageFilter("breakout-day")` reset、
    `stageFilter === "pre-breakout"` 之類比對 → 新值。
  - 第 357 `view.stats.preBreakout` / `breakoutDay` / `extended`——**那是 stats 欄位名，不動**。
- **`components/screening/SignalDetail.tsx`**：`row.stage === "pre-breakout"`（第 18）→ `=== "setup"`。

### 動（§3 功能 commit）

- **`lib/actions/watchlist.ts`**：
  - `addToWatchlist`：加入時算 `autoStage` 寫進 `userStage`（見 §3.2）。
  - `buildCardRow`：`autoStage` = 現在的 `stage` 計算結果；`stage`（決定卡片因子）= `userStage ?? autoStage`；
    `WatchlistCardRow` 加 `userStage` + `autoStage` 兩欄。
  - `listWatchlist`：`findMany` 的 `select` 加 `userStage`（不然 `item.userStage` 拿不到）。
  - `updateWatchlistItem`：input 加 `userStage?: SignalStage`，`data` 組裝加對應處理。
- **`components/watchlist/WatchlistGallery.tsx`**：
  - `countByStage` 改成 `Record<SignalStage, { total: number; mismatch: number }>`。
  - tab 分類：`rows.filter(r => (r.userStage ?? r.autoStage) === stage)`。
  - tab label：`{STAGE_LABELS[s]}（{c.total}{c.mismatch > 0 ? ` · ${c.mismatch} 異動` : ""}）`。
- **`components/watchlist/WatchlistCard.tsx`**：
  - `userStage !== autoStage` → 加「自動判定：{STAGE_LABELS[autoStage]}」chip。
  - 加改分類 UI（3 顆按鈕）→ `updateWatchlistItem({ code, userStage })`。

### 不動

- `scripts/lib/signal-factors/config.ts` / `institutional.ts`：grep 命中的是 `config.preBreakout`
  屬性名、`preBreakout:` config key——**不是 `SignalStage` 值**，不碰。
- `run-signal-scan.ts` 的評分邏輯、gate、豁免、`stats` 欄位名（`preBreakout` / `breakoutDay`）。
- `lib/data-context.ts` / PLAN 5 的 intraday 檔機制。
- 中文標籤（`STAGE_LABELS` 的 value）。
- `WatchlistItem` 的買入狀態欄位（`isPurchased` 等，早已無 UI 但保留）。

---

## 1. 命名統一（`SignalStage` 值：`setup` / `breakoutDay` / `extended`）

### 1.1 對照表

| 舊值（字串，含連字號） | 新值 | 中文（不變） |
|---|---|---|
| `"pre-breakout"` | `"setup"` | 醞釀中 |
| `"breakout-day"` | `"breakoutDay"` | 首次突破 |
| `"extended"` | `"extended"` | 延續爆發 |

- `breakoutDay` 而非 `breakout`——避免跟即將廢除的 `source` 值 `"breakout"` 視覺混淆、保留
  「首次 vs 延續」語意。
- Prisma enum 值不能有連字號，camelCase 是唯一選項。

### 1.2 做法：全域 grep 替換

三個獨立的替換（分開做，避免誤傷）：

```
"pre-breakout"  →  "setup"        （只在 SignalStage 值的 context——賦值 / 比對 / 陣列 / Record key）
"breakout-day"  →  "breakoutDay"
（extended 不動）
```

**注意誤傷點**：
- `config.preBreakout` / `d.preBreakout` / `pb?.xxx ?? d.preBreakout.xxx`（config.ts）——**保持不動**，
  那是既有的 config 屬性名，跟 SignalStage 值無關。grep `"pre-breakout"`（帶引號、帶連字號）
  只會命中字串值，不會命中 `preBreakout` 識別字——所以按「帶引號的字串」replace 是安全的。
- `stats.preBreakout` / `stats.breakoutDay`（run-signal-scan.ts 的 `SignalScanOutput.stats`）——
  同理，那是 camelCase 欄位名，不帶引號連字號，不會被誤中。
- `preBreakoutExtras()` 函式名——同理。

### 1.3 改完立刻重跑掃描覆蓋舊 JSON

`data/signal-scan-results/*.json` 裡 `"stage": "pre-breakout"` 會過時 → 前端讀進來
`STAGE_LABELS["pre-breakout"]` 是 `undefined` → tab / pill 顯示壞掉。

- 改完（在 `feat/watchlist-manual-stage` 分支）跑一次：
  ```
  pnpm tsx scripts/screening/run-signal-scan.ts --source=eod
  ```
  覆蓋 `data/signal-scan-results/{今日}.json`（新的 `stage` 值）。
- realtime 檔（`{今日}-intraday.json`）：等下次 launchd 自動覆蓋，或手動
  `pnpm tsx scripts/screening/run-signal-scan.ts --source=realtime`。
- **不做「讀舊值轉換」**（YAGNI——掃描 JSON 本來每天重生；舊 `{timestamp}.json` 是 PLAN 5 前的死檔，
  gitignored，不管）。
- **merge 到 main 後也要在 main 上重跑一次 eod**（分支上跑的 `{今日}.json` 若沒 commit 進去——
  `data/` gitignored，所以 merge 後 main 的 working dir 還是舊 JSON，得重跑）。收尾清單列出。

### 1.4 驗證命名統一

- `pnpm exec tsc --noEmit` 乾淨。
- `pnpm tsx --test scripts/lib/signal-factors/factors.test.ts`（若測試裡有 `"pre-breakout"` 斷言，
  一併改）。
- `grep -rn '"pre-breakout"\|"breakout-day"' --include="*.ts" --include="*.tsx"` → **應回空**
  （除了可能的註解，註解可留可改）。
- 重跑 eod 掃描 → `python3 -c "import json; d=json.load(open('data/signal-scan-results/{今日}.json')); print(set(r['stage'] for r in d['results']))"` → 應是 `{'setup', 'breakoutDay', 'extended'}`。
- `curl http://localhost:3000/screening` / `/watchlist` → tab 中文正常、pill 正常。

---

## 2. 廢除 `WatchlistItem.source`

`source` 現況：**只有寫入、零讀取**。
- 寫入：`addToWatchlist({ source })` ← `ScreeningPanel` 的 `stageToSource()` 算出來傳。
- 讀取：`WatchlistCardRow.source` 帶著它回前端，但 `WatchlistCard` / `WatchlistGallery` **不讀**；
  `scripts/` 沒有任何檔讀 `WatchlistItem.source`。當初「記錄從哪個策略加入、日後分析」意圖從沒實現。

`userStage`（§3）是上位替代（三階段之一，比 `breakout` / `accumulation` 二分精確）。

### 2.1 移除清單

- `schema.prisma`：`WatchlistItem` 刪 `source String?` 那行。migration（跟 §1.1 的 enum + userStage
  同一個 migration）。
- `lib/actions/watchlist.ts`：
  - `WatchlistCardRow` 介面刪 `source: string | null`。
  - `buildCardRow` return 刪 `source: item.source`。
  - `addToWatchlist` 的 `input: { codes, source? }` → `{ codes }`；`createMany` 的
    `...(input.source ? { source: input.source } : {})` 刪掉。
- `components/screening/ScreeningPanel.tsx`：
  - `stageToSource()` 函式刪除。
  - `addSelected()`（或加入邏輯）裡的 `bySource` 分組刪掉 → 直接
    `await addToWatchlist({ codes: [...selected] })`。
- 既有 DB 資料的 `source` 值：migration drop column 時自然消失，不需另外清。

### 2.2 驗證

- `tsc` 乾淨。
- `curl -X`（或 UI 操作）「選股頁勾選加入 watchlist」→ 加入成功、不再帶 source。
- Prisma Studio / query 確認 `WatchlistItem` 沒有 `source` 欄位、有 `userStage`。

---

## 3. `userStage` 手動分類（功能 commit）

### 3.1 型別

- `WatchlistCardRow` 加：
  ```ts
  userStage: SignalStage;   // 加入時就寫入（addToWatchlist 算 autoStage），理論上恆有值
  autoStage: SignalStage;   // 即時判定（現在的 stage 計算），只拿來比對 + chip
  ```
  （`stage` 欄位可保留當「卡片實際採用的 = userStage ?? autoStage」，或直接刪 `stage` 用 `userStage`
  ——傾向保留 `stage` 少改前端，值 = `userStage ?? autoStage`。）

### 3.2 `addToWatchlist` 加入時算 `autoStage`

現在 `addToWatchlist` 只 `createMany({ data: codes.map(code => ({ stockCode: code })) })`。改成：

```ts
export async function addToWatchlist(input: { codes: string[] }): Promise<{ added: number; skipped: number }> {
  const requested = [...new Set(input.codes)];
  if (requested.length === 0) return { added: 0, skipped: 0 };

  const existing = await prisma.stock.findMany({
    where: { code: { in: requested } },
    select: { code: true },
  });
  const validCodes = existing.map((s) => s.code);
  if (validCodes.length === 0) return { added: 0, skipped: requested.length };

  // 加入當下算即時 autoStage（比照 buildCardRow 的 stage 計算，但這裡是批量、簡化版）。
  const autoStageByCode = await computeAutoStages(validCodes);

  const result = await prisma.watchlistItem.createMany({
    data: validCodes.map((code) => ({
      stockCode: code,
      userStage: autoStageByCode.get(code) ?? "setup", // 算不出（缺指標）→ 預設 setup
    })),
    skipDuplicates: true,
  });

  revalidatePath("/watchlist");
  return { added: result.count, skipped: requested.length - result.count };
}
```

`computeAutoStages(codes)`：新的私有 helper（`watchlist.ts` 內）。

```ts
async function computeAutoStages(codes: string[]): Promise<Map<string, SignalStage>> {
  // 用 DB 資料（不打 MIS——加入動作不該卡）：每檔撈近 N 筆 DailyQuote.close + TechnicalIndicator.bollingerUpper，
  // consecutiveAboveBand 算連續站上上軌天數 → setup / breakoutDay / extended。
  // 缺指標的檔 → 不放進 Map（呼叫端 fallback "setup"）。
}
```

- **只用 DB 資料**（`eod` 視角）——加入 watchlist 的動作在盤中也不該打 MIS 卡住。用 DB 最新一筆
  quote + 指標算即時階段。盤中加入的檔，autoStage 可能跟盤中即時判定略有出入（用的是 T-1 收盤），
  可接受——反正隔天 `buildCardRow` 會重算 `autoStage` 並比對。
- `consecutiveAboveBand` 從 `scripts/lib/signal-factors/staging` import（`watchlist.ts` 已有 import 它）。

### 3.3 `buildCardRow`：`stage` = `userStage ?? autoStage`

```ts
// 現在：
// const stage: SignalStage = aboveBand.consecutiveDays <= 0 ? "pre-breakout" : ...;
// 改成：
const autoStage: SignalStage =
  aboveBand.consecutiveDays <= 0
    ? "setup"
    : aboveBand.consecutiveDays <= 2
      ? "breakoutDay"
      : "extended";
const stage: SignalStage = item.userStage ?? autoStage;   // 卡片因子渲染看這個
```

下面 `if (stage === "setup")` / breakout 分支的因子計算**完全不動**——只是 `stage` 的來源變了。

`return` 加 `userStage: item.userStage ?? autoStage`、`autoStage`。

### 3.4 `listWatchlist` 撈 `userStage`

`prisma.watchlistItem.findMany` 現在 `include: { stock: {...} }`——`userStage` 是 `WatchlistItem`
自己的欄位，`findMany` 預設就會帶（除非有 `select`）。**確認沒有 `select` 縮限**——現在是 `include`
不是 `select`，所以 `item.userStage` 自動有。無需改（除非 tsc 抱怨型別，那就 `select` 明列）。

### 3.5 `updateWatchlistItem` 加 `userStage`

```ts
export async function updateWatchlistItem(input: {
  code: string;
  userStage?: SignalStage;          // 新增
  isPurchased?: boolean;
  // ... 既有欄位不動
}): Promise<void> {
  const data: Record<string, unknown> = {};
  if (input.userStage !== undefined) data["userStage"] = input.userStage;
  // ... 既有
  if (Object.keys(data).length === 0) return;
  await prisma.watchlistItem.update({ where: { stockCode: input.code }, data });
  revalidatePath("/watchlist");
}
```

- **邊界 map**：`SignalStage` 字串值（`"setup"` 等）== Prisma enum `SignalStage` 的成員名
  （§1.1 特意讓它們一致：`setup` / `breakoutDay` / `extended`）→ **不需要 map**，直接傳。
  （這就是為什麼 §1.1 選 camelCase 而非 `pre_breakout` snake_case——省掉轉換層。）

### 3.6 `WatchlistGallery`：tab 分類 + 異動數字

```ts
// countByStage：{ total, mismatch }
const countByStage = useMemo(() => {
  const m: Record<SignalStage, { total: number; mismatch: number }> = {
    setup: { total: 0, mismatch: 0 },
    breakoutDay: { total: 0, mismatch: 0 },
    extended: { total: 0, mismatch: 0 },
  };
  for (const r of rows) {
    const tab = r.userStage ?? r.autoStage;
    m[tab].total += 1;
    if (r.autoStage !== (r.userStage ?? r.autoStage)) m[tab].mismatch += 1;
  }
  return m;
}, [rows]);

const shown = useMemo(
  () => rows.filter((r) => (r.userStage ?? r.autoStage) === stage),
  [rows, stage],
);
```

tab label：
```tsx
{STAGE_LABELS[s]}（{countByStage[s].total}
{countByStage[s].mismatch > 0 ? ` · ${countByStage[s].mismatch} 異動` : ""}）
```

`useState<SignalStage>` 預設值 `"breakoutDay"`（原 `"breakout-day"`）。

### 3.7 `WatchlistCard`：不一致 chip + 改分類 UI

**不一致 chip**（`row.userStage !== row.autoStage` 時）：
```tsx
{row.userStage !== row.autoStage ? (
  <span className={cn("rounded px-1.5 py-0.5 text-xs", STAGE_PILL_CLASS[row.autoStage])}>
    ⚠ 自動判定：{STAGE_LABELS[row.autoStage]}
  </span>
) : null}
```
放在卡片標頭區，跟現有的 stage pill（顯示 `row.stage` = userStage 的）並排。

**改分類 UI**：卡片底部或標頭加三顆小按鈕（`setup` / `breakoutDay` / `extended`），當前 `userStage`
高亮：
```tsx
<div className="flex gap-1">
  {STAGE_ORDER.map((s) => (
    <button
      key={s}
      onClick={() => startTransition(() => updateWatchlistItem({ code: row.stockCode, userStage: s }))}
      disabled={isPending}
      className={cn(
        "rounded px-2 py-0.5 text-xs",
        row.userStage === s ? STAGE_PILL_CLASS[s] : "bg-muted text-muted-foreground/70 hover:text-foreground",
      )}
    >
      {STAGE_LABELS[s]}
    </button>
  ))}
</div>
```
`WatchlistCard` 已是 `"use client"`、已有 `useTransition`（remove 按鈕在用）——沿用。

### 3.8 驗證功能

- `tsc` 乾淨。
- **加入時 autoStage 寫入**：選股頁勾一檔醞釀中的股票加入 → Prisma Studio 看 `userStage = "setup"`。
  勾一檔突破的 → `userStage = "breakoutDay"`。
- **手動改分類**：watchlist 卡片按「延續爆發」→ 該卡片移到「延續爆發」tab、`userStage` 更新、
  卡片因子變成 breakout 版（法人 diverging bar + PR）。
- **不一致提示**：手動把一檔 `autoStage = extended` 的股票改成 `userStage = setup` →
  a. 該卡片出現「⚠ 自動判定：延續爆發」chip
  b. 「醞釀中」tab label 變「醞釀中（N · 1 異動）」
- **盤中閃動接受**：盤中一檔 `userStage = setup` 的股票即時衝上上軌（`autoStage` 變 `breakoutDay`）
  → 異動數 +1；盤中回落 → 復原。不修。
- `curl http://localhost:3000/watchlist` 三 tab 點過、空 tab 提示正常。

---

## 4. 收尾

- 兩個 commit：
  1. `refactor: 三階段命名統一 setup/breakoutDay/extended + 廢除 WatchlistItem.source`（§1 + §2）
  2. `feat: 觀察股手動分類 userStage + 自動判定不一致提示`（§3）
- `pnpm prisma migrate dev` 的 migration 檔進 commit 1。
- **重跑掃描**：commit 1 之後在分支跑 `run-signal-scan.ts --source=eod`；**merge 到 main 後在
  main 再跑一次**（`data/` gitignored，分支跑的 JSON 不進 git）。
- 更新 `docs/PROGRESS.md`：新增「三階段命名統一 + 觀察股手動分類（PLAN 6）」段——命名對照、
  廢 source 的依據（零讀取）、`userStage` 加入時算 autoStage 的理由、不一致提示設計、
  camelCase enum 省掉邊界 map。
- 更新 `CLAUDE.md`：
  - 三階段相關描述——`pre-breakout` / `breakout-day` → `setup` / `breakoutDay`（全文 grep）。
  - `WatchlistItem` schema 段——移除 `source`、新增 `userStage SignalStage?`（enum）。
  - `/watchlist` 頁段——tab 改用 `userStage`（加入時 = 當下 autoStage）、`autoStage` 即時算只比對、
    不一致提示 a/b、卡片改分類 UI。
  - `addToWatchlist` / `updateWatchlistItem` 描述——`source` 參數移除、`userStage` 加入。
  - `run-signal-scan.ts` 段——`SignalStage` 值改名、JSON `stage` 欄位值改名。
- 更新 `README.md`：若提及三階段名稱 / 觀察清單分類，同步。
- `docs/ROADMAP.md`：§7 全部 checkbox 打勾。**若這是「資料源統一」這條線最後一份**，回覆時提醒
  使用者可規劃下一輪（對照 ROADMAP §5 盤中提醒 / 兩個 deferred 項）。
- `git rm` 無。

---

## 5. 風險 / 取捨

1. **命名統一是大範圍機械改動**（10+ 檔）。緩解：分三個獨立 grep replace（`"pre-breakout"` /
   `"breakout-day"` 帶引號，不誤中 `config.preBreakout` / `stats.breakoutDay` 識別字）；
   `tsc` + 掃描 JSON 重跑 + 三頁點過三重驗證；commit 跟功能分開，壞了好回溯。

2. **舊掃描 JSON 過時**：改完到重跑之間，`/screening` / `/watchlist` 讀舊 `stage` 值會壞
   （`STAGE_LABELS[undefined]`）。所以「改完立刻重跑」是收尾必做項，不是選配。merge 到 main 後
   也要再跑一次。

3. **`addToWatchlist` 加入時算 autoStage 多一次 DB 查詢**（撈 quote + 指標）。批量加入（勾 10 檔）
   = 一次 `findMany`，可接受。加入動作本來就不是高頻。

4. **`userStage` 理論上恆有值**（加入時就寫），但 schema nullable + 既有 watchlist 資料
   （PLAN 6 之前加的）`userStage` 會是 null。緩解：`buildCardRow` / `WatchlistGallery` 一律
   `userStage ?? autoStage`。或 migration 時對既有列跑一次 backfill（算當下 autoStage 填進去）
   ——傾向不 backfill，`?? autoStage` fallback 就夠，既有資料看到卡片後使用者自己釘。
   （若既有 watchlist 有很多檔，可加一個一次性 script 填。看使用者當下 watchlist 檔數決定。）
