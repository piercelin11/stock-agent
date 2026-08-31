# PLAN：Dashboard 改版 + 全站黑暗模式

把前端從淺色主題整站切成黑暗模式，並重寫 `/` Dashboard：DB 連通性區塊換掉內容、移除 Recharts smoke、新增「觀察類股今日表現」區塊（以「帶量帶價第一根」的角度呈現）。

這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識完成後回寫 `CLAUDE.md`，過程紀錄回寫 `docs/PROGRESS.md`，ROADMAP 對應項目打勾。

前置狀態：

- **前端骨架已完成**：`app/layout.tsx`（側欄導覽 + `<main>`）、`app/globals.css`（`@import "tailwindcss"` + `body` 用 `bg-slate-50 text-slate-900`）、`components/ui/{Card,Button}.tsx`。Tailwind v4（`@tailwindcss/postcss`），目前全站 **零 `dark:` 用法**、`:root { color-scheme: light }`。
- **Dashboard 現況**（`app/page.tsx`）：`getDbHealth()` 回 `{ quoteCount, stockCount, latestQuoteDate }` → 一張「DB 連通性」Card（3 個 `Stat`）+ 一張「Recharts smoke」Card（`components/ChartSmoke.tsx` 寫死資料）。
- **選股純函式可重用**：`scripts/screening/calculate-breakout-strength.ts` 的 `calculateBreakoutStrength(date, { prisma })` 回傳 `{ date, isNonTradingDay, stats, results: BreakoutResult[] }`。`BreakoutResult.scores` 有 7 分項（interface 與落地 JSON 一致）：`candleShape / volumeStrength / breakoutMargin / firstBar / base / proximityToHigh / relativeStrength`。`lib/actions/screening.ts` 的 `runScreening` 已示範「傳前端 Prisma 單例、純函式不 `$disconnect`」的用法。
- **`InstitutionalTrading` 的 `foreignNetBuy / investmentTrustNetBuy / dealerNetBuy` 單位是「股」**（`BigInt`）——`fill-institutional-trading.ts` 直接存 TWSE T86 原始股數，未除 1000。UI 顯示「張」時自己 `Math.round(Number(x) / 1000)`。（`listWatchlist` 現況是原樣 `Number(...)` 不換算，屬既有行為，本批不動。）
- **觀察清單資料**：`lib/actions/watchlist.ts` 的 `listWatchlist()` 回 `WatchlistRow[]`（每檔含 `quote / indicator / institutional` 三表各自最新一筆）。`WatchlistItem` 只有 `stockCode`，透過 `stock` relation 拿 `name`。

---

## 0. 這一批的邊界

**做三件事：**

1. **全站黑暗模式**（不做 light/dark 切換開關，直接整站變深色）。
2. **Dashboard「DB 連通性」區塊重寫**：移除現有三個 `Stat`，換成三個新欄位（行情燈號 / 股票數量 / 三表當日覆蓋率）。
3. **Dashboard 移除 Recharts smoke 區塊**，新增「觀察類股今日表現」區塊。

**明確不在範圍**（留給後續）：

- **light/dark 切換 UI（主題 toggle、記憶偏好）** → 不做。使用者要的是「改成黑暗模式」＝整站固定深色，不是可切換。日後要 toggle 再開 PLAN。
- **`ChartSmoke.tsx` 檔案刪除以外的 Recharts 用途** → 本批只是不在 Dashboard 用它；`recharts` 套件保留（screening 展開明細等日後可能用）。`components/ChartSmoke.tsx` 直接刪。
- **`/screening`、`/watchlist` 頁的版面重排** → 只跟著改配色（換 `slate-*` 淺色類名），不動結構與互動。
- **「觀察類股今日表現」的歷史留存 / 寫 `AnalysisResult`** → 不寫 DB，每次進頁即時算。
- **非交易日 / 資料不齊的完整處理** → 燈號紅色 + 文字提示即可，不阻擋渲染。

---

## 1. 全站黑暗模式

### 1.1 基準色票（Tailwind slate 系）

| 用途 | 淺色（現在） | 深色（改後） |
| --- | --- | --- |
| body 底 | `bg-slate-50` | `bg-slate-950` |
| body 文字 | `text-slate-900` | `text-slate-100` |
| 卡片 / 側欄底 | `bg-white` | `bg-slate-900` |
| 邊框 | `border-slate-200` / `slate-300` | `border-slate-800` / `slate-700` |
| 次級文字 | `text-slate-500` / `slate-400` | `text-slate-400` / `slate-500` |
| hover 底 | `hover:bg-slate-100` | `hover:bg-slate-800` |
| 主按鈕 | `bg-slate-900 text-white` | `bg-slate-100 text-slate-900`（反白）或 `bg-blue-600 text-white` |

台股漲跌色維持慣例（漲紅 `text-rose-500` / 跌綠 `text-emerald-500`），在深色底下把亮度調高一階即可（`rose-400` / `emerald-400`），本批一併順手改。

### 1.2 `app/globals.css`

```css
@import "tailwindcss";

:root {
  color-scheme: dark;
}

body {
  @apply bg-slate-950 text-slate-100 antialiased;
}
```

### 1.3 逐檔改類名（把淺色寫死類名換深色）

- `app/layout.tsx`：`<aside>` 的 `border-slate-200 bg-white` → `border-slate-800 bg-slate-900`；nav `Link` 的 `text-slate-700 hover:bg-slate-100` → `text-slate-300 hover:bg-slate-800`；「STOCK AGENT」標題 `text-slate-500` 可留。
- `components/ui/Card.tsx`：`border-slate-200 bg-white shadow-sm` → `border-slate-800 bg-slate-900`（深色底 `shadow-sm` 幾乎看不到，可留可拿掉）；`Stat` 的 `text-slate-400` label 留、`text-slate-900` value → `text-slate-100`；`Card` title `text-slate-500` 留。
- `components/ui/Button.tsx`：三個 variant 全改（見上表；`primary` 建議 `bg-blue-600 text-white hover:bg-blue-500 disabled:bg-slate-700`，`secondary` `border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700`，`danger` `border-rose-800 bg-slate-900 text-rose-400 hover:bg-rose-950`）。
- `app/page.tsx` / `app/screening/page.tsx` / `app/watchlist/page.tsx`：`text-slate-900` 標題 → `text-slate-100`，`text-slate-500` 說明留。
- `components/screening/ScreeningPanel.tsx` + `components/watchlist/WatchlistTable.tsx`：grep `slate-` / `bg-white` / `text-slate-900` / `border-slate-2` / `hover:bg-slate-100` 全部逐一換深色對應；表格 `divide-slate-200` → `divide-slate-800`、表頭底 `bg-slate-50` → `bg-slate-900` 或 `bg-slate-800/50`；選中列 highlight 用 `bg-blue-950/40`。漲跌色 `rose-500/emerald-500` → `rose-400/emerald-400`。

> 驗收：`grep -rn "bg-white\|slate-50\b\|slate-100\b\|slate-200\b\|text-slate-900" app/ components/` 應只剩「深色底下仍合理」的少數（例如反白按鈕的 `text-slate-900`、`bg-slate-100`）。其餘不得殘留淺色。

---

## 2. Dashboard「DB 連通性」區塊重寫

### 2.1 `lib/actions/health.ts` — 改 `getDbHealth`

新回傳型別：

```ts
export interface DbHealth {
  today: string;                 // 伺服器今日 YYYY-MM-DD（Asia/Taipei）
  latestQuoteDate: string | null;
  quoteFresh: boolean;           // latestQuoteDate === today
  stockCount: number;            // securityType = "stock" 的檔數（分母）
  coverage: {
    quote: { count: number; pct: number };       // 當日 DailyQuote 覆蓋
    institutional: { count: number; pct: number }; // 當日 InstitutionalTrading 覆蓋
    technical: { count: number; pct: number };     // 當日 TechnicalIndicator 覆蓋
  };
}
```

實作要點：

- **`today`**：用 `Asia/Taipei` 當天日期字串（`new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date())` → `YYYY-MM-DD`），不要用伺服器 local time。
- **分母 `stockCount`**：`prisma.stock.count({ where: { securityType: "stock" } })`（跟 `runScreening` 一致，只算一般股票；不是全 `Stock` 表）。
- **`latestQuoteDate`**：`prisma.dailyQuote.findFirst({ where: { stock: { securityType: "stock" } }, orderBy: { date: "desc" }, select: { date: true } })`。
- **`quoteFresh`**：`latestQuoteDate === today`。
- **當日覆蓋率**：以 `latestQuoteDate`（不是 `today`——非交易日 `today` 無資料會全 0，用「資料庫最新那天」才有意義）為基準日 `refDate`，三個 `count`：
  - `dailyQuote.count({ where: { date: refDate, stock: { securityType: "stock" } } })`
  - `institutionalTrading.count({ where: { date: refDate } })`（此表只 upsert 一般股票，不必再過濾）
  - `technicalIndicator.count({ where: { date: refDate } })`（同上）
  - `pct = stockCount > 0 ? Math.round((count / stockCount) * 1000) / 10 : 0`（一位小數）。
- `refDate` 是 `Date`；查詢用 `new Date(latestQuoteDate + "T00:00:00.000Z")`（`DailyQuote.date` 存的是 UTC 午夜，跟現有 `runScreening` `new Date(dateStr)` 對齊）。
- 三表日期可能不同步（`listWatchlist` 註解已提過）——覆蓋率一律以 `refDate` 為準，若某表當天還沒算，覆蓋率就是低的，這是「今天 pipeline 有沒有跑完」的真實訊號，符合需求。

### 2.2 `app/page.tsx` — DB 連通性 Card 內容

三欄（沿用 `flex gap-10` 或改 `grid grid-cols-3`）：

1. **今日行情燈號**：一顆圓點 + 文字。
   - `quoteFresh` → 綠燈（`bg-emerald-500`）+「已更新（{latestQuoteDate}）」。
   - `!quoteFresh` → 紅燈（`bg-rose-500`）+「未更新（DB 最新 {latestQuoteDate ?? "無"}，今日 {today}）」。
   - 圓點：`<span className="inline-block h-2.5 w-2.5 rounded-full ..." />`。
2. **股票數量**：`stockCount.toLocaleString()`（沿用 `Stat`），label「一般股票檔數」。
3. **當日三表覆蓋率**：一個小區塊，三行 `DailyQuote / 籌碼 / 技術指標`，各顯示 `{pct}%`（`{count} / {stockCount}`）。pct < 90 標黃字（`text-amber-400`）、< 50 標紅字，其餘 `text-slate-100`。可做成極簡水平 bar（`bg-slate-800` 底 + `bg-emerald-500` 寬度 `{pct}%`），或純文字。**先純文字 + 顏色，bar 視行有餘力再加。**

Card title 從「DB 連通性」可留或改「資料狀態」。

### 2.3 移除 Recharts smoke

- `app/page.tsx` 刪掉 `<Card title="Recharts smoke...">` 整段與 `import { ChartSmoke }`。
- 刪 `components/ChartSmoke.tsx`。
- **不動** `package.json` 的 `recharts` 依賴。

---

## 3. Dashboard 新區塊：「觀察類股今日表現」

以「帶量帶價第一根」的角度，對**觀察清單裡的每一檔**呈現今日狀態。不是重跑全市場 screening，只針對 watchlist 標的算/取這幾個面向。

### 3.1 資料來源決策

觀察清單通常 < 50 檔。兩條路：

- **(A) 重用 `calculateBreakoutStrength(refDate, { prisma })` 再篩 watchlist 交集**：能拿到定案的 7 分項與 `totalScore`，但純函式內部有 gate（市值 / 量 / trigger volume ratio），**沒觸發突破的觀察股不會出現在 `results` 裡**——而觀察清單多數股當天不會剛好突破，交集會很少。不符「列出每一檔」的需求。
- **(B) 自己組每檔的面向指標**（推薦）：對 watchlist 每檔讀 `refDate` 當天的 `DailyQuote` + `TechnicalIndicator` + `InstitutionalTrading` + 近 20 日 `DailyQuote` 視窗，用 `breakout-shared.ts` 既有的 pure helper 現算需要的分項。不經 gate，每檔都有值。

→ **採 (B)**。新增 `lib/actions/dashboard.ts` 的 `getWatchlistPerformance()`。

### 3.2 呈現的面向（欄位）

需求原文：「今日 k 棒趨勢、動能（突破布林或漲幅等）、籌碼面、力道、盤整多久（位階）」。對應：

| 欄位 | 定義 | 資料 / helper |
| --- | --- | --- |
| **今日 K 棒** | 收紅/收黑 + 實體強弱。用 `computeCandleShape({ open, high, low, close })`（`breakout-shared.ts`，回 `{ score, degraded }`）→ 分數 + 箭頭。 | 當日 `DailyQuote` OHLC |
| **動能** | 兩個子訊號：①漲跌幅 `changePercent`（`quote.change / (close - change) * 100`，或直接存的 `change` 是「漲跌價」要換算成 %）；②是否站上布林上軌 `close >= indicator.bollingerUpper`（布林突破 = true 時標亮）。 | 當日 `DailyQuote` + `TechnicalIndicator.bollingerUpper` |
| **力道（量能）** | `computeVolumeStrength(volumeRatio, curve)`，`volumeRatio = 今日 volume / 近 20 日均量`（近 20 日均量自己從 `DailyQuote` 視窗算）。回 0~100 分。 | 近 21 筆 `DailyQuote.volume` |
| **籌碼面** | 今日三大法人合計淨買賣（`foreignNetBuy + investmentTrustNetBuy + dealerNetBuy`，單位張），正紅負綠；投信單獨標記（accumulation 邏輯裡投信權重最高）。**不做完整 accumulation chipScore**（那要 20 日視窗 + 多 helper，本批從簡），只顯示當日淨額 + 投信當日淨額。 | 當日 `InstitutionalTrading` |
| **位階 / 盤整多久** | `computeBase(historyWindow, curve)`（`breakout-shared.ts`，吃近 N 日 close 序列，回「底部深度 + 打底天數」合成分數，degraded 門檻 40 天）。分數高 = 剛從長打底/深回檔區起來（位階低、後勁足）；分數低 = 已在高位。 | 近 ~240 筆 `DailyQuote.close`（不足 40 筆標 degraded） |

> 註：`computeBase` / `computeVolumeStrength` / `computeCandleShape` 的 curve 參數傳 `DEFAULT_BREAKOUT_CONFIG.score.curves.*`（`resolveBreakoutConfig()` 取得）。`computeFirstBar` 需要「close vs 布林上軌」的歷史序列，本批不納入（要另拉 `bollingerUpper` 歷史），動能欄用「當日是否站上上軌」代替即可。

### 3.3 `lib/actions/dashboard.ts`（新檔）

```ts
"use server";
export interface WatchlistPerfRow {
  stockCode: string;
  name: string;
  refDate: string;              // 該檔實際取到的當日資料日期（quote 的 date）
  close: number;
  changePercent: number;
  // 面向分數（0~100，缺資料為 null）
  candleScore: number | null;
  volumeScore: number | null;
  baseScore: number | null;     // 位階（高=低位階剛起步）
  // 動能
  aboveBollingerUpper: boolean | null;
  // 籌碼（張，可為 null）
  instTotalNet: number | null;
  trustNet: number | null;
  degraded: string[];           // 例 ["base", "candleShape"]
}
export async function getWatchlistPerformance(): Promise<WatchlistPerfRow[]>;
```

實作：

1. `prisma.watchlistItem.findMany({ include: { stock: { select: { name: true } } }, orderBy: { addedAt: "desc" } })`。空清單直接回 `[]`。
2. 對每檔 `Promise.all` / 分批（< 50 檔可全平行，比照 `listWatchlist`）：
   - 最新 `DailyQuote`（`orderBy date desc`，取 `date/open/high/low/close/volume/change`）→ 沒有就整列 skip（回一個 `close: 0` 佔位 or 直接濾掉；**濾掉**較乾淨）。
   - 該 `date` 往前近 21 筆 `DailyQuote`（算 20 日均量）、近 240 筆 `DailyQuote.close`（算 `computeBase`）。可一次 `findMany({ where: { stockCode, date: { lte: refDate } }, orderBy: { date: "desc" }, take: 240 })` 拿齊，再切片。
   - 最新 `TechnicalIndicator`（`bollingerUpper`）。
   - 最新 `InstitutionalTrading`（三欄）。
3. `changePercent`：`prevClose = close - change`；`changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0`。
4. `candleScore = computeCandleShape({ open, high, low, close }).score`；degraded 收集。
5. `volumeRatio = avg20Volume > 0 ? Number(todayVolume) / avg20Volume : 0`；`volumeScore = computeVolumeStrength(volumeRatio, curves.volumeStrength)`。
6. `baseScore`：`closeSeries`（新到舊或舊到新依 helper 要求，查 `computeBase` 簽名）長度 < 40 → `baseScore = null` + `degraded.push("base")`，否則 `computeBase(series, curves.base).score`。
7. `aboveBollingerUpper = bollingerUpper != null ? close >= bollingerUpper : null`。
8. `instTotalNet` / `trustNet`：`InstitutionalTrading` 三欄單位是「股」，換算成「張」＝ `Math.round(Number(x) / 1000)`。`instTotalNet = round((foreign + trust + dealer) / 1000)`、`trustNet = round(trust / 1000)`。缺資料為 `null`。
9. 回傳全部序列化（`Decimal` / `BigInt` 都轉 `number`，`Date` 轉字串）。

**Prisma 用前端單例**（`import { prisma } from "../prisma"`），不 `$disconnect`。

### 3.4 `components/dashboard/WatchlistPerfTable.tsx`（新，client 或 server 皆可）

- 純展示表格即可（**不需互動**，本批不做排序/展開；日後要再說）。做成 Server Component 直接 `await getWatchlistPerformance()` 最簡單，省一個 `"use client"`。
- 欄位順序：`代號 名稱 | 收盤 漲跌% | K棒 | 動能 | 力道 | 籌碼(合計/投信) | 位階`。
- 分數欄（K棒/力道/位階）：顯示數字 + 依高低上色（`>=70` `text-emerald-400`、`40~70` `text-slate-200`、`<40` `text-slate-500`）；`null` 顯示「—」+ 若在 `degraded` 加個灰底 `資料不足` tag。
- 動能欄：漲跌% 台股色（漲 `rose-400` 跌 `emerald-400`）＋ 若 `aboveBollingerUpper` 加一個 `突破` 藍色 pill。
- 籌碼欄：`合計 {instTotalNet>0?"+":""}{instTotalNet} 張`（正紅負綠）＋ 第二行小字 `投信 {trustNet} 張`。
- 空清單：顯示「觀察清單為空，先到 Screening 加入標的」。

### 3.5 `app/page.tsx` 組裝

```tsx
export default async function Page() {
  const health = await getDbHealth();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">Dashboard</h1>
      <Card title="資料狀態">{/* §2.2 三欄 */}</Card>
      <Card title="觀察類股今日表現（帶量帶價第一根視角）">
        <WatchlistPerfTable />
      </Card>
    </div>
  );
}
```

`export const dynamic = "force-dynamic"` 保留（新 action 也查 DB）。

---

## 4. 驗收

1. `pnpm exec tsc --noEmit` 乾淨（`scripts/` + `app/` 共用 tsconfig）。
2. `pnpm build` 通過（需本機 Postgres 開著；`force-dynamic` 已擋 build-time 預渲染，但 action 仍會在 dev/start 連線）。
3. `pnpm dev` 開 `/`：
   - 整頁深色底，無殘留白卡 / 淺灰。側欄、`/screening`、`/watchlist` 一致深色，漲跌紅綠在深色底清楚。
   - 「資料狀態」：燈號正確（今天有跑 pipeline → 綠；沒跑 → 紅 + 日期差提示）；股票數量 = 一般股票檔數；三表覆蓋率百分比合理（pipeline 跑完當天應接近 100%）。
   - 無 Recharts smoke 區塊；`components/ChartSmoke.tsx` 已刪、無 import 殘留。
   - 「觀察類股今日表現」：watchlist 每檔一列，K棒/力道/位階有分數（打底不足 40 天的標「資料不足」），動能顯示漲跌% + 突破 pill，籌碼顯示合計/投信淨額。空清單有提示文案。
4. `/screening` 跑一次 breakout、`/watchlist` 開一次，確認只有配色變、互動與資料照舊。

---

## 5. 檔案清單

**改：**

- `app/globals.css`（§1.2）
- `app/layout.tsx` `app/page.tsx` `app/screening/page.tsx` `app/watchlist/page.tsx`（配色 + Dashboard 重組）
- `components/ui/Card.tsx` `components/ui/Button.tsx`（配色）
- `components/screening/ScreeningPanel.tsx` `components/watchlist/WatchlistTable.tsx`（配色）
- `lib/actions/health.ts`（`getDbHealth` 換回傳，§2.1）

**新增：**

- `lib/actions/dashboard.ts`（`getWatchlistPerformance`，§3.3）
- `components/dashboard/WatchlistPerfTable.tsx`（§3.4）

**刪除：**

- `components/ChartSmoke.tsx`

**不動：** `package.json`（`recharts` 留）、`prisma/schema.prisma`（無 schema 變更）、`scripts/`（純函式只讀不改）。

---

## 6. 收尾

- `docs/PROGRESS.md`：新增一段記錄黑暗模式切換範圍、`getDbHealth` 新欄位定義（燈號判定 = DB 最新日 vs Asia/Taipei 今日；覆蓋率分母 = `securityType="stock"` 檔數、基準日 = DB 最新交易日）、「觀察類股今日表現」用 `breakout-shared.ts` 的 `computeCandleShape/computeVolumeStrength/computeBase` 現算而非重跑 screening 的理由（gate 會濾掉未突破的觀察股）。
- `docs/ROADMAP.md`：對應項目打勾（若 ROADMAP 第 4 節有「Dashboard」子項）。
- `CLAUDE.md`「前端」段：補「全站固定深色（無 toggle）」「`/` Dashboard = 資料狀態卡（行情燈號 / 股票數 / 三表覆蓋率）+ 觀察類股今日表現表」「`lib/actions/dashboard.ts`」。
- `README.md`：若「目前功能」列了 Dashboard 內容，同步更新。
