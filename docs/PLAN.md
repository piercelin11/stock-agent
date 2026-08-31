# PLAN：大盤濾網（市場狀態燈號）

ROADMAP 4.5.1。做一個**獨立於「三層選股漏斗」之外**的市場狀態模組：輸出 `bullish` / `neutral` / `bearish` 三段標籤，顯示在首頁 banner + `/screening` 頁頂，供人工在「要不要進場」「部位大小」上判斷。**不參與個股評分、不做硬性 gate、不排除任何股票**——空頭時照跑選股、資料照存，只是醒目警示 + 建議降低單筆風險預算。

這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識完成後回寫 `CLAUDE.md`，過程紀錄回寫 `docs/PROGRESS.md`，ROADMAP 4.5.1 對應項目打勾。

---

## 0. 這一批的邊界

**做的事：**

1. **TAIEX 日線落地**：`SecurityType` enum 加 `index` 值 → 建 `Stock`（`code="TAIEX"`）→ 寫一支 backfill 腳本抓 FinMind `TaiwanStockPrice` 的 `TAIEX` 進 `DailyQuote` → 讓 `calculate-technical-indicators.ts` 能算 TAIEX 的 MA60 / 帶寬。
2. **市場狀態純函式** `scripts/lib/market-regime.ts`：三維度合成三段式。
3. **pipeline 步驟** `scripts/pipeline/calculate-market-regime.ts`：每日算一次，寫 `data/market-regime/{date}.json`（不落地 DB）。接進 `daily-pipeline.ts`。
4. **Server Action** `lib/actions/market-regime.ts`：讀最新的 regime JSON，回可序列化物件。
5. **前端**：首頁 banner（regime 燈號 + 三段對應部位建議文字）＋ `/screening` 頁頂燈號。

**分兩階段實作（同一份 PLAN，不同 commit）：**

- **Step 1**：只做「市場寬度」單維度（零新資料，`DailyQuote` + `TechnicalIndicator` 現成），先讓三段燈號上線。含第 2/3/4/5 項的骨架，`market-regime.ts` 先只算 breadth 維度。
- **Step 2**：TAIEX 落地（第 1 項）後，補「指數位置 + 均線斜率」兩維度，`market-regime.ts` 變成三票合成。

**明確不在範圍（留給後續）：**

- **regime 落地 DB / 寫 `AnalysisResult`** → 不做。理由：整個市場每天一個標籤、資訊量小、盤中會多次取（允許一天多筆）、不做回測不需要歷史查詢 → 建表不划算。走 JSON 檔（比照 `data/*-results/`、`data/intraday-breakout-snapshots/`）。
- **盤中即時 regime** → 不做。這批 regime 只從資料庫算（盤後 `daily-pipeline` 每日一次），盤中看到的是上一個交易日收盤定案值。盤中要看即時大盤狀態，等 ROADMAP 4.5.3 路線 A 把「即時報價抓取」基礎設施建好後再評估要不要接（現在單為 regime 自己搭一套即時抓取不划算）。`data/market-regime/{date}.json` 用「一天一檔」命名，未來要加盤中版塞 `data/market-regime/intraday/{timestamp}.json` 即可，兩者不打架。
- **regime 影響選股結果 / 部位計算自動化** → 不做。只做「顯示 + 文字建議」，人工判斷。
- **三段門檻的校準** → 先用本 PLAN 寫死的值，日後肉眼對照盤感再調（`market-regime.ts` 的門檻集中成一個 `const` 物件，方便改）。
- **006208 或其他指數** → 只做 TAIEX。

---

## 1. TAIEX 日線落地（Step 2 前置）

### 1.1 schema：`SecurityType` 加 `index`

```prisma
enum SecurityType {
  stock
  etf
  preferred
  warrant
  bond
  index   // 大盤指數（目前只有 TAIEX），僅供大盤濾網算 MA60/斜率，不進選股
  other
}
```

Migration 只有 `ALTER TYPE "SecurityType" ADD VALUE 'index'`，**不動任何現有 row**。`pnpm prisma migrate dev --name add_index_security_type` → `pnpm prisma generate`。

> **Prisma 7 note**：`ADD VALUE` 在部分 Postgres 版本不能在 transaction 內跑。若 `migrate dev` 報 `ALTER TYPE ... ADD VALUE cannot run inside a transaction block`，把生成的 migration.sql 的 `BEGIN/COMMIT` 拿掉（或分成獨立 migration）。實作時遇到再處理。

### 1.2 建 `Stock` 記錄

`TAIEX` 不在 seed 的股票清單裡（seed 來源是 `TaiwanStockInfo`，指數不在內）。用一次性 upsert 建：

```ts
await prisma.stock.upsert({
  where: { code: "TAIEX" },
  update: {},
  create: {
    code: "TAIEX",
    name: "發行量加權股價指數",
    market: "TWSE",
    securityType: "index",
    sectorId: null,
  },
});
```

放在 backfill 腳本開頭（比照 `backfill-benchmark-quotes.ts` 檢查 `Stock` 是否存在的邏輯，改成 upsert 自建）。

### 1.3 backfill 腳本 `scripts/backfill/backfill-index-quotes.ts`

**照抄 `backfill-benchmark-quotes.ts` 的結構**（FinMind `TaiwanStockPrice`、`REQUEST_DELAY_MS`、`BACKFILL_START_DATE` 覆蓋、upsert `DailyQuote`），差異：

- `data_id` = `"TAIEX"`（FinMind 的加權指數代號，實作時先用一支測試腳本確認 `TaiwanStockPrice?data_id=TAIEX` 有回資料；若沒有，改用 `dataset=TaiwanStockTotalReturnIndex` 或 `TaiwanVariousIndicators5Seconds` 的日彙總——**開工第一步先驗這個**）。
- 開頭 upsert `Stock`（1.2）。
- `securityType` 已是 `index`，寫 `DailyQuote` 時 `source: "TWSE"`。
- `volume`：指數沒有成交股數概念，FinMind 回的 `Trading_Volume` 是全市場成交量，照存即可（不會被選股用到，`calculate-technical-indicators.ts` 算 `volumeMa20` 對 TAIEX 沒意義但無害）。
- 註解註明：**TAIEX 這筆 `DailyQuote` 只給大盤濾網算 MA60/帶寬用，不是個股、不進任何選股候選池**。

指令：`pnpm tsx scripts/backfill/backfill-index-quotes.ts`（`BACKFILL_START_DATE=YYYY-MM-DD` 覆蓋，預設 `2020-01-01`）。

### 1.4 讓 `calculate-technical-indicators.ts` 算 TAIEX

現況：`calculateTechnicalIndicators(codes?)` 的 `findMany` 篩 `securityType: "stock"`，`TAIEX`（`securityType: "index"`）**不會被選到**。

改法（最小改動）：`where` 從 `{ securityType: "stock", ...codes }` 改成 `{ OR: [{ securityType: "stock" }, { code: "TAIEX" }], ...codes }`。

- 傳 `codes` 時（單股補算）維持原行為（`code: { in: codes }` 疊上去，`TAIEX` 只有在 `codes` 含 `"TAIEX"` 時才算）。
- 不傳時全市場一般股票 + TAIEX。
- TAIEX 的 MACD/RSI/ATR 等分項算出來無妨，大盤濾網只讀 `ma60` 和 `bollingerBandwidth`（斜率用 `ma60` 序列現算，不另存欄位）。

log 的「共 N 支一般股票待計算」文案順手改成「共 N 支（含 TAIEX）」。

### 1.5 首次回補 + 驗證

1. `pnpm tsx scripts/backfill/backfill-index-quotes.ts` → TAIEX `DailyQuote` 補到 2020-01-02 ~ 今（約 1600+ 筆）。
2. `pnpm tsx scripts/pipeline/calculate-technical-indicators.ts TAIEX` → 單獨補 TAIEX 的 `TechnicalIndicator`。
3. 查 DB 抽驗：`TAIEX` 最新一筆 `TechnicalIndicator.ma60` 不為 null、`bollingerBandwidth` 不為 null，`ma60` 數量級對得上大盤點數（萬點級）。

---

## 2. 市場狀態純函式 `scripts/lib/market-regime.ts`

**純函式，無 CLI。** 可 import `PrismaClient` 型別 + 查 DB helper（比照 `breakout-shared.ts` 的定位——純函式庫但允許查 DB）。

### 2.1 對外介面

```ts
import type { PrismaClient } from "../../generated/prisma/client";

export type RegimeLabel = "bullish" | "neutral" | "bearish";

export interface DimensionScore {
  score: -1 | 0 | 1;
  degraded: boolean;   // 資料不足 → score 記 0 且 degraded
  detail: Record<string, number | null>;  // 該維度的原始數值（顯示/除錯用）
}

export interface MarketRegimeResult {
  date: string;              // YYYY-MM-DD（DB 最新交易日）
  label: RegimeLabel;
  totalScore: number;        // -3 ~ +3（Step 1 只有 breadth 時 -1 ~ +1）
  dimensions: {
    indexPosition: DimensionScore | null;   // Step 1 為 null
    ma60Slope: DimensionScore | null;       // Step 1 為 null
    breadth: DimensionScore;
  };
  stage: "step1-breadth-only" | "step2-full";
}

export interface CalculateRegimeOptions {
  prisma: PrismaClient;      // 一律外部傳（pipeline 傳自建的、action 傳單例）
  config?: Partial<RegimeConfig>;
}

export async function calculateMarketRegime(
  date: Date,
  options: CalculateRegimeOptions,
): Promise<MarketRegimeResult>;
```

### 2.2 門檻常數（集中，方便日後校準）

```ts
export interface RegimeConfig {
  indexPosBufferDays: number;   // 指數位置維度的「連續 N 交易日」緩衝
  ma60SlopeLookbackDays: number; // MA60 斜率回看天數
  ma60SlopeUpThreshold: number;  // MA60 (今 - N日前) / N日前 > 此值 → +1（如 0.005 = 0.5%）
  ma60SlopeDownThreshold: number; // < -此值 → -1
  breadthBullPct: number;   // 站上 MA60 佔比 > 此值 → +1（如 55）
  breadthBearPct: number;   // < 此值 → -1（如 45）
  bullishTotalScore: number; // totalScore >= 此值 → bullish（三維時 2）
  bearishTotalScore: number; // <= 此值 → bearish（三維時 -2）
}

export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  indexPosBufferDays: 3,
  ma60SlopeLookbackDays: 5,
  ma60SlopeUpThreshold: 0.005,
  ma60SlopeDownThreshold: 0.005,
  breadthBullPct: 55,
  breadthBearPct: 45,
  bullishTotalScore: 2,
  bearishTotalScore: -2,
};
```

**Step 1（只有 breadth）的三段判定**：`breadth.score === 1` → `bullish`；`=== -1` → `bearish`；`=== 0` → `neutral`。（不套 `bullishTotalScore`，因為只有一維、範圍 -1~+1。）

**Step 2（三維）**：`totalScore >= bullishTotalScore` → `bullish`；`<= bearishTotalScore` → `bearish`；其餘 `neutral`。

### 2.3 維度 A：市場寬度 breadth（Step 1 就做）

**定義**：DB 最新交易日，全市場 `securityType="stock"` 且當日有 `DailyQuote` 的股票中，`收盤 > 該股當日 TechnicalIndicator.ma60` 的佔比（%）。

實作：

```ts
// 1. 該日全市場一般股票的 close（排除 TAIEX 本身）
const quotes = await prisma.dailyQuote.findMany({
  where: { date, stock: { securityType: "stock" } },
  select: { stockCode: true, close: true },
});
// 2. 同日 TechnicalIndicator.ma60
const indicators = await prisma.technicalIndicator.findMany({
  where: { date, stockCode: { in: quotes.map(q => q.stockCode) } },
  select: { stockCode: true, ma60: true },
});
// 3. 逐檔比對：ma60 非 null 才計入分母
```

- 分母 = `ma60` 非 null 的檔數；分子 = `close > ma60` 的檔數。
- `pct = 分子 / 分母 * 100`。
- `pct > breadthBullPct` → `score = 1`；`< breadthBearPct` → `score = -1`；之間 → `0`。
- **degraded**：分母 < 500（正常應 1000+）→ `score = 0`, `degraded = true`（資料不齊，不表態）。
- `detail`: `{ aboveMa60: 分子, total: 分母, pct }`。

### 2.4 維度 B：指數位置 indexPosition（Step 2）

TAIEX 收盤 vs 自己的 MA60，加「連續 N 交易日」緩衝：

```ts
// TAIEX 近 (indexPosBufferDays) 筆 close + 同日 ma60，新到舊
const rows = await fetchTaiexCloseVsMa60(prisma, date, config.indexPosBufferDays);
// rows: { date, close, ma60 }[]，長度可能 < N（早期資料不足）
```

- 全部 N 筆都 `close > ma60` → `score = 1`。
- 全部 N 筆都 `close < ma60` → `score = -1`。
- 混合（有的在上有的在下）→ `score = 0`（緩衝過濾 whipsaw：站上/跌破要「站穩」N 天才表態）。
- **degraded**：`rows.length < N` 或任一筆 `ma60` 為 null → `score = 0`, `degraded = true`。
- `detail`: `{ latestClose, latestMa60, daysAbove, daysBelow }`。

### 2.5 維度 C：MA60 斜率 ma60Slope（Step 2）

TAIEX 的 MA60 近 `ma60SlopeLookbackDays` 交易日是否上彎（只看價格穿越會被假跌破騙，斜率確認趨勢方向）：

```ts
// TAIEX 近 (ma60SlopeLookbackDays + 1) 筆 ma60，新到舊
const ma60Series = await fetchTaiexMa60Series(prisma, date, config.ma60SlopeLookbackDays + 1);
const latest = ma60Series[0];
const past = ma60Series[ma60SlopeLookbackDays]; // N 日前
const slope = (latest - past) / past;
```

- `slope > ma60SlopeUpThreshold` → `score = 1`。
- `slope < -ma60SlopeDownThreshold` → `score = -1`。
- 之間 → `0`（走平）。
- **degraded**：序列長度不足、或 `past` <= 0、或任一 `ma60` 為 null → `score = 0`, `degraded = true`。
- `detail`: `{ latestMa60, pastMa60, slopePct: slope * 100 }`。

### 2.6 合成

```ts
const dims = stage === "step2-full"
  ? [indexPosition, ma60Slope, breadth]
  : [breadth];
const totalScore = dims.reduce((s, d) => s + d.score, 0);
// label 判定見 2.2
```

`stage` 由「TAIEX 的 `TechnicalIndicator` 是否有該日資料」自動決定：有 → `step2-full`；沒有 → `step1-breadth-only`（優雅降級，TAIEX 資料還沒補時 pipeline 也不會炸）。

### 2.7 查 DB helper（放同檔）

- `fetchBreadthInputs(prisma, date)` → `{ aboveMa60, total, pct }`（2.3）
- `fetchTaiexCloseVsMa60(prisma, date, n)` → `{ date, close, ma60 }[]`（新到舊，`DailyQuote` join `TechnicalIndicator`，`stockCode="TAIEX"`, `date <= date`, `take: n`）
- `fetchTaiexMa60Series(prisma, date, n)` → `(number|null)[]`（新到舊）
- `hasTaiexIndicatorForDate(prisma, date)` → `boolean`（決定 `stage`）

---

## 3. pipeline 步驟 `scripts/pipeline/calculate-market-regime.ts`

**薄殼**：建 `prisma` → 找 DB 最新交易日 → `calculateMarketRegime(latestDate, { prisma })` → 原子寫 `data/market-regime/{date}.json` → log。

```ts
export async function calculateOneDayRegime(date: Date, prisma: PrismaClient): Promise<MarketRegimeResult> {
  const result = await calculateMarketRegime(date, { prisma });
  const outputDir = join(__dirname, "..", "..", "data", "market-regime");
  mkdirSync(outputDir, { recursive: true });
  // 原子寫：先寫 .tmp 再 renameSync（比照 intraday progress.json）
  const tmpPath = join(outputDir, `${result.date}.json.tmp`);
  const finalPath = join(outputDir, `${result.date}.json`);
  writeFileSync(tmpPath, JSON.stringify({ ...result, generatedAt: new Date().toISOString() }, null, 2));
  renameSync(tmpPath, finalPath);
  return result;
}
```

CLI（`isMain` guard）：無參數跑「DB 最新交易日」；`--date=YYYY-MM-DD` 補算指定日（backfill regime 用，可選）。

**`.gitignore`**：加 `/data/market-regime/`（執行產物，比照 `/data/backtest-runs/` 等）。

### 3.1 接進 `daily-pipeline.ts`

在**第 4 步（技術指標）之後**新增第 5 步，原第 5 步（產業熱度）順延為第 6 步：

```ts
import { calculateOneDayRegime } from "./calculate-market-regime.js";
// ...
// 5. 計算大盤濾網（市場狀態燈號）
try {
  const latestQuote = await prisma.dailyQuote.findFirst({
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (latestQuote) {
    const regime = await calculateOneDayRegime(latestQuote.date, prisma);
    console.log(`大盤濾網：${regime.label}（totalScore ${regime.totalScore}, stage ${regime.stage}）`);
  }
} catch (err) {
  // 非關鍵路徑：印警告，不 throw、不讓 pipeline 非 0 結束
  console.warn(`[大盤濾網] 計算失敗（不中斷 pipeline）: ${err instanceof Error ? err.message : String(err)}`);
  warningCount++;
}
```

**注意**：這步依賴第 4 步已把 TAIEX 的 `TechnicalIndicator` 更新（1.4 改完後，`calculateTechnicalIndicators()` 全市場跑會一起更新 TAIEX）。順序不能對調。

`daily_pipeline.plist`（尚未部署）不受影響。

---

## 4. Server Action `lib/actions/market-regime.ts`

```ts
"use server";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RegimeLabel } from "../../scripts/lib/market-regime";

export interface MarketRegimeView {
  available: boolean;
  date: string | null;
  label: RegimeLabel | null;
  totalScore: number | null;
  stage: string | null;
  dimensions: /* 逐維 { score, degraded, detail } | null */;
  advice: string;   // 三段對應的部位建議文字（見 4.1）
  generatedAt: string | null;
}

export async function getMarketRegime(): Promise<MarketRegimeView>;
```

實作：
- 讀 `data/market-regime/` 目錄，取檔名最大（日期最新）的 `{date}.json`（排除 `.tmp`）。
- 沒有任何檔 → `{ available: false, ..., advice: "尚無大盤濾網資料" }`。
- 有 → parse，組 `advice`（4.1），全部欄位是 plain object（`MarketRegimeResult` 本來就可序列化，無 `Date`/`Decimal`/`BigInt`）。
- **只 `import type`**，不 import `market-regime.ts` 本體（避免把 `PrismaClient` 型別以外的東西、或未來的 `dotenv` 拉進 bundler；比照 `intraday.ts` 只 `import type { CandidateResult }` 的做法）。
- 檔頭 `"use server"`，**不** import `lib/prisma.ts`（這支純讀檔，不碰 DB）。

### 4.1 三段部位建議文字

| label | advice |
| --- | --- |
| `bullish` | 「大盤偏多，正常執行選股與部位計畫。」 |
| `neutral` | 「大盤中性，建議降低單筆風險預算（例如從 1.5% 調到 1%），選股照跑。」 |
| `bearish` | 「大盤偏空，訊號照看但單筆風險預算建議壓到 0.5–1%；資料持續累積，之後可回頭驗證空頭進場績效。」 |
| 不可用 | 「尚無大盤濾網資料（TAIEX 或技術指標未更新）。」 |

（`degraded` 維度多時，`advice` 後面附「（部分維度資料不足，判斷僅供參考）」。）

---

## 5. 前端

### 5.1 首頁 banner（`app/page.tsx`）

在 `<h1>Dashboard</h1>` 之下、「資料狀態」Card 之上，插一條 regime banner：

```tsx
const regime = await getMarketRegime();
// ...
<RegimeBanner regime={regime} />
```

`components/dashboard/RegimeBanner.tsx`（Server Component，純顯示，無互動）：

- 一條橫幅 Card，左側大圓點（`bullish` 綠 `bg-emerald-500` / `neutral` 琥珀 `bg-amber-500` / `bearish` 紅 `bg-rose-500` / 不可用 灰 `bg-slate-600`）。
- 主文字：`大盤：偏多 / 中性 / 偏空`（`label` 中文化）+ 小字 `（基準 {date}，score {totalScore}）`。
- 次行：`advice` 文字（`text-slate-400 text-sm`）。
- `bearish` 時整條 Card 加 `border-rose-500/40` 醒目邊框。
- 可展開（`<details>`）看三維度明細：每維 `名稱：+1/0/-1`（degraded 標灰 + 「資料不足」），下面列 `detail` 的原始數值（寬度佔比、TAIEX close/ma60、斜率%）。Step 1 時只顯示「市場寬度」一維，另兩維顯示「待 TAIEX 資料」。

台股慣例：偏多綠或紅？——**這裡用「紅漲綠跌」的反面**：市場狀態燈號用**通用號誌色**（綠=通行=偏多、紅=停=偏空、琥珀=注意=中性），跟個股漲跌色（漲紅跌綠）不同語意、不同區塊，不會混淆。RegimeBanner 註解寫明這個選擇。

### 5.2 `/screening` 頁頂燈號

`app/screening/page.tsx`（Server Component 外殼）在頁面標題下、`ScreeningPanel` 之上，放一個**精簡版** regime 條（同 `getMarketRegime()`，只顯示圓點 + `大盤：偏空` + `advice`，不展開明細）。抽 `components/screening/RegimeStrip.tsx`（或 `RegimeBanner` 加 `variant="strip"` prop，二選一，實作時看哪個乾淨）。

目的：使用者在按「開始選股」前先看到大盤狀態，空頭時心裡有數。**不擋按鈕、不改 `runScreening` 行為。**

---

## 6. 實作順序與驗證

### Step 1（先上線，零新資料）

1. `scripts/lib/market-regime.ts`：型別 + `DEFAULT_REGIME_CONFIG` + `fetchBreadthInputs` + breadth 維度 + 合成（`stage` 一律 `step1-breadth-only`，`hasTaiexIndicatorForDate` 回 false 時的分支）。
2. `scripts/pipeline/calculate-market-regime.ts` + `.gitignore` + 接進 `daily-pipeline.ts` 第 5 步。
3. `lib/actions/market-regime.ts` + `advice` 文案。
4. `components/dashboard/RegimeBanner.tsx` + `app/page.tsx` 插入 + `/screening` 頁頂 strip。
5. **驗證**：
   - `pnpm tsx scripts/pipeline/calculate-market-regime.ts` → `data/market-regime/{今天或最新交易日}.json` 生成，`label` 合理（對照當前盤勢肉眼判斷），`dimensions.breadth.detail.pct` 數字合理（多頭期應 >50，空頭期 <50）。
   - `pnpm build` 通過、`pnpm exec tsc --noEmit` 對 `scripts/` 乾淨。
   - `pnpm dev` → 首頁 banner 顯示、`/screening` 頁頂顯示。
   - 手動改 `DEFAULT_REGIME_CONFIG.breadthBullPct` 到極端值重跑，確認 label 跟著變（門檻生效）。

### Step 2（TAIEX 落地後）

6. 先寫一支 5 行測試腳本確認 FinMind `TaiwanStockPrice?data_id=TAIEX` 有回日線資料（沒有就換 dataset，見 1.3）。
7. schema 加 `index` enum + migrate + generate。
8. `scripts/backfill/backfill-index-quotes.ts`（含 upsert `Stock`）→ 跑首次回補。
9. `calculate-technical-indicators.ts` 的 `where` 改 `OR` → `pnpm tsx ... TAIEX` 單獨補 TAIEX 指標 → 查 DB 驗 `ma60` / `bollingerBandwidth` 非 null。
10. `market-regime.ts` 補 `indexPosition` + `ma60Slope` 兩維度 + `fetchTaiex*` helper + `stage` 自動判定（`hasTaiexIndicatorForDate` 回 true → `step2-full`）。
11. `RegimeBanner` 明細展開補另兩維顯示。
12. **驗證**：
    - `pnpm tsx scripts/pipeline/calculate-market-regime.ts` → JSON 的 `stage` 變 `step2-full`，`dimensions.indexPosition` / `ma60Slope` 不為 null，`totalScore` 在 -3~+3。
    - 挑一個「已知大跌段」的歷史日期用 `--date=` 補算（例：2022 年某個跌破季線的日子），確認 `label` 為 `bearish`、指數位置維度為 -1。
    - 挑一個「多頭盤堅」的日期，確認 `bullish`、三維都 +1。
    - `pnpm exec tsc --noEmit` / `pnpm build` 乾淨。

---

## 7. 完成後回寫

- **`CLAUDE.md`**：
  - 「資料表結構總覽」或「前端」段：加 `SecurityType.index` / `TAIEX` 這筆特殊 `Stock` 的說明（只給大盤濾網，不進選股）。
  - 「既有腳本 → `scripts/pipeline/`」：加 `calculate-market-regime.ts`（第 5 步、非關鍵路徑、輸出 `data/market-regime/{date}.json` 不進 DB）。
  - 「既有腳本 → `scripts/backfill/`」：加 `backfill-index-quotes.ts`。
  - 「`scripts/lib/`」：加 `market-regime.ts`（純函式庫、允許查 DB、三維度三段式、門檻集中在 `DEFAULT_REGIME_CONFIG`）。
  - 「前端 → Server Actions」：加 `market-regime.ts`（`getMarketRegime`，只讀檔不碰 DB）。
  - `daily-pipeline.ts` 的步驟數描述（五步 → 六步）。
- **`docs/PROGRESS.md`**：新增段落，記 Step 1 / Step 2 各自的實作內容、FinMind TAIEX dataset 實測結果、三段門檻的初始值與「未校準」狀態、breadth 佔比在當前盤勢的實測數字。
- **`docs/ROADMAP.md`**：4.5.1 的子項打勾。
- **`README.md`**：「目前功能」加一句大盤濾網；「使用方式」若有列 pipeline 步驟則同步。
