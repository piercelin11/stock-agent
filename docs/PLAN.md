# PLAN：醞釀中（pre-breakout）卡片的「法人籌碼」區塊

承接已 commit（未 merge）的 watchlist 卡片 gallery 改版。上一版 watchlist 改版時
**刻意不做**醞釀中卡片的法人區塊，使用者定案 UI 後於本計畫補上。

**分支**：`feat/watchlist-card-gallery`（延續，不另開）。merge 時機等使用者發話。

**需求來源**：使用者 2026-09-01 提供的設計圖（4908 前鼎，「法人買賣 / 近20日投信買超日 /
20 格點狀日曆 / 投信 85 ⓘ / 外資 / 自營商 64 ⓘ」）+ 逐元素拆解指令（本檔第 1~3 節即該指令的落地）。

**與突破階段法人卡片的關係**：完全不同的資料結構。突破階段（`components/signal/InstitutionalFlowPanel.tsx`）
用「近 5 日淨買超 ÷ volumeMa20 的 diverging bar + 今日方向箭頭」；醞釀階段的公式
（`computeTrustRawMetrics` + `computeOtherInstitutionRatio`，`accumulation.ts`）是 **20 日窗口、
只看頻率與累積佔比、沒有「今日方向」概念**。不共用 `InstitutionalFlowPanel`，另做新元件。

---

## 0. 邊界

**動：**

- `package.json`：`+ @radix-ui/react-tooltip`（`pnpm add`）。
- `components/ui/Tooltip.tsx`：**新**——`@radix-ui/react-tooltip` 的手刻薄包裝（照
  `Button.tsx` 用專案 token 的模式，**不引入 shadcn**，CLAUDE.md 既有約束）。
- `components/signal/PreBreakoutInstitutional.tsx`：**新**——醞釀階段法人籌碼區塊
  （標題 + 20 格日曆 + 兩條百分位進度條 + ⓘ tooltip）。
- `components/signal/labels.ts`：`FACTOR_LABELS` 補「外資 / 自營商」等本區塊用到的中文名。
- `components/signal/pre-breakout-chip.ts`：**新**——`resolvePreBreakoutChip()`（頂部籌碼 badge
  判斷表，第 3 節）。與突破階段的 `resolveInstChip`（在 `InstitutionalFlowPanel.tsx`）並存、依 stage 分流。
- `lib/actions/watchlist.ts`：
  - `WatchlistCardRow` 加 `preInst: PreBreakoutInst | null`（breakout 階段為 null）。
  - `buildCardRow` 的 pre-breakout 分支：撈 20 日投信淨買超序列 + `Stock.sharesOutstanding`，
    讀最近 eod 掃描結果的 `scores.trustScore` / `scores.otherInstScore` / `detail.*`，組 `preInst`。
- `components/watchlist/WatchlistCard.tsx`：pre-breakout 分支渲染 `<PreBreakoutInstitutional>`
  + 頂部 chip 改用 `resolvePreBreakoutChip`（stage 分流）。

**不動：**

- `scripts/screening/run-signal-scan.ts`：**完全不改**。醞釀階段的 `scores` / `detail` 已含所需欄位
  （`trustScore` / `otherInstScore` / `trustBuyFreq` / `trustConsecutiveDays` / `trustNetRatio` /
  `otherInstRatio`），本計畫只讀不寫。
- `scripts/lib/signal-factors/*`：不改。日曆的逐日買超布林陣列 scan 沒存 → action 自己撈 20 日
  `investmentTrustNetBuy` 序列現算。
- `components/signal/InstitutionalFlowPanel.tsx` / `FactorList.tsx` / 突破階段任何東西：不動。
- `prisma/schema.prisma`：不動。

---

## 1. 區塊結構（由上到下）

```
[階段badge] [籌碼badge]              ← 卡片頂部（既有），籌碼 badge 改由 resolvePreBreakoutChip 決定（第 3 節）
...(K 線圖，既有，不動)...
法人買賣                             ← 區塊標題（text-xs font-semibold text-muted-foreground/70，同 InstitutionalFlowPanel 標題樣式）
近20日投信買超日                      ← 次標題（text-xs text-muted-foreground/50）
[▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢]            ← 20 格日曆，2 列 × 10 欄
[▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢]
投信            ▓▓▓▓▓▓▓▓░░  85  ⓘ   ← 投信分數列
外資 / 自營商   ▓▓▓▓▓░░░░░  64  ⓘ   ← 外資自營分數列
```

若該檔不在最近 eod 掃描結果裡（見 §2.4）→ 只渲染標題 + 日曆 + 縮減版 tooltip，
兩條進度條與分數不顯示（見 §2.5 退化規則）。

---

## 2. 每個元素的資料來源與顯示規則

### 2.1 20 格點狀日曆「近20日投信買超日」

- 2 列 × 10 欄 = 20 格，對應 `institutionalWindowDays = 20`。
- **排列**：左上 → 右下 = 舊 → 新。第一列第一格 = 最舊；最後一列最後一格 = 最新交易日。
  （action 撈的序列是「新到舊」，渲染時 `reverse()`。）
- **每格布林值**：該日 `investmentTrustNetBuy > 0`。**只問「有沒有買」**——不看買多少、不區分
  「賣超」與「無資料」（對齊 `buyFrequency = 買超天數 ÷ 有資料天數`，公式不分這兩種狀態）。
- **配色**：買超日 = `bg-success`（實色綠，與進度條同色系，暗示「進度條是日曆的量化版」）；
  非買超日 = `bg-muted`（深灰底格）。**不用紅色**（「非買超」≠「賣超警訊」，公式無此語意）。
- **尺寸**：正方形 `size-6`（24px）左右，`gap-1`，`grid grid-cols-10 gap-1`；卡片窄時整塊
  `w-full` 內縮。實際尺寸依卡片寬微調，不強求 28px。
- **不加常駐文字數字**（「買超12天」之類）——數格子即可看出「頻率」與「連續性」。
  買超天數 / 連續天數收進投信列的 ⓘ tooltip。
- 有效資料不足 20 天：序列短於 20 → 前面（舊端）補「無資料」灰格（與非買超同 `bg-muted`，
  但可略降透明度 `bg-muted/50` 區分，非必要）。序列長度 `< 10`（`ceil(20 × 0.5)`）→ 走 §2.5 退化 +
  badge「籌碼資料不足」。

### 2.2 投信分數列

- **進度條寬度 = 掃描結果的 `scores.trustScore`（0~100）**。這是 run-signal-scan 跑全市場
  pre-breakout 候選時算好的：`rankScore(buyFrequency, 全市場) × trustSubWeights.buyFrequency(0.5) +
  rankScore(netRatio, 全市場) × trustSubWeights.netRatio(0.5)`。**watchlist 自己算不出**（只有幾檔，
  rankScore 無意義）→ 只能讀掃描結果。
- 條色：`bg-success`（綠，同日曆買超格）。
- 條後數字：`Math.round(trustScore)`，無 `%` 符號。
- **ⓘ tooltip**（`@radix-ui/react-tooltip`，多行純文字）：
  ```
  近20日買超 {buyDays} 天，最近連續 {consecutiveBuyDays} 天
  買超金額佔已發行股數 {(trustNetRatio*100).toFixed(1)}%      ← trustNetRatio 為 null 時省略此行
  優於全市場 {Math.round(trustScore)}% 的個股
  ```
  - `buyDays` = action 自算（20 日序列中 `> 0` 的天數）或 `Math.round(detail.trustBuyFreq * dataDays)`。
  - `consecutiveBuyDays` = `detail.trustConsecutiveDays`（或 action 自算，兩者應一致）。
  - `trustNetRatio` = `detail.trustNetRatio`（scan 已算，含 `÷ sharesOutstanding`）。
    scan 結果沒有該檔時 action 用 20 日序列 + `Stock.sharesOutstanding` 現算；`sharesOutstanding`
    為 null（KY 股等）→ 此行省略。
  - 「優於全市場 X%」的 X = `trustScore`（rankScore 百分位語意；退化時無此行）。
- **不常駐顯示原始買超張數/金額**——投信資金規模天生 < 外資，秀絕對數字誤導「在跟外資比大小」。
  金額只在 tooltip 且搭「佔已發行股數」相對表達。

### 2.3 外資 / 自營商分數列

- **進度條寬度 = 掃描結果的 `scores.otherInstScore`（0~100）** =
  `rankScore(otherInstRatio, 全市場)`，`otherInstRatio = 近20日(外資+自營)淨買超加總 ÷ 近20日成交量加總`。
- 條色：`bg-warning`（橘/琥珀，**刻意與投信綠區分**——次要修飾訊號，非本階段主訊號）。
- 條後數字：`Math.round(otherInstScore)`。
- **ⓘ tooltip**（一行）：
  ```
  外資＋自營商20日合計淨買超，佔同期成交量 {(otherInstRatio*100).toFixed(1)}%
  ```
  `otherInstRatio` = `detail.otherInstRatio`。
- **不做 20 格日曆**——公式只有 20 天彙總比例、無逐日拆解；畫日曆會暗示系統在乎外資連續性
  （實際不吃）。

### 2.4 資料來源優先序（§2.2 / §2.3 的分數與 detail）

`buildCardRow` 的 pre-breakout 分支：

1. **讀 `data/signal-scan-results/` 最新 `{YYYY-MM-DD}.json`（eod 定案）**——沿用 §上一版
   `readLatestScanRs()` 的讀檔套路，但這次要 `scores.trustScore` / `scores.otherInstScore` +
   `detail.{trustBuyFreq,trustConsecutiveDays,trustNetRatio,otherInstRatio}`。把
   `readLatestScanRs()` 擴成回傳更完整的 map（或新增一個 `readLatestScanPreInst()`）。
2. **20 格日曆的逐日布林陣列**：scan 沒存 → action `prisma.institutionalTrading.findMany({
   where: { stockCode }, orderBy: { date: "desc" }, take: 20, select: { date, investmentTrustNetBuy } })`
   現算（新到舊，渲染時 reverse）。
3. **`sharesOutstanding`**：`WatchlistItem.stock` 的 `include` 加 `sharesOutstanding`（現只 select
   `name, market`）。僅在 scan 結果無 `detail.trustNetRatio` 時用來現算，否則不需要。

### 2.5 退化規則（該檔不在最近 eod 掃描結果）

觀察股大多從 screening 加入 → 通常在名單裡；手動加的冷門股 / 沒跑掃描 / 當天沒過 gate
（市值<30億 / 當日量<100萬股 / 均量<50萬股）→ 不在。

- 有 20 日投信序列（`>= 10` 天）→ 渲染標題 + 日曆 + 投信列**只顯示 tooltip 前兩行**
  （買超天數 / 連續天數，action 自算），**無進度條、無分數數字、無「優於全市場」行**。
  外資/自營列整列不顯示（無 `otherInstRatio` 可算，且它本非主訊號）。
- 序列 `< 10` 天 → 整個區塊只顯示標題 + 「近 20 日投信資料不足」一行 muted 文字，badge 走
  「籌碼資料不足」。

### 2.6 刻意不呈現（避免實作者加回去）

- 不加「今日買賣方向」箭頭 ▲/▼（此階段公式不看單日）。
- 不把「技術就緒係數」/「籌碼分 × 技術就緒 = 總分」放進本區塊（技術就緒屬位階/技術面家族，
  另區塊）。
- 進度條旁不常駐原始比例文字，一律收進 ⓘ tooltip。

---

## 3. 頂部籌碼 badge（`resolvePreBreakoutChip`）

`components/signal/pre-breakout-chip.ts` 新增 `resolvePreBreakoutChip(preInst)`，
回 `{ text: string; tone: Tone }`（`Tone` / `TONE_CHIP` 從 `InstitutionalFlowPanel.tsx` 複用其 export）。

`WatchlistCard.tsx` 頂部 chip：`row.stage === "pre-breakout"` → `resolvePreBreakoutChip(row.preInst)`；
否則沿用既有 `resolveInstChip(row.inst)`。

**判斷表**（`trustScore` = `preInst.trustScore`，`otherScore` = `preInst.otherInstScore`，
`consecutive` = `preInst.consecutiveBuyDays`；門檻首版拍板、註解標「待校準」）：

| # | 條件 | 標籤文字 | tone |
|---|---|---|---|
| 1 | 資料不足（20 日序列 < 10 天 / `preInst` degraded） | 籌碼資料不足 | `muted` |
| 2 | 不在掃描結果（`trustScore` == null）但序列足 | 依日曆型態：`consecutive >= 5` → 「投信近期連續買」；否則 「投信買盤分散」 | `success` / `muted` |
| 3 | `trustScore >= 70` 且 `consecutive >= 5` | 投信持續進場 | `success` |
| 4 | `trustScore >= 70` 且 `consecutive < 5` | 投信分散布局 | `success`（淺，用 `success` tone） |
| 5 | `trustScore` 40~69 且 `otherScore >= 70` | 法人合力偏多 | `success` |
| 6 | `trustScore` 40~69 且 `otherScore < 70` | 投信小幅偏多 | `warning` |
| 7 | `trustScore < 40` 且 `otherScore >= 70` | 外資自營偏多・投信未跟 | `warning` |
| 8 | `trustScore < 40` 且 `otherScore < 40` | 籌碼尚無明顯佈局 | `muted` |
| 9 | 其他（落在上表縫隙，如 trustScore<40 且 otherScore 40~69） | 籌碼中性 | `muted` |

判斷優先序：# 由上到下，先命中先回。「連續」門檻 `>= 5` 綁 `consecutiveBuyDays`，待校準。

---

## 4. `WatchlistCardRow` 型別擴充

```ts
export interface PreBreakoutInst {
  // 20 格日曆：舊 → 新，長度可能 < 20（前面補「無資料」）。true = 該日投信淨買超 > 0
  buyDayFlags: boolean[];
  buyDays: number;            // buyDayFlags 中 true 的數量
  consecutiveBuyDays: number; // 從最新往回連續買超天數
  dataDays: number;           // 20 日窗內實際有 InstitutionalTrading 的天數
  // 掃描結果帶入（不在名單 → null）
  trustScore: number | null;      // scores.trustScore（rankScore 加權合成）
  otherInstScore: number | null;  // scores.otherInstScore（rankScore(otherInstRatio)）
  trustNetRatio: number | null;   // detail.trustNetRatio 或 action 現算（sharesOutstanding null → null）
  otherInstRatio: number | null;  // detail.otherInstRatio
  degraded: boolean;              // dataDays < 10
}

// WatchlistCardRow 追加：
preInst: PreBreakoutInst | null; // 只在 stage === "pre-breakout" 有值；breakout 階段 null
```

**邊界轉換**：`investmentTrustNetBuy` 是 `BigInt` → `Number()`；掃描結果 JSON 讀進來已是 number。

---

## 5. `components/ui/Tooltip.tsx`（手刻 radix 包裝）

照 `Button.tsx` 模式：`import * as TooltipPrimitive from "@radix-ui/react-tooltip"`，
export 一個 `<Tooltip content={...}>{trigger}</Tooltip>` 便利元件（內含 `Provider` /
`Root` / `Trigger asChild` / `Portal` / `Content`）。Content 用專案 token：
`rounded-md border border-border bg-card px-3 py-2 text-xs text-card-foreground shadow-md`，
`side="top"` `sideOffset={6}`，帶 `<TooltipPrimitive.Arrow className="fill-card" />`。
多行內容以 `whitespace-pre-line` 或傳 `ReactNode`（幾個 `<div>`）。手機：radix tooltip
預設 tap 觸發（`disableHoverableContent` 不設）；卡片在 grid 邊緣的碰撞由 radix `Portal` +
自動 `side` 翻轉處理。`delayDuration={200}`。

單一 `TooltipPrimitive.Provider` 放這個便利元件內即可（每個 tooltip 各自帶 Provider 也行，
radix 允許巢狀）。若之後多處要用再考慮提到 layout。YAGNI：先就地。

---

## 6. 收尾

- `pnpm add @radix-ui/react-tooltip` → `pnpm exec tsc --noEmit` 乾淨。
- `pnpm tsx --test scripts/lib/signal-factors/factors.test.ts`（不受影響，應仍 38 案全過）。
- `curl http://localhost:3000/watchlist`（打使用者 dev server）：
  - 有 pre-breakout 觀察股且在掃描結果 → 日曆 + 兩條進度條 + badge 正確。
  - pre-breakout 但不在掃描結果 → 退化顯示（日曆 + 縮減 tooltip）。
  - 醞釀中 tab 為空 → 不受影響（既有空狀態）。
  - 若當前無 pre-breakout 觀察股：臨時把某檔的 stage 判定 log 出來確認，或手動加一檔已知
    醞釀中的股票驗一次。
- `git rm` 無（本計畫不刪檔）。
- 更新 `docs/PROGRESS.md`（新增「醞釀中卡片法人籌碼區塊」段，記設計理由 + 退化行為 + 實測）。
- 更新 `CLAUDE.md` 的 `/watchlist` 頁描述（補「醞釀中卡片法人區塊 = 20 格日曆 + 兩條全市場
  百分位進度條，資料讀最近 eod 掃描結果」）。
- 更新 `README.md` 觀察清單頁描述（醞釀中卡片內容補上）。
- `docs/ROADMAP.md`：本項不在 ROADMAP 清單上（watchlist UI 細修），無打勾動作。
