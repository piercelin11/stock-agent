# PLAN：前端 scaffolding（Next.js + Prisma）

對應 `docs/ROADMAP.md` 第 2 節。這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識請在完成後回寫 `CLAUDE.md`，過程紀錄回寫 `docs/PROGRESS.md`，ROADMAP 第 2 節的 `- [ ]` 逐項打勾。

---

## 0. 這階段的邊界

**只搭骨架，不做任何業務頁面。** 回測 UI（ROADMAP 3.7）、選股/觀察清單頁（ROADMAP 4）都是後續 PLAN 的事。這份 PLAN 完成的定義是：

- 專案內能跑起一個 Next.js（App Router）dev server，並成功用 Server Action 讀到一筆真實 DB 資料顯示在頁面上（例如「今天 `DailyQuote` 有幾筆」）。
- Prisma client 在 Next.js 進程內是單例，dev hot reload 不會爆連線池。
- `scripts/` 與 `app/` 共用同一份 `generated/prisma` client，型別與 runtime 都對得起來。
- 圖表庫、版面/導覽方案、背景任務機制三項各有一個「可運作的最小範例 + 一段決策說明」，不必完整實作。

**不在範圍**：驗證/登入（本機單人用，不做）、部署設定、CI、Docker、任何 REST/GraphQL route handler（一律 Server Actions）。

---

## 1. 前置事實（已查證，實作時直接採用）

- `package.json` 目前 **無 `next` / `react` / `react-dom`**，`src/` 是空目錄，`"type": "module"`。
- Prisma 7.9.1，client 產於 `generated/prisma`（**非** `node_modules/@prisma/client`），ESM-only，用 `import.meta.url`。
- 連線字串在 `prisma.config.ts` 的 `datasource.url`（讀 `DATABASE_URL`），**不在** `schema.prisma`。
- `PrismaClient` 必須搭 driver adapter：`@prisma/adapter-pg` 的 `PrismaPg`（已是 dependency）。現有腳本一律這樣初始化：
  ```ts
  import { PrismaPg } from "@prisma/adapter-pg";
  import { PrismaClient } from "../../generated/prisma/client.js";
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  ```
- TS 執行工具是 **tsx**，不是 ts-node。`tsconfig.json` 已開 `verbatimModuleSyntax`、`isolatedModules`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`module: nodenext`、`jsx: react-jsx`。
- `.gitignore` 已忽略 `/generated/prisma` 與各 `data/*-results/` 輸出目錄。
- 選股純函式現況：`scripts/screening/calculate-breakout-strength.ts` 匯出 `calculateBreakoutStrength(date)`、`scripts/screening/calculate-accumulation-score.ts` 匯出 `calculateAccumulationScore(date)`。
  - **兩支檔尾已有 `isMain` guard**（`const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href; if (isMain) main()...`）——所以 `import` 這兩支**不會**觸發 `main()` 的副作用（寫檔、`console.log`、`process.exit`）。ROADMAP 3.1 記的「無匯出」只針對 `check-intraday-breakout.ts`，這兩支不受影響。
  - **但兩支檔案頂層仍是 `new PrismaClient()`**（各自 `new PrismaPg(...)` + `new PrismaClient({ adapter })`）——從 Next.js import 會多開一個不受單例管理的連線池。這一點本 PLAN 不處理，留給 3.1，見第 6 節。
- `tsconfig.json` 已開的旗標（實作時全部沿用，其中兩個對 Next 有直接影響）：`module: nodenext`、`target: esnext`、`strict`、`jsx: react-jsx`、`verbatimModuleSyntax`、`isolatedModules`、`moduleDetection: force`、`skipLibCheck`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、**`noUncheckedSideEffectImports`**（← 這個會擋 `import "./globals.css"`，見 4.5）。**沒有** `baseUrl` / `paths` / `moduleResolution` 明確設定（`nodenext` 隱含 `nodenext` 解析）。
- `package.json`：`typescript` 為 **`^7.0.2`**（TS 7，尚非主流版本），`type: "module"`，`@types/node` 在 `dependencies`。`next` / `react` / `react-dom` / `@types/react*` 皆未安裝。`scripts` 只有一個無意義的 `"test"`。
- **沒有 `.env.example`**（`.gitignore` 有 `!.env.example` 白名單但檔案不存在）。`.env` 目前有 `DATABASE_URL`。

---

## 2. 目錄結構決策

**採用 repo 根目錄放 `app/`，不開 `web/` 子目錄，不做 monorepo。**

理由：

- 前端要 import 的東西（`generated/prisma`、`scripts/screening/*`、`scripts/lib/*`）都在根目錄。開 `web/` 子目錄會讓 import path 變 `../generated`、`../scripts`，還要處理子目錄自己的 `package.json` / `node_modules` 或 workspace 設定，對「單人、一個 repo、腳本與 UI 高度共用程式碼」的情境是純負擔。
- monorepo（turborepo 等）的收益是多套件獨立版本管理與快取，這專案沒有這個需求。

最終結構：

```
stock-agent/
  app/                      # Next.js App Router
    layout.tsx
    page.tsx                # 首頁：dashboard 殼（暫時只放一張「DB 連通性」卡片）
    globals.css
    (未來) backtest/…       # 後續 PLAN
    (未來) screening/…      # 後續 PLAN
  lib/                      # 前端共用（新目錄，與 scripts/lib 區隔：這裡放 React/Next 相關）
    prisma.ts              # Prisma 單例（見第 3 節）
    actions/               # Server Actions（見第 5 節）
      health.ts
  components/              # React 元件
    ui/                    # 基礎樣式元件
  scripts/                 # 不動
  generated/prisma/        # 不動，前後端共用
  next.config.ts
  next-env.d.ts            # Next 自動產生，git ignore
  ...
```

- `lib/`（根目錄，新增）放 **Next/React 世界** 的共用碼：Prisma 單例、Server Actions、格式化 helper。
- `scripts/lib/`（既有）維持是 **純 Node 函式庫**（`http.ts` / `breakout-shared.ts` / `accumulation-shared.ts`），不 import React。兩個 `lib/` 命名相近但職責清楚，PLAN 完成時在 `CLAUDE.md` 「開發慣例」補一句說明。

---

## 3. Prisma 單例（`lib/prisma.ts`）

Next.js dev 的 hot reload 會反覆 re-evaluate 模組，每次 `new PrismaClient()` 都開一個新連線池 → 很快耗盡 Postgres 連線。標準解法是把 client 掛在 `globalThis` 上快取。**要保留現有的 `PrismaPg` driver adapter 寫法。**

```ts
// lib/prisma.ts
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const makeClient = () => {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
};

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof makeClient>;
};

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

注意事項：

- **import 路徑帶 `.js` 副檔名**（`../generated/prisma/client.js`）——generated client 是 ESM、`verbatimModuleSyntax` 生效，跟 scripts 現有寫法一致。若 Next 的 bundler 對 `.js` 指向 `.ts` 檔有問題，退路是在 `next.config.ts` 設 `serverExternalPackages: ["@prisma/adapter-pg", "pg"]` 讓 Prisma 相關套件走 Node require 不進 bundler（見第 4 節）。
- `dotenv/config`：Next.js 自己會載 `.env`，但 `generated/prisma` / `prisma.config.ts` 世界預期 `process.env.DATABASE_URL` 已存在。保留這行最保險，且與 scripts 行為一致。**驗收時確認 `.env` 的 `DATABASE_URL` 有被讀到**（Next 對 `.env` 的載入順序：`.env` → `.env.local` → `.env.[NODE_ENV]`；本專案只有 `.env`，OK）。
- **只在 Server 端 import 這支**。Server Components 與 Server Actions 可以；任何 `"use client"` 檔案 import 到會直接壞。**檔頭加 `import "server-only";` 當護欄，並把 `server-only` 列進 dependency（本 PLAN 建議必裝，不是可選）**——理由：`scripts/lib/` 與根目錄 `lib/` 名字幾乎一樣，未來很容易在 client component 誤 import `lib/prisma.ts`，`server-only` 是唯一能在 build 時就擋下這個錯的機制，體積 <1KB。

---

## 4. Next.js 安裝與設定

### 4.0 步驟 0：Next hello-world 煙霧測試（先做，切開風險）

**在碰 Prisma / Tailwind / Recharts 之前，先確認「Next 本身能在這個 toolchain 上跑起來」。** 這專案用的是 TS 7（`^7.0.2`，尚非主流）、Prisma 7、ESM-only、`type: "module"`，Next.js 對這組合的相容性 PLAN 無法事先查證，必須實測。

1. `npm install next react react-dom` + `npm i -D @types/react @types/react-dom`。
2. 最小 `next.config.ts`（先不加 `serverExternalPackages`）+ `app/layout.tsx`（`<html><body>{children}</body></html>`，帶 `lang="zh-Hant"`）+ `app/page.tsx`（純 `export default function Page() { return <h1>ok</h1>; }`，**不 import 任何 Prisma / CSS**）。
3. `npm run dev`，確認 `http://localhost:3000` 出現 "ok"、terminal 無 error。
4. `npm run build`，確認靜態 build 通過。

**這一步過了才往下做。** 若 `next dev` 起不來（多半是 TS 7 或 Turbopack 對 `nodenext` / `type: module` 的問題），在這裡就地決策：降 `typescript` 到 Next 官方支援的版本區間（影響 `scripts/` typecheck，需回跑 `npx tsc --noEmit` 對照）、或改用 webpack（`next dev --webpack`）。把結論記進 PROGRESS。

### 4.1 安裝

手動加依賴（不跑 `create-next-app`，因為它會覆寫 `tsconfig.json` / `package.json` 既有設定、可能動到 `"type": "module"` 與 Prisma 相關欄位）：

```bash
npm install next react react-dom
npm install --save-dev @types/react @types/react-dom
```

版本：裝當前 stable Next（App Router）。實作時記錄實際版號到 PROGRESS.md。

`package.json` 加 scripts：

```jsonc
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
    // 既有的先留著（目前只有無意義的 "test"，可順手清掉）
  }
}
```

### 4.2 `next.config.ts`

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma client + pg driver 不進 webpack/turbopack bundle，用 Node 原生 require
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default nextConfig;
```

`serverExternalPackages` 是這裡的關鍵：Prisma 7 的 generated client 用 `import.meta.url` 定位 engine/schema 檔，被打包會找不到路徑。列為 external 讓它在 server 端照常用 Node 模組解析。

### 4.3 `tsconfig.json` 調整

現有 `tsconfig.json` 給 scripts 用，Next 需要幾個額外欄位。**用增量方式加，不要讓 `create-next-app` 重寫整份**：

- 加 `"plugins": [{ "name": "next" }]`
- 加 `"moduleResolution": "bundler"` —— **但這可能與 scripts 的 `nodenext` 衝突**。決策：
  - 方案 A（推薦）：根 `tsconfig.json` 改 `moduleResolution: "bundler"` + `module: "esnext"`，實測 scripts 用 tsx 執行不受影響（tsx 自己解析模組，不看 `moduleResolution`），只有 `npx tsc --noEmit` 的型別檢查行為變化 —— 跑一次確認 scripts 無新增錯誤。
  - 方案 B：建 `app/tsconfig.json` 繼承根設定再 override。多一層檔案，較囉唆。
  - **先試方案 A，跑 `npx tsc --noEmit` 驗證 scripts 乾淨就定案；有問題退方案 B。**
- `"include"` 要涵蓋 `app/`、`lib/`、`components/`、`next-env.d.ts`。
- `"jsx": "react-jsx"` 已經有了，不動。

### 4.4 `.gitignore` 追加

```
# Next.js
/.next/
/next-env.d.ts
/out/
```

### 4.5 已知 toolchain 風險（實作時 100% 會撞到，先寫在這）

| 風險 | 症狀 | 對策 |
| --- | --- | --- |
| **TS 7 × Next stable 相容性** | `next dev` / `next build` 直接報 TS 版本不支援，或 type plugin 載入失敗 | 4.0 步驟 0 就會暴露。降 `typescript` 版本（回跑 `npx tsc --noEmit` 確認 `scripts/` 不壞）或改 `--webpack`。**決策記 PROGRESS。** |
| **`noUncheckedSideEffectImports: true` 擋 `import "./globals.css"`** | `app/layout.tsx` 的 `import "./globals.css"` 報 `Side effect import ... has no known side effects` | 三選一：① `app/globals.css` 旁放一支 `globals.css.d.ts`（`declare module "*.css";`）；② 該行加 `// @ts-expect-error side-effect css import`；③ 在 `next-env.d.ts` 之外自建 `app/css.d.ts`。**選 ①，寫進 CLAUDE.md「開發慣例」。** 不要為此關掉 `noUncheckedSideEffectImports`（scripts 也吃這個旗標）。 |
| **`next build` 靜態預渲染 `app/page.tsx` 時連本機 Postgres** | build 在 `Collecting page data` 卡住或報連線失敗（CI / 沒開 DB 時必爆） | `app/page.tsx` 檔頭加 `export const dynamic = "force-dynamic";`（health 卡片本來就該每次即時查）。**驗收清單 §11 的 `next build` 要在此前提下才會過。** |
| **generated Prisma client 的 `import.meta.url` 被 bundler 打包** | server action 執行時報找不到 schema / engine 路徑 | 4.2 的 `serverExternalPackages` 處理。步驟 0 刻意不加，是為了先隔離「Next 本身」的問題；串 Prisma（步驟 3）時才加。 |
| **`spawn` 背景任務用 `npx tsx`（§9）** | detached 子進程解析 `npx` 慢、PATH 依賴、stdout 收不到 | 沿用 `daily_pipeline.plist` 已驗證的模式：絕對路徑指向 `node_modules/tsx/dist/cli.mjs`，目標腳本當參數。見 §9 修正。 |

---

## 5. Server Actions（不建 REST/GraphQL）

一律用 Server Actions 直接呼叫 Prisma 與選股純函式。這份 PLAN 只需要一個「健康檢查」action 證明鏈路通。

```ts
// lib/actions/health.ts
"use server";

import { prisma } from "../prisma.js";

export async function getDbHealth() {
  const [quoteCount, latestQuote, stockCount] = await Promise.all([
    prisma.dailyQuote.count(),
    prisma.dailyQuote.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
    prisma.stock.count(),
  ]);
  return {
    quoteCount,
    stockCount,
    latestQuoteDate: latestQuote?.date.toISOString().slice(0, 10) ?? null,
  };
}
```

`app/page.tsx`（Server Component）直接 `await getDbHealth()` 並 render。這就是 PLAN 的核心驗收點。

**`app/page.tsx` 檔頭必須加 `export const dynamic = "force-dynamic";`**——否則 `next build` 會試圖靜態預渲染此頁、在 build time 連本機 Postgres（CI / 沒開 DB 時直接失敗）。health 卡片本來就該每次即時查，force-dynamic 語意正確。

**慣例定調（寫進 CLAUDE.md）**：

- Server Actions 檔案放 `lib/actions/*.ts`，檔頭 `"use server"`。
- action 只做「呼叫 Prisma / 純函式 → 回傳 plain object」。回傳值必須可序列化（`Date` 要先轉字串或讓 client 端處理，`Decimal` 要 `.toNumber()` / `.toString()`）—— Prisma `Decimal` 直接丟給 client component 會出問題，在 action 邊界就轉掉。
- 寫入型 action 之後才會有（觀察清單），這份 PLAN 不做。

---

## 6. 選股純函式的 import 問題（重要，需在這份 PLAN 處理到「可被安全 import」）

ROADMAP 3.7 / 4.1 預期 Server Action 直接 `import { calculateBreakoutStrength }`。但目前這兩支 screening 腳本：

1. 檔案頂層 `new PrismaClient()` —— 會再開一個不受單例管理的連線池。
2. `main()` 有副作用（寫 `data/*-results/{date}.json`、`console.log` 一堆）。
3. `check-intraday-breakout.ts` 完全沒有匯出（ROADMAP 3.1 已記）。

**現況（2026-08-28 查證，比舊版 PLAN 樂觀）：**

- **`isMain` guard 兩支都已經有了**（檔尾 `const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href; if (isMain) main()...`）。所以「import 即觸發副作用」的前提**不成立**——`import { calculateBreakoutStrength }` 只會執行到 module top-level，不會跑 `main()`（不寫檔、不 `console.log` 一堆、不 `process.exit`）。本 PLAN 不需要動這部分。
- **仍未解的只有頂層 `new PrismaClient()`**：兩支檔案 module top-level 各自 `new PrismaPg(...)` + `new PrismaClient({ adapter })`。從 Next.js import 會多開一個不受 `lib/prisma.ts` 單例管理的連線池。這份 PLAN **先不動**（改動風險外溢到 CLI 行為），留給 ROADMAP 3.1 連同 `config?` 參數重構成 `calculateX(date, { prisma, config })` 注入式。

**因此本 PLAN 的 health action 只碰 Prisma、不 import 選股函式**——不是因為「import 會爆」，而是因為 import 會多開一個連線池，在 scaffolding 階段沒必要引入這個雜訊。選股函式的實際 UI 串接留給 ROADMAP 4.1，屆時 3.1 的注入式重構應已完成。

---

## 7. 圖表庫

**定案：Recharts。** 與 ROADMAP 傾向一致。

理由：React 宣告式 API、SSR 友善（可在 Server Component 外包 client wrapper）、體積可接受、回測儀表板需要的圖（報酬分布直方圖、命中率折線、訓練 vs 驗證並排長條）都是它的標準能力，不需要 D3 等級的自訂。

這份 PLAN 只需要：

```bash
npm install recharts
```

加一個 `components/ChartSmoke.tsx`（`"use client"`）畫一張寫死資料的小折線圖，放進首頁確認 SSR + client hydration 正常、build 不炸。不做任何真實資料綁定。

---

## 8. 版面 / 導覽 / 樣式方案

**定案：**

- **樣式：Tailwind CSS v4**（`create-next-app` 預設值，生態成熟，適合快速搭內部工具）。手動裝：`npm install -D tailwindcss @tailwindcss/postcss postcss`，加 `postcss.config.mjs`（`export default { plugins: { "@tailwindcss/postcss": {} } };`）與 `app/globals.css` 的 `@import "tailwindcss";`。
  - **`app/layout.tsx` 的 `import "./globals.css"` 會被 `noUncheckedSideEffectImports` 擋下**（見 4.5）。對策：新增 `app/globals.css.d.ts` 內容 `declare module "*.css";`，並在 CLAUDE.md「開發慣例」寫一句。不要關掉該旗標。
- **元件：先不引入元件庫**（shadcn/ui 等；也不是「用 Tailwind 就等於用某個元件庫」——這裡只用 Tailwind 的 utility class，元件自己刻）。內部工具、頁面少，先手刻幾個 `components/ui/`（Card、Button、Table、NumberInput）夠用。要引入等頁面長出來、有重複感再說。
- **導覽：** `app/layout.tsx` 放一個極簡側邊欄或頂欄，先寫死三個連結佔位（Dashboard / Backtest / Screening），後兩個指向還不存在的路由沒關係（或先 `#`）。
- **主題：** 不做深淺色切換，固定一套。內部工具不需要。

這份 PLAN 的產出：`layout.tsx` 有可運作的殼版面 + 一個 `page.tsx` 首頁，視覺陽春但結構對。

---

## 9. 背景任務機制（只確立模式，不實作回測）

ROADMAP 3.3 的 Layer 0 基準跑會跑數百個交易日，需要「Server Action 觸發 → 背景 worker → UI 輪詢進度」。這份 PLAN **只做一個玩具級 PoC 確立模式**，不接任何真實回測邏輯。

**選定模式：獨立 Node 子進程 + 進度寫檔 + Server Action 輪詢讀檔。**

理由與取捨：

- 這專案沒有、也不想引入 Redis / message queue / BullMQ 這類基礎設施（單人本機用）。
- Next.js 進程內開 `setInterval` 長跑任務不可靠（dev 會 hot reload 中斷、部署後多實例會重複跑），且會佔住 Next 的 event loop。
- 「`child_process.spawn` 一個 `tsx scripts/backtest/run-layer0.ts` + 該腳本每處理完一天就覆寫 `data/backtest-runs/{run-id}/progress.json`」符合現有專案風格（一堆 `tsx` 腳本 + 檔案輸出），零新依賴。
- UI 端：Server Action `getBacktestProgress(runId)` 讀那個 `progress.json` 回傳，client component 用 `setInterval` 每 1~2 秒呼叫一次。跑完 `progress.json` 標 `status: "done"`。

**這份 PLAN 的 PoC 具體內容：**

1. `scripts/_poc/long-task.ts`：跑一個 10 秒的假迴圈，每秒寫 `data/_poc/progress.json`（`{ current, total, status }`）。
2. `lib/actions/poc.ts`：
   - `startPocTask()` → **沿用 `daily_pipeline.plist` 已驗證的模式，不要用 `npx tsx`**：`spawn(process.execPath, [require.resolve... 或絕對路徑 "node_modules/tsx/dist/cli.mjs", "scripts/_poc/long-task.ts"], { detached: true, stdio: "ignore" })`（PROGRESS 2026-08-23 段的教訓：`generated/prisma/` 是純 `.ts`，plist 不能用 `node` 跑 `.ts`，必須指向 tsx 的 cli.mjs 絕對路徑）。`detached: true` + `child.unref()`。回傳一個 id。
   - `getPocProgress()` → 讀 `data/_poc/progress.json` 回傳。
3. `components/PocRunner.tsx`（`"use client"`）：按鈕觸發 `startPocTask`，之後每秒 poll `getPocProgress` 顯示進度條。
4. 放在首頁一角。**這些 `_poc` 檔案在下一份 PLAN（回測）開始時刪除**，PROGRESS 註明。

`data/_poc/` 加進 `.gitignore`。

---

## 10. 實作步驟（順序）

0. **Next hello-world 煙霧測試（見 4.0）**：裝 `next`/`react`/`react-dom`/`@types/react*`，最小 `next.config.ts` + `layout.tsx` + `page.tsx`（不碰 Prisma/CSS），`npm run dev` 起得來、`npm run build` 過。**卡在這裡就先解 toolchain（TS 7 相容性 / webpack fallback），結論記 PROGRESS。**
1. **裝 Tailwind + Recharts**（Next 已在步驟 0 裝好），加 `package.json` 其餘 scripts，`next.config.ts` 補 `serverExternalPackages`。
2. **`tsconfig.json` 增量調整**（方案 A：`moduleResolution: "bundler"` + `module: "esnext"` + `plugins: [{ name: "next" }]` + `include` 涵蓋 `app/`/`lib/`/`components/`/`next-env.d.ts`），跑 `npx tsc --noEmit` 確認 scripts 無新增錯誤（既有的 `prisma.config.ts` 錯誤與本次無關，忽略）。有衝突退方案 B。
3. **`lib/prisma.ts` 單例**（裝 `server-only` 並在檔頭 `import "server-only";`——見 §3）+ `.gitignore` 追加 Next 條目 + 新增 `.env.example`（列 `DATABASE_URL`）。
4. **`app/layout.tsx`（`lang="zh-Hant"`、`import "./globals.css"`）+ `app/globals.css` + `app/globals.css.d.ts`（`declare module "*.css";`）+ `app/page.tsx`（`export const dynamic = "force-dynamic";`）** 最小殼，`next dev` 首頁出現。
5. **`lib/actions/health.ts`** + 首頁 render 真實 DB 數字（**核心驗收**）。
6. **`components/ChartSmoke.tsx`** 放首頁，確認 `next build` 通過（前提：`page.tsx` 已 `force-dynamic`）。
7. **背景任務 PoC**（`scripts/_poc/`、`lib/actions/poc.ts` 用 tsx cli.mjs 絕對路徑 spawn、`components/PocRunner.tsx`）。`data/_poc/` 加 `.gitignore`。
8. ~~補 screening 兩支的 `isMain` guard~~ —— **已完成，兩支檔尾都有，此步刪除。**
9. **回寫文件**：CLAUDE.md（新增「前端」段落：目錄結構、`lib/` vs `scripts/lib/` 區別、Prisma 單例位置與 `server-only`、`*.css` d.ts 慣例、Server Actions 慣例、`force-dynamic` 慣例、背景任務 spawn 模式）、README.md（「目前功能」加前端、「使用方式」加 `npm run dev`、「環境需求」補 Node 版本 + TS 版本結論）、PROGRESS.md（本次進度 + toolchain 決策 + 已知 TODO：頂層 `new PrismaClient()` 注入式重構留給 3.1、`_poc` 檔案待刪）、ROADMAP.md 第 2 節五個 `- [ ]` 打勾。

---

## 11. 驗收清單

- [ ] **步驟 0 煙霧測試過**：純 `page.tsx`（無 Prisma/CSS）能 `next dev` + `next build`。若降了 `typescript` 版本，`npx tsc --noEmit` 對 `scripts/` 仍乾淨。
- [ ] `npm run dev` 啟動，`http://localhost:3000` 首頁顯示：真實 `DailyQuote` 筆數、`Stock` 筆數、最新報價日期（數字與 `npx tsx` 直接查 DB 一致）。
- [ ] 修改一個 Server Component 檔案觸發 hot reload 數次，Postgres 連線數不持續增長（`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database();` 觀察）。
- [ ] `npm run build` 成功，無型別錯誤（前提：`app/page.tsx` 已 `export const dynamic = "force-dynamic"`，否則 build 會在預渲染時連 DB）。
- [ ] `import "./globals.css"` 不再報 `noUncheckedSideEffectImports` 錯（`app/globals.css.d.ts` 已建）。
- [ ] `npx tsc --noEmit` 對 `scripts/` 無新增錯誤（比對本 PLAN 前的基準）。
- [ ] Recharts smoke 圖在頁面正常顯示（SSR + hydration 無 console error）。
- [ ] 背景任務 PoC：按鈕點下去，進度條 0 → 10 走完，`data/_poc/progress.json` 內容隨之更新（spawn 用 tsx `cli.mjs` 絕對路徑，非 `npx tsx`）。
- [ ] `scripts/` 既有腳本行為未變：`npx tsx scripts/screening/calculate-breakout-strength.ts --date=<某交易日>` 仍正常輸出到 `data/breakout-strength-results/`。
- [ ] 四份文件（CLAUDE.md / README.md / PROGRESS.md / ROADMAP.md）已同步。

---

## 12. 已知風險 / 待後續 PLAN 處理

| 項目 | 處理時機 |
| --- | --- |
| 選股純函式頂層 `new PrismaClient()`（**副作用 `main()` 已被 `isMain` guard 擋住，不是問題**）→ 改注入式 `calculateX(date, { prisma, config })` 讓它吃單例 | ROADMAP 3.1「腳本參數化」 |
| `check-intraday-breakout.ts` 無匯出 | ROADMAP 3.1 |
| `_poc` 背景任務檔案 | 下一份 PLAN（回測）開始時刪除，換成真的 Layer 0 runner |
| Server Action 回傳 `Decimal` / `Date` 序列化 | 每個實際 action 實作時在邊界轉型；本 PLAN 的 health action 已示範 |
| 部署 / DB 外部連線 | ROADMAP 5.1，與本階段無關 |
| `moduleResolution` 方案 A 若與 scripts typecheck 衝突 | 實作步驟 2 當場決定退方案 B |
| **TS 7 × Next stable 不相容** | 步驟 0（§4.0）當場決策：降 `typescript` 版本或 `--webpack`；結論記 PROGRESS |
| **`next build` 靜態預渲染連 DB** | `app/page.tsx` 加 `force-dynamic`（§4.5、§5） |
| **`import "./globals.css"` 被 `noUncheckedSideEffectImports` 擋** | `app/globals.css.d.ts`（§4.5、§8） |
