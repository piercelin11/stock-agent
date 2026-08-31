# PLAN：融資融券修正因子（ROADMAP 4.5.3 deferred 項）— `margin-chasing` 警示標記

把「融資融券」接進選股評分，但**不是新增第 9 分項、不動任何分數**——只在
`breakout-day` / `extended` 階段，當「突破當日法人淨賣超 **且** 這檔的融資餘額近期暴增
（跟自己歷史比）」時，掛一個 `margin-chasing` **警示標記**（`SignalResult.warnings`）。
系統誠實呈現「發生了法人賣 + 散戶追」，要不要進一步排除由人肉眼判斷。

這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識回寫 `CLAUDE.md`，
過程紀錄回寫 `docs/PROGRESS.md`。

**分支**：延續 `feat/screening-unified`（同一輪選股引擎統一的收尾）。開始前先 `git branch --show-current` 確認。

**前置**：融資融券歷史已補到約兩個月（`fill-margin-trading.ts --backfill=45`，2026-09-01 執行）。

---

## 0. 邊界

### 做的事

1. **`computeMarginSurgePercentile()`（新，`scripts/lib/signal-factors.ts`）**：算「這檔融資餘額近 5 日累積變化率」對「這檔自己過去 N 天的同種變化率分布」取的百分位。純函式，吃序列、不查 DB。
2. **`computeInstitutionalFlow()` 加一個輸出 + 一個輸入**：
   - 新輸入 `marginSurgePercentile: number | null`（null = 盤中 / 資料不足 → 不觸發）。
   - **不動 `score`**（封頂值、加權、任何數值都不改）。
   - 新輸出 `marginChasing: boolean`——`marginSurgePercentile !== null && marginSurgePercentile > threshold && 突破當日法人淨賣超`。
3. **`SignalScanConfig.breakout` 加 `marginChasing` config 區塊**（見 §3）。
4. **`SignalResult` 加 `warnings: string[]` 欄位**（與 `degraded` 分開，見 §4）。`computeInstitutionalFlow` 回 `marginChasing: true` → `run-signal-scan.ts` push `"margin-chasing"` 進 `warnings`。
5. **`run-signal-scan.ts` 加 `fetchMarginSurgeInputs()` helper**：撈 breakout 階段候選股的 `MarginTrading.marginBalance` 序列（近 `lookbackDays + historyWindowDays` 筆），算出每檔的 `marginSurgePercentile`，傳給 `computeInstitutionalFlow`。eod 路徑撈到 `date`（含當日）；realtime 路徑當日融資餘額還沒公布 → `marginSurgePercentile = null`（降級，同法人子項盤中降級）。
6. **前端**：`SignalResult.warnings` 有 `"margin-chasing"` → 列尾一個**琥珀/紅 badge**（跟灰色 `degraded` 明確區分），展開時多一行提示文字。
7. **文件**：`CLAUDE.md`、`docs/PROGRESS.md`、`docs/ROADMAP.md` 把 4.5.3 融資融券子項打勾 + 記「待校準觸發點」。

### 明確不做

- **動 `computeInstitutionalFlow` 的分數 / 封頂 / 權重** → 不做。只加 `marginChasing` 布林輸出 + `warnings` 標記。理由（使用者定調）：既有封頂機制（`sellCapScore`）上面再疊「法人賣 + 融資又暴增所以封頂再降」= 特例規則互相牽扯，之後除錯 / 調權重難追蹤是哪層在起作用。標記取代動態調整，跟 `degraded`「標記但不隱藏、不過度處理」哲學一致。
- **pre-breakout 階段接融資融券** → 不做。`margin-chasing` 的前提是「突破當日法人淨賣超」，pre-breakout 沒突破、沒有「當日法人賣」概念。
- **融資餘額「暴增」用單日變化 / 跨股票比** → 不做。用**近 5 日累積變化率**（散戶追高是連續加碼，且累積能串起「突破前幾天融資悄悄墊高 + 今天噴發」，單日做不到）+ **跟這檔自己歷史比百分位**（同「籌碼因子偏誤修正」的「不跟別的股票比、跟自己比」邏輯，避免大型股 vs 小型股融資規模差異汙染）。
- **融券 / 資券互抵進因子** → 不做。首版只看融資餘額（`marginBalance`）。
- **回測 / 校準** → 不做。`threshold: 80`（前 20%）、`lookbackDays: 5`、`historyWindowDays: 40` 全部首版拍腦袋。**但 §7 列明確的「待校準觸發點」。**
- **`MarginTrading` 進 daily-pipeline 的選股步驟** → 不做。選股維持手動。

---

## 1. 背景

- `MarginTrading` model：`stockCode + date` 唯一，`marginBalance`（融資今日餘額，股）non-null，涵蓋一般股票 + 特別股。歷史已補到約兩個月（40+ 個交易日）。
- `computeInstitutionalFlow`（`scripts/lib/signal-factors.ts`）現況：吃近 5 日投信 / 外資淨買超 + 當日投信 / 外資淨買超 + `volumeMa20`，回 `{ score, degraded }`。已有「突破當日 `todayTrustNetBuy + todayForeignNetBuy < 0` → `score = min(score, sellCapScore=40)`」的封頂邏輯。**這批不動它的 score**。
- `run-signal-scan.ts` 的 `fetchInstitutionalFlowInputs(prisma, date, codes, lookbackDays, toDateInclusive?)`：eod 撈到 `date`（含當日法人）、realtime 撈到 T-1（當日法人 = null）。`fetchMarginSurgeInputs` 比照這個形狀。

---

## 2. `scripts/lib/signal-factors.ts` 改動

### 2.1 `computeMarginSurgePercentile()`（新）

```ts
export interface MarginSurgeConfig {
  lookbackDays: number;        // 5（近 5 個交易日累積變化率）
  historyWindowDays: number;   // 40（百分位母體：這檔過去 N 天的同種變化率）
  minHistoryDays: number;      // 20（母體有效樣本 < 此值 → 回 null，比照 computeBase 保守門檻）
}

/**
 * marginBalanceNewestFirst：這檔的 MarginTrading.marginBalance 序列，日期新到舊，
 *   長度已由呼叫端截到 lookbackDays + historyWindowDays + 1 附近。
 * 回傳：近 lookbackDays 日累積變化率，對「過去 historyWindowDays 天、每天各自往回 lookbackDays 日的
 *   累積變化率」母體取的百分位（0~100，越高代表這檔近期融資增速排在自己歷史越前面）。
 *   資料不足（母體有效樣本 < minHistoryDays）→ null。
 */
export function computeMarginSurgePercentile(
  marginBalanceNewestFirst: number[],
  config: MarginSurgeConfig,
): number | null {
  const { lookbackDays, historyWindowDays, minHistoryDays } = config;

  // 需要至少「當前這筆 + lookbackDays 筆」才能算今天的累積變化率
  if (marginBalanceNewestFirst.length < lookbackDays + 1) return null;

  // 單筆「近 lookbackDays 日累積變化率」：(series[i] - series[i+lookbackDays]) / series[i+lookbackDays]
  const changeRateAt = (i: number): number | null => {
    const now = marginBalanceNewestFirst[i];
    const past = marginBalanceNewestFirst[i + lookbackDays];
    if (now === undefined || past === undefined || past <= 0) return null;
    return (now - past) / past;
  };

  const today = changeRateAt(0);
  if (today === null) return null;

  // 母體：i = 1 .. historyWindowDays，每個 i 算一筆歷史累積變化率
  const population: number[] = [];
  for (let i = 1; i <= historyWindowDays; i++) {
    const r = changeRateAt(i);
    if (r !== null) population.push(r);
  }
  if (population.length < minHistoryDays) return null;

  // 百分位：母體中 <= today 的比例 × 100
  const below = population.filter((v) => v <= today).length;
  return (below / population.length) * 100;
}
```

**設計備註**：
- 母體用「過去每一天各自的近 5 日累積變化率」，不是「過去每一天的單日變化率」——確保 today 和母體是**同一種量**在比。
- `past <= 0`（融資餘額歸零 / 缺值）→ 該筆跳過，不炸。
- 純函式、不查 DB、不讀 module-level 常數（比照現有因子慣例）。

### 2.2 `computeInstitutionalFlow()` 改動

**簽名加一個輸入**：

```ts
export function computeInstitutionalFlow(input: {
  trustNetBuyNewestFirst: number[];
  foreignNetBuyNewestFirst: number[];
  todayTrustNetBuy: number | null;
  todayForeignNetBuy: number | null;
  volumeMa20: number | null;
  marginSurgePercentile: number | null;   // 新：null = 盤中 / 資料不足 → 不觸發
  config: InstitutionalFlowConfig;
}): { score: number; degraded: boolean; marginChasing: boolean }   // 新輸出 marginChasing
```

**實作改動**（在現有函式尾段、`return` 之前）：

```ts
// margin-chasing 判定：突破當日法人淨賣超 且 這檔融資近期暴增（跟自己比）。
// !!! 不動 score !!! 只回一個布林讓呼叫端掛 warnings 標記。
// marginSurgePercentile 為 null（盤中拿不到 / 資料不足）→ 一律 false，不做 null 的數值比較。
const bothTodayKnown = input.todayTrustNetBuy !== null && input.todayForeignNetBuy !== null;
const todayNetSell = bothTodayKnown && input.todayTrustNetBuy! + input.todayForeignNetBuy! < 0;
const marginChasing =
  input.marginSurgePercentile !== null &&
  input.marginSurgePercentile > input.config.marginChasing.surgePercentileThreshold &&
  todayNetSell;

return { score: clip(score, 0, 100), degraded, marginChasing };
```

> **實作注意（使用者提醒）**：`marginSurgePercentile` 為 `null` 時，`null > 80` 在 JS 是 `false`（不會炸），但語意上要靠前面的 `!== null` 明確擋掉，不要依賴 JS 的隱式行為。已在上面條件式的第一項處理。

**`InstitutionalFlowConfig` 加子物件**：

```ts
export interface InstitutionalFlowConfig {
  lookbackDays: number;
  trustWeight: number;
  foreignWeight: number;
  clipDivisor: number;
  sellCapScore: number;
  marginChasing: {                    // 新
    lookbackDays: number;             // 5
    historyWindowDays: number;        // 40
    minHistoryDays: number;           // 20
    surgePercentileThreshold: number; // 80
  };
}
```

`DEFAULT_INSTITUTIONAL_FLOW_CONFIG` 加：
```ts
marginChasing: { lookbackDays: 5, historyWindowDays: 40, minHistoryDays: 20, surgePercentileThreshold: 80 },
```

`resolveSignalConfig` 的 `breakout.institutionalFlow` 展開段補這四個欄位（手寫 `?? d....`，比照現有）。

### 2.3 單元測試（`scripts/lib/signal-factors.test.ts` 追加）

- `computeMarginSurgePercentile`：
  - 序列長度 < `lookbackDays + 1` → `null`
  - 母體有效樣本 < `minHistoryDays` → `null`
  - 融資餘額一路平（變化率全 0）→ today 也 0 → 百分位 ~ 100（母體全 <= 0，today = 0，`<=` 命中全部）→ 確認邊界行為符合預期（平盤不該觸發 → 但百分位高。**這是 threshold 80 + `> threshold` 的設計要擋的：平盤時 today changeRate = 0，母體也全 0，百分位 = 100 > 80 會誤觸發**）。**修正：百分位改用「嚴格小於」`population.filter(v => v < today).length`，平盤時 today=0、母體=0，`0 < 0` 為 false → 百分位 0，不誤觸發**。← 實作時採「嚴格小於」，測試涵蓋此案例。
  - 融資餘額最近 5 日大增、過去平緩 → today changeRate 遠大於母體 → 百分位接近 100
  - `past <= 0`（歷史某筆融資歸零）→ 該筆跳過、不炸，其餘正常算
- `computeInstitutionalFlow` 的 `marginChasing` 輸出：
  - `marginSurgePercentile = null` → `marginChasing: false`（即使當日法人淨賣超）
  - `marginSurgePercentile = 90`、當日法人淨賣超 → `marginChasing: true`
  - `marginSurgePercentile = 90`、當日法人淨買超 → `marginChasing: false`
  - `marginSurgePercentile = 50`（< threshold 80）、當日法人淨賣超 → `marginChasing: false`
  - `marginChasing: true` 時 `score` 跟沒有 margin 輸入時**完全一致**（確認不動分數）

> §2.3 已把「平盤百分位 = 100 誤觸發」的坑挖出來 → `computeMarginSurgePercentile` 內部用**嚴格小於**算百分位。§2.1 的程式碼片段對應改成 `population.filter((v) => v < today).length`。

---

## 3. `SignalScanConfig` 最終結構（`breakout.institutionalFlow` 部分）

```ts
institutionalFlow: {
  lookbackDays: 5,
  trustWeight: 0.6,
  foreignWeight: 0.4,
  clipDivisor: 0.5,
  sellCapScore: 40,
  marginChasing: {
    lookbackDays: 5,
    historyWindowDays: 40,
    minHistoryDays: 20,
    surgePercentileThreshold: 80,
  },
},
```

其餘 `SignalScanConfig` 不動。

---

## 4. `SignalResult.warnings` 欄位（`run-signal-scan.ts`）

```ts
export interface SignalResult {
  // ... 現有欄位不動 ...
  degraded: string[];    // 資料不足 / 不確定（現有，語意不變）
  warnings: string[];    // 新：資料充足、系統明確發現的風險訊號（目前只有 "margin-chasing"）
}
```

- **`degraded` vs `warnings` 分開的理由**（使用者定調）：`degraded` = 因為資料不夠所以不確定；`warnings` = 因為資料充足、系統很確定地在警告。混在同一陣列前端沒法用顏色區分。
- 欄位名用 **`warnings`** 不用 `flags`（`flags` 太中性、不傳達「需要注意的風險」；`warnings` 直接對應 UI 琥珀/紅警示）。
- **只有 `breakout-day` / `extended` 的 `SignalResult` 會有非空 `warnings`**（pre-breakout 恆為 `[]`）。
- `SignalScanOutput.warnings`（管線層級的警語，如「MIS 有 N 檔無成交價」）**與這個 per-stock `warnings` 是不同層級**，不要混。per-stock 的叫 `SignalResult.warnings`。
- `lib/actions/signal-scan.ts` 的 `SignalScanView.results` 直接沿用 `SignalResult`（已含 `warnings`），邊界轉換不用改（`string[]` 可序列化）。

---

## 5. `run-signal-scan.ts` 撈取 + 接線

### 5.1 `fetchMarginSurgeInputs()`（新 helper，比照 `fetchInstitutionalFlowInputs`）

```ts
/**
 * 撈 breakout 階段候選股的 MarginTrading.marginBalance 序列，算出每檔的 marginSurgePercentile。
 * toDate：eod = 掃描日（含當日融資餘額）；realtime = 傳 null（當日融資餘額晚上才公布）。
 * 回傳 Map<code, number | null>；toDate 為 null 時全部回 null（降級，比照法人子項盤中降級）。
 */
async function fetchMarginSurgeInputs(
  prisma: PrismaClient,
  toDate: Date | null,
  codes: string[],
  config: { lookbackDays: number; historyWindowDays: number; minHistoryDays: number },
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (codes.length === 0) return result;
  if (toDate === null) {
    for (const c of codes) result.set(c, null);
    return result;
  }

  const need = config.lookbackDays + config.historyWindowDays + 2; // 緩衝
  const BATCH = 250;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const rows = await prisma.marginTrading.findMany({
      where: { stockCode: { in: batch }, date: { lte: toDate } },
      orderBy: { date: "desc" },
      select: { stockCode: true, date: true, marginBalance: true },
    });
    const byCode = new Map<string, number[]>();
    for (const r of rows) {
      let list = byCode.get(r.stockCode);
      if (!list) { list = []; byCode.set(r.stockCode, list); }
      if (list.length < need) list.push(Number(r.marginBalance)); // BigInt → number（融資餘額量級遠小於 2^53）
    }
    for (const code of batch) {
      result.set(code, computeMarginSurgePercentile(byCode.get(code) ?? [], config));
    }
  }
  return result;
}
```

**記憶體**：`where: { stockCode: in codes, date: lte }` 無 take → 對 `codes` 分批（`BATCH=250`，比照 `fetchInstitutionalFlowInputs` / `fetchAccumulationRawInputs`）。breakout 階段候選通常只有幾十檔，實務上一批就夠。

### 5.2 接線

- **eod 路徑**（`runEod`）：`breakoutCodes` 算完後，除了現有的 `fetchInstitutionalFlowInputs(prisma, date, breakoutCodes, ...)`，再加：
  ```ts
  const marginSurgeByCode = await fetchMarginSurgeInputs(prisma, date, breakoutCodes, {
    lookbackDays: b.institutionalFlow.marginChasing.lookbackDays,
    historyWindowDays: b.institutionalFlow.marginChasing.historyWindowDays,
    minHistoryDays: b.institutionalFlow.marginChasing.minHistoryDays,
  });
  ```
- **realtime 路徑**（`runRealtime`）：`fetchMarginSurgeInputs(prisma, null, breakoutCodes, ...)` → 全 null。
- **`computeBreakoutFactors`**（共用函式）：`BreakoutFactorInput` 加 `marginSurgePercentile: number | null`，傳進 `computeInstitutionalFlow`。回傳的 `flow.marginChasing` → 若 true，push `"margin-chasing"` 進該檔的 `warnings`（新開一個 `warnings: string[]`，跟 `degraded` 併行）。
- `BreakoutFactorOutput` 加 `warnings: string[]`。`runEod` / `runRealtime` 組 `SignalResult` 時帶上 `warnings: factors.warnings`（pre-breakout 的 `SignalResult` 直接 `warnings: []`）。

### 5.3 `emptyOutput` / 其他 `SignalResult` 生成點

所有生成 `SignalResult` 的地方補 `warnings`（pre-breakout 恆 `[]`、breakout 帶 `factors.warnings`）。`emptyOutput` 不生 results，不受影響。

---

## 6. 前端（`components/screening/ScreeningPanel.tsx`）

- `Row` 型別已是 `SignalScanView["results"][number]`，自動帶 `warnings`。
- **表格列**：`priceSource === "estimated"` 已有「估」badge（琥珀）。再加：`row.warnings.includes("margin-chasing")` → 一個 **紅色** badge「追」（`bg-rose-500/20 text-rose-400`），跟「估」（琥珀）、`degraded`（灰字）三者顏色分明。
- **展開明細（`Detail`）**：`row.warnings.length > 0` → 最上面一個紅框提示：
  > ⚠ margin-chasing：突破當日三大法人（投信＋外資）淨賣超，且本檔融資餘額近期增速排在自己歷史前 20%——散戶追價、法人可能在派發。系統僅標記，未調整分數，請自行判斷是否排除。
- **不改**：排序、filter、加入觀察清單邏輯。`warnings` 純顯示。

---

## 7. 驗證

1. **`pnpm exec tsc --noEmit`** 乾淨（scripts + app）。
2. **`pnpm tsx --test scripts/lib/signal-factors.test.ts`** 全綠（含 §2.3 新增案例）。
3. **eod 跑最新交易日**：`pnpm tsx scripts/screening/run-signal-scan.ts --source=eod`
   - 落地 JSON 的 `results` 每筆有 `warnings` 欄（breakout 階段可能非空、pre-breakout 恆 `[]`）。
   - **抽出所有 `warnings` 含 `"margin-chasing"` 的股票**，逐檔人工核對：
     - 突破當日投信 + 外資淨買超確實 < 0（查 `InstitutionalTrading`）。
     - `MarginTrading.marginBalance` 近 5 日確實明顯高於 5 日前，且這個增速在該檔過去 40 天裡算前段（手算一兩檔的 `computeMarginSurgePercentile` 對照）。
   - **對照組**：同一批 breakout 股裡 `warnings` 為空的，確認至少有「當日法人淨買超」或「融資沒暴增」其一。
   - **確認分數沒變**：把 `config.breakout.institutionalFlow.marginChasing.surgePercentileThreshold` 設成 `101`（永不觸發）跑一次，比對 `results` 每筆 `totalScore` / `scores.institutionalFlow` 與預設跑**完全一致**（證明 `marginChasing` 不影響分數）。
4. **realtime 冒煙**（`--source=realtime`）：`results` 的 breakout 階段每筆 `warnings` 為 `[]`（當日融資餘額拿不到 → `marginSurgePercentile` 全 null → 不觸發），且不炸。
5. **前端**：`curl http://localhost:3000/screening`（打使用者 dev server）render 不炸；若當日有 `margin-chasing` 股，切到「今日突破」/「已延伸」看得到紅 badge + 展開提示。
6. **資料量檢查**：`MarginTrading` 涵蓋的交易日數 ≥ `lookbackDays + minHistoryDays`(=25)，否則 `computeMarginSurgePercentile` 對多數股票回 null（因子等於沒作用）。回補 45 個交易日應足夠。

---

## 8. 收尾（文件）

- **`CLAUDE.md`**：
  - `MarginTrading` 那條「**尚無下游消費者**（評分整合待 ROADMAP 4.5.3）」→ 改成「下游：`run-signal-scan.ts` 的 `margin-chasing` 警示（`computeMarginSurgePercentile` → `computeInstitutionalFlow` 回 `marginChasing` → `SignalResult.warnings`）。**只標記不動分數**」。
  - `scripts/lib/signal-factors.ts` 那條加 `computeMarginSurgePercentile`、`computeInstitutionalFlow` 的 `marginSurgePercentile` 輸入 / `marginChasing` 輸出、`marginChasing` config 子物件。
  - `/screening` 那段 / 「三階段」設計理由段：補一句 `SignalResult.warnings`（`margin-chasing`）與 `degraded` 分開的語意（資料充足的風險訊號 vs 資料不足的不確定）。
  - `fill-margin-trading.ts` 那條：`--backfill` 日曆日上限已從 `n+6` 放寬到 `max(n+6, n*2)`（大 N 不提早停）。
- **`docs/PROGRESS.md`**：新增本次段落——`margin-chasing` 的動機、為何只標記不動分數、`computeMarginSurgePercentile` 的「近 5 日累積變化率 vs 自己 40 天歷史百分位」設計、「嚴格小於」避免平盤誤觸發、eod/realtime 降級、實測有哪些股票被標 + 人工核對結果、歷史回補 45 個交易日的實得數字。
- **`docs/ROADMAP.md` 4.5.3**：`融資融券當修正因子` 那個 `- [ ]` 打勾。**在打勾行下面補一條待校準**：
  > 待校準觸發點：累積滿 3 個月融資融券資料後（約 2026-11 起），回頭檢查此因子實際觸發頻率 + 命中準確度，再決定 `surgePercentileThreshold`(80) / `lookbackDays`(5) / `historyWindowDays`(40) 要不要調。
  打勾後提醒使用者 4.5.3 除「等資料再校準」外已全部完成，4.5 節僅剩「4.5.2 歷史回補到 2020」一個明確 deferred 項（且已補到兩個月、暫不做全 6 年）。

---

## 9. 實作順序建議

1. `signal-factors.ts`：`computeMarginSurgePercentile`（含「嚴格小於」）+ `computeInstitutionalFlow` 加 `marginSurgePercentile` 輸入 / `marginChasing` 輸出 + `marginChasing` config + `resolveSignalConfig` 展開。單元測試（§2.3）。
2. `run-signal-scan.ts`：`SignalResult.warnings` 欄位 + `BreakoutFactorInput/Output` 加 `marginSurgePercentile` / `warnings` + `fetchMarginSurgeInputs` + eod / realtime 接線 + 所有 `SignalResult` 生成點補 `warnings`。驗證 §7.3（含 threshold=101 分數不變測試）。
3. `ScreeningPanel.tsx`：紅 badge + 展開提示。驗證 §7.5。
4. 文件收尾（§8）。
5. `pnpm exec tsc --noEmit` + `pnpm build` 最終確認。
