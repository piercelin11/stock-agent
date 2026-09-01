# PLAN：前端顏色統一管理（semantic token 化）

把散在 11 個前端檔、約 134 行的 Tailwind 色階 class（`text-slate-400`、`bg-blue-600`、
`text-rose-400`…）收斂成 **`app/globals.css` 一處定義的 semantic token**（值用 HEX，方便
VS Code 原生色盤微調）。元件只寫語意 class（`text-fg-subtle`、`bg-primary`、`text-up`、
`text-warning`…），不再出現色階數字。漲跌色 / 號誌色 / 狀態色各有獨立 token，語意不再靠
色相硬記。

參考專案 `../quick-talk` 的 shadcn 模式，但**不引入 shadcn**——只借「CSS 變數 token +
Tailwind v4 `@theme inline` + `cn()` helper」三樣。維持全站寫死 dark，不引入 light mode。

這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識回寫 `CLAUDE.md`，
過程紀錄回寫 `docs/PROGRESS.md`。

**分支**：`feat/color-tokens`（已從 `main` 開）。merge 時機等使用者發話。

---

## 0. 邊界

### 做的事

1. `pnpm add clsx tailwind-merge`（runtime 依賴，quick-talk 同版本區間）。
2. 新增 `lib/cn.ts`（quick-talk 的 4 行標配：`twMerge(clsx(...))`）。
3. 改寫 `app/globals.css`：定義 ~23 個 HEX token + `@theme inline` 接成 Tailwind utility。
4. 逐檔把 raw 色階 class 換成 semantic class（11 個檔，對照表見 §2）。
5. 順手把「本來就有條件三元拼 class」的地方換成 `cn()`（不強求全面鋪，見 §3）。
6. 更新 `CLAUDE.md` 前端段配色規範 + 套件清單、`docs/PROGRESS.md` 記錄、`docs/ROADMAP.md` 視情況打勾。

### 不做的事

- **不裝 `class-variance-authority`**：`Button.tsx` 只有單一 `variant` 維度，現有
  `Record<Variant, string>` 寫法就是 cva 的手寫版，夠用。日後 Button 要加 `size` 維度再說。
- **不引入 light mode**：`:root` 只放一份 dark 值。未來要主題切換另開 PLAN。
- **不引入 shadcn / `components.json` / registry**：UI 元件只有 Card / Button 兩個，不值得。
- **不改任何邏輯 / 版面 / 元件結構**：純 class 字串與顏色常數替換。

---

## 1. 套件與 `lib/cn.ts`

```
pnpm add clsx tailwind-merge
```

- `clsx` — 條件拼 class
- `tailwind-merge` — 解 class 衝突（元件內建 class vs 外部傳入 `className`，後者能覆蓋前者同類）

`lib/cn.ts`（放 `lib/`：CLAUDE.md 對 `lib/` = Next/React 世界共用碼、`scripts/lib/` = 純 Node 的分工）：

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

---

## 2. `app/globals.css` — token 定義

目前只有 8 行（`@import` + `color-scheme: dark` + body 兩 class）。改成：

```css
@import "tailwindcss";

/* ── semantic color tokens：全站顏色的單一出處。值用 HEX 方便 VS Code 原生色盤微調。 ──
   維持全站寫死 dark（只一份 :root 值）。分五組：表面/文字階層、主色、台股漲跌、
   狀態語意、大盤號誌色。漲跌（--up/--down）與號誌（--regime-*）、狀態（--warning/
   --danger）刻意語意分離——色相可能相近但用途不同，不可互相複用。 */
:root {
  color-scheme: dark;

  /* 表面 / 文字階層（原 slate-*）*/
  --color-bg: #020617;            /* slate-950  頁底 */
  --color-surface: #0f172a;       /* slate-900  卡片 / 側欄 */
  --color-surface-2: #1e293b;     /* slate-800  hover 底 / 內層區塊 / badge 底 */
  --color-border: #1e293b;        /* slate-800  分隔線 / 邊框 */
  --color-border-strong: #334155; /* slate-700  input 邊框 */
  --color-fg: #f1f5f9;            /* slate-100  主文字 */
  --color-fg-muted: #cbd5e1;      /* slate-300  次要文字 */
  --color-fg-subtle: #94a3b8;     /* slate-400  說明文字 / 欄位 label */
  --color-fg-faint: #64748b;      /* slate-500  更弱說明 / 表頭 */
  --color-fg-ghost: #475569;      /* slate-600  最弱 / dashed 基準線 / 無資料圓點 */

  /* 主色：按鈕 / 選中列 / tab 底線（原 blue-*）*/
  --color-primary: #2563eb;       /* blue-600 */
  --color-primary-hover: #3b82f6; /* blue-500 */
  --color-on-primary: #ffffff;

  /* 台股漲跌：漲紅跌綠，深色底提亮一階（原 rose-400 / emerald-400）*/
  --color-up: #fb7185;            /* rose-400 */
  --color-down: #34d399;          /* emerald-400 */

  /* 狀態語意 */
  --color-warning: #fbbf24;       /* amber-400  「估」badge / fallback 提示框 */
  --color-warning-border: #92400e;/* amber-800 */
  --color-danger: #fb7185;        /* rose-400   錯誤 /「追」風險 badge / 失敗訊息 */
  --color-danger-border: #9f1239; /* rose-800 */
  --color-danger-fg: #fda4af;     /* rose-300   錯誤框 / 提示框內文字 */
  --color-success: #10b981;       /* emerald-500  燈號「已更新」/ 高分 / 完成訊息 */

  /* 大盤號誌色（RegimeBanner；通用號誌語意，跟個股漲跌色不同區塊不混淆）*/
  --color-regime-bull: #10b981;   /* emerald-500 */
  --color-regime-neutral: #f59e0b;/* amber-500 */
  --color-regime-bear: #f43f5e;   /* rose-500 */
}

/* ── 把 CSS 變數接成 Tailwind utility：bg-bg / text-fg-subtle / border-border …
   Tailwind v4 慣用寫法（quick-talk globals.css 同款）。@theme inline 只宣告「生成
   對應 utility」，實際值仍讀 :root。 */
@theme inline {
  --color-bg: var(--color-bg);
  --color-surface: var(--color-surface);
  --color-surface-2: var(--color-surface-2);
  --color-border: var(--color-border);
  --color-border-strong: var(--color-border-strong);
  --color-fg: var(--color-fg);
  --color-fg-muted: var(--color-fg-muted);
  --color-fg-subtle: var(--color-fg-subtle);
  --color-fg-faint: var(--color-fg-faint);
  --color-fg-ghost: var(--color-fg-ghost);
  --color-primary: var(--color-primary);
  --color-primary-hover: var(--color-primary-hover);
  --color-on-primary: var(--color-on-primary);
  --color-up: var(--color-up);
  --color-down: var(--color-down);
  --color-warning: var(--color-warning);
  --color-warning-border: var(--color-warning-border);
  --color-danger: var(--color-danger);
  --color-danger-border: var(--color-danger-border);
  --color-danger-fg: var(--color-danger-fg);
  --color-success: var(--color-success);
  --color-regime-bull: var(--color-regime-bull);
  --color-regime-neutral: var(--color-regime-neutral);
  --color-regime-bear: var(--color-regime-bear);
}

body {
  @apply bg-bg text-fg antialiased;
}
```

> **先驗證這個語法**（見 §5 步驟 1）。若 Tailwind v4 對 `@theme inline` 同名自我參照
> 報錯，改為：`:root` 用 `--app-bg` 等前綴，`@theme inline` 寫 `--color-bg: var(--app-bg)`。

透明度修飾子（`/40` `/50` `/20` `/15`）Tailwind v4 對 `@theme` 生成的 color utility
一樣支援（`bg-surface-2/50`、`bg-warning/15`）。

### 替換對照表

| 現在（raw class） | 換成（semantic） | 語意 |
|---|---|---|
| `bg-slate-950` | `bg-bg`（log `<pre>` 底也是） | 頁底 |
| `bg-slate-900` | `bg-surface` | 卡片 / 側欄 |
| `bg-slate-800`, `bg-slate-800/50`, `bg-slate-800/40` | `bg-surface-2`（保留 `/50` 等修飾） | hover 底 / 內層 |
| `bg-slate-700`, `bg-slate-600` | `bg-surface-2` | badge / tag 底 |
| `border-slate-800`, `divide-slate-800` | `border-border`, `divide-border` | |
| `border-slate-700` | `border-border-strong` | input / textarea 邊框 |
| `text-slate-100` | `text-fg` | 主文字 |
| `text-slate-300`, `text-slate-200` | `text-fg-muted` | 次要文字 |
| `text-slate-400` | `text-fg-subtle` | 說明 / label（`FieldLabel` 內建） |
| `text-slate-500` | `text-fg-faint` | 更弱說明 / 表頭 |
| `text-slate-600` | `text-fg-ghost` | 最弱 |
| `bg-blue-600` | `bg-primary` | 主按鈕 / 選中 |
| `bg-blue-500`, `hover:bg-blue-500` | `bg-primary-hover`, `hover:bg-primary-hover` | |
| `border-blue-500` | `border-primary-hover` | tab 底線 |
| `bg-blue-950/40`, `bg-blue-950/60` | `bg-primary/15`（選中列淡底 / 突破 pill；微調透明度到視覺接近） | |
| `text-blue-300` | `text-primary-hover` | 突破 pill 文字 |
| `text-white`（primary 按鈕上） | `text-on-primary` | |
| `text-rose-400`（漲跌%正、籌碼正） | `text-up` | 漲 |
| `text-emerald-400`（漲跌%負、籌碼負） | `text-down` | 跌 |
| `text-amber-400`, `text-amber-300` | `text-warning` | 「估」/ 提示 |
| `border-amber-800` | `border-warning-border` | |
| `bg-amber-500/20`, `bg-amber-950/40`, `bg-amber-950/30`, `bg-amber-500` | `bg-warning/15`（badge / 提示框底），純 `bg-amber-500` → `bg-warning` | |
| `text-rose-300` | `text-danger-fg` | 錯誤框內文字 |
| `text-rose-400`（「追」badge、danger 按鈕、失敗訊息） | `text-danger` | 風險 / 錯誤 |
| `border-rose-800` | `border-danger-border` | |
| `border-rose-500/40` | `border-danger/40` | bearish 卡片邊框 |
| `bg-rose-500/20`, `bg-rose-950`, `bg-rose-950/40`, `bg-rose-950/30` | `bg-danger/15` | |
| `bg-emerald-500`（Dashboard 燈號「已更新」） | `bg-success` | |
| `bg-emerald-500`（RegimeBanner bull 圓點）, `bg-amber-500`（neutral 圓點）, `bg-rose-500`（bear 圓點） | `bg-regime-bull` / `bg-regime-neutral` / `bg-regime-bear` | 逐處分辨，與燈號的 emerald 語意不同 |
| `bg-slate-600`（RegimeBanner 無資料 / fallback 圓點） | `bg-fg-ghost` | |
| `text-emerald-400`（WatchlistPerfTable `scoreClass` ≥70、PipelineRunner「完成」） | `text-success` | 「好 / 完成」語意 |

### 檔案清單（依建議順序：粗到細，一次 1–2 檔 + `git diff` 檢查）

1. `app/globals.css` — §2（先單獨驗證，見 §5 步驟 1）
2. `lib/cn.ts` — §1（新檔）
3. `app/layout.tsx` — 側欄 3 處
4. `components/ui/Card.tsx` — `Card` / `FieldLabel` / `Stat`（`FieldLabel` 是全站次級文字單一出處）
5. `components/ui/Button.tsx` — `styles` Record 三 variant 全換。`danger` → `border-danger-border bg-surface text-danger hover:bg-danger/15`；`primary` disabled → `disabled:bg-surface-2 disabled:text-fg-subtle`
6. `components/screening/ScreeningPanel.tsx` — 最大宗：表格、`changePercentCell`、「估」/「追」badge、5 個提示框、進度條、tab、mode toggle、選中列
7. `components/dashboard/RegimeBanner.tsx` — `DOT_CLASS` map（→ regime-* 三色）、`dotClass` fallback、`DimensionRow`、strip / banner 兩 variant、`isBearish` 邊框
8. `components/dashboard/WatchlistPerfTable.tsx` — `scoreClass`、`instClass`/`trustClass`、`Card`、`ScoreItem`。**⚠ `Sparkline` 內 SVG 的 `stroke` / `<line stroke>` 是硬編 HEX 字串**（`#fb7185` / `#34d399` / `#475569`），非 class → 在檔頂宣告 `const SPARK_UP = "#fb7185"` / `SPARK_DOWN` / `SPARK_BASELINE` 常數 + 註解「對應 `--color-up` / `--color-down` / `--color-fg-ghost`，改色需同步 globals.css」（此元件是 Server Component，不能 `getComputedStyle`）
9. `components/dashboard/PipelineRunner.tsx` — 按鈕、`FieldLabel` 覆蓋色、log `<pre>` 底色
10. `components/watchlist/WatchlistTable.tsx` — 卡片、`SnapshotBlock`、`Field`、`InputField`、漲跌色、`textarea`/`input` 邊框
11. `app/page.tsx` — `coverageClass`（rose→danger、amber→warning、slate-100→fg）、燈號圓點、覆蓋率列
12. `app/screening/page.tsx` — 標題、說明文字
13. `app/watchlist/page.tsx` — 標題、說明、空清單框、`<Link>`

---

## 3. `cn()` 導入範圍

本輪主軸是 class 替換，`cn()` 只在**已經有條件三元拼 class** 的地方順手換（可讀性提升），
不強求全面鋪。明確候選：

- `components/ui/Button.tsx`：`` `... ${styles[variant]} ${className}` `` → `cn("...base...", styles[variant], className)`
- `components/ui/Card.tsx` `FieldLabel`：`` `text-sm text-fg-subtle ${className}` `` → `cn("text-sm text-fg-subtle", className)`
- `components/screening/ScreeningPanel.tsx`：`RowGroup`（`isSelected` + `priceSource` 兩段三元）、tab 按鈕、mode toggle 按鈕
- `components/dashboard/WatchlistPerfTable.tsx` `ScoreItem` 的 `scoreClass` 拼接、`PipelineRunner` `FieldLabel` 覆蓋

其餘純靜態 class 字串不動。

---

## 4. 文件回寫

- **`CLAUDE.md`「前端」段**：把「配色基準 = Tailwind slate 系（`bg-slate-900`…）；`Button` primary = `bg-blue-600`…台股漲跌色…（漲 `text-rose-400` / 跌 `text-emerald-400`）」整段改寫為：
  > 配色 = `app/globals.css` 的 semantic token（`bg-surface` / `text-fg-subtle` / `text-fg-faint` / `border-border` / `bg-primary` / `text-up` / `text-down` / `text-warning` / `text-danger` / `bg-regime-{bull,neutral,bear}`…），值為 HEX、**單一出處**；元件不直接寫 `slate-*` / `blue-*` / `rose-*` 等色階。台股漲跌用 `--color-up`/`--color-down`（漲紅跌綠），跟號誌色 `--color-regime-*`、狀態色 `--color-warning`/`--color-danger` **語意分離不共用**。`cn()`（`lib/cn.ts`）= `clsx` + `tailwind-merge`，用於條件拼 class / 讓外部 `className` 能覆蓋元件內建色。
- **`CLAUDE.md`「前端」技術棧行**：套件清單補 `clsx` / `tailwind-merge`。
- **`docs/PROGRESS.md`**：新增一段（日期 2026-09-01）記動機、token 清單、涉及 13 檔、`cn` 導入範圍、`@theme inline` 語法驗證結果、Sparkline SVG 常數處理。
- **`docs/ROADMAP.md`**：檢查有無相關 todo，有則打勾；無則不動（本任務非 ROADMAP 條目）。

---

## 5. 驗證

1. **token 語法先驗**：只做 §1（裝套件 + `lib/cn.ts`）+ §2（`globals.css`），跑
   `pnpm exec tsc --noEmit`（應乾淨）+ `curl -s http://localhost:3000/ -o /dev/null -w "%{http_code}\n"`
   （打使用者的 dev server；不通就請使用者開，或改 `pnpm build` 靜態驗）。確認頁面仍是深色、
   `@theme inline` 自我參照不報錯。**報錯 → 切 `--app-*` 前綴 fallback 方案。**
2. **逐檔驗**：每改 1–2 檔，`git diff` 目視 + `pnpm exec tsc --noEmit`。
3. **視覺回歸**：全改完 `curl` 三頁（`/`、`/screening`、`/watchlist`）確認 200；請使用者肉眼比對截圖，重點：
   - 側欄 / 卡片 / 邊框灰階層次不變
   - 漲跌色（漲紅跌綠）不變
   - ScreeningPanel「估」（琥珀）/「追」（紅）badge、5 種提示框不變
   - RegimeBanner 三色圓點（綠 / 琥珀 / 紅）不變
   - Dashboard 燈號綠 / 覆蓋率紅黃、WatchlistPerfTable 走勢圖線色不變
4. **grep 收尾**：`grep -rE "(text|bg|border|ring|divide)-(slate|blue|rose|emerald|amber|red|green|yellow|zinc|gray)-[0-9]" app/ components/`
   應回空（`scripts/` 不算；`WatchlistPerfTable.tsx` 的 SVG 常數 HEX 若保留，在允許清單）。
5. `pnpm build` 完整過一次。

---

## 6. 風險

低。全是 class 字串 / 顏色常數替換，無邏輯改動。唯一不確定點 = Tailwind v4 `@theme inline`
同名自我參照語法（步驟 1 先驗證，有 `--app-*` 前綴 fallback）。SVG 走勢圖硬編 HEX 需人工同步
（已在 §2 檔案清單第 8 項標注，抽常數 + 註解）。
