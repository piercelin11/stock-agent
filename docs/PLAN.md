# PLAN 8：籌碼面觀察標籤（輕手版）+ 標籤系統統一管理

**一句話**：沿用 `margin-chasing` 的「純函式回布林 / 字串、不動分數、呼叫端掛進 `warnings`」模式，
新增 4 個籌碼面觀察標籤（3 個 warning + 1 個中性背景欄位），偵測現有聚合式因子看不到的
「假突破誘多」「單日爆量偽裝成累積」「法人濃度過高體質脆弱」；同時把散落各處的 `warnings`
magic string 與 chip 文字收進 `components/signal/labels.ts` 的中央清單，每筆帶觸發條件 / 意義註解。

**分支**：先把 `feat/watchlist-manual-stage`（PLAN 6 + PLAN 7 已 commit 在上面、已驗證）merge 回 `main`，
再從 `main` 開 `feat/institutional-tags`。**merge 時機等使用者發話**。

**需求來源**：PLAN 7 收尾後的討論（2026-09-04）。使用者觀察到現有籌碼因子都是「20 日窗等權加總」，
無法偵測時間結構（前扎實後轉賣）與分布結構（單日爆量 vs 分散累積）的風險。決定先做輕手版
（只標記、不打折分數），累積實盤資料後再獨立回測評估要不要真的動分數。

---

## 0. 背景與目標

### 現有籌碼因子的三個盲點（討論結論）

| 盲點 | 現況函式 | 問題 |
|---|---|---|
| **時間結構** | `computeTrustRawMetrics`（`accumulation.ts`）對整個 20 日窗等權加總 `buyFrequency` / `netRatio` | 「前 15 天投信買超扎實、近 5 天悄悄轉賣」的假突破誘多劇本，加總後看起來仍是「20 日淨買超為正」 |
| **分布結構** | `computeOtherInstitutionRatio`（`accumulation.ts`）= 20 日合計買超 ÷ 20 日合計成交量 | 「單一天爆量買超 8000 張、其他 19 天幾乎沒動」與「20 天穩定買超」算出相近比例，掩蓋單日暴量的非常態風險 |
| **濃度風險** | `computeInstitutionalFlow`（`institutional.ts`）只把 `trustRatio + foreignRatio` 用於「法人翻空 → 封頂 40 分」 | 法人濃度過高（近 5 日淨買超佔均量 80%↑）、散戶籌碼淺、體質脆弱——即使法人還沒翻空也是隱患，目前完全不標記 |

### 設計原則（務必遵守）

1. **不動分數**。本 PLAN 全部只新增 `warnings` 字串或新的分類欄位。
   `chipScore` / `trustScore` / `otherInstScore` / `institutionalFlow.score` 等所有現有計分公式的**輸出值不變**。
   驗收條件：改動前後跑 `factors.test.ts` 既有分數斷言全部不變；`run-signal-scan --date=<交易日>` 前後
   逐檔 `totalScore` / `scores.*` / `rank` / `stats` 完全一致。
2. **比照 `marginChasing` 實作模式**。純函式只回傳資料（布林 / 字串 / 數字），由呼叫端
   （`computeBreakoutFactors` 或 `run-signal-scan.ts` 的 `preStaged.forEach`）決定要不要 push 進 `warnings`
   或設進新欄位。純函式一律不查 DB。
3. **config 化**。任何新門檻走 `SignalScanConfig` 加欄位、`resolveSignalConfig` 手寫展開合併，
   比照現有 `institutionalFlow.marginChasing.surgePercentileThreshold`。不寫死常數。
4. **測試先行**。每個新純函式在 `factors.test.ts` 補測試（null 輸入 / 邊界值 / 正常觸發 / 正常不觸發）。
5. **中文註解風格**。延續雙語混合、`§` 章節引用、「PLAN 8 §x.x」出處註記。
6. **明確排除**（見 §9）：不做「重手版」（用修正係數打折分數）；不新增外資 / 自營商的
   `buyFrequency` 指標（用 `concentration` 警訊取代）；不做歷史回測校準門檻值（後續獨立工作）。

### 這次會加入的 4 個標籤

| 標籤 | 機制 | 型別 | 意義 | 適用階段 | 優先度 |
|---|---|---|---|---|---|
| `trend-reversal` | warning | `warnings` 陣列多一字串 | 近 5 日投信淨賣、前 15 日淨買 → 假突破誘多 | `setup`（**首次讓 setup 有非空 warnings**） | 1（最高） |
| `institution-crowded` | warning | `warnings` 陣列多一字串 | 近 5 日法人淨買超佔均量比例過高、散戶籌碼淺、體質脆弱（即使未翻空） | `breakoutDay` / `extended` | 2 |
| `instBackground` | **新的中性欄位** | `SignalResult.instBackground?: InstBackground` | 中性背景：法人這波是早佈局還是剛進場（無好壞之分，兩情境解讀甚至相反） | `breakoutDay` / `extended` | 3 |
| `concentration` | warning | `warnings` 陣列多一字串 | 20 日**外資+自營**買超集中在單一交易日 → 非常態爆量偽裝成累積 | `setup` | 5（改動範圍評估最大，放最後） |

（優先度 4 = §7 的「自營商設計理由註解」，純文件。）

### 標籤系統統一管理（附帶改善，見 §8）

- **`warnings`**：目前 `"margin-chasing"` 這個 magic string 散在 4 個檔案硬比對、中文說明寫死在
  `SignalDetail.tsx`。建 `WARNING_LABELS` 中央清單（`labels.ts`），4 個 warning 集中管理，
  每筆帶 `title` / `detail`（意義）/ `trigger`（觸發條件白話）/ `tone`。三個頁面改成查 map 渲染。
- **chip**：`resolveInstChip()` / `resolvePreBreakoutChip()` 兩個判斷表**函式結構不變**（分支邏輯不適合抽 map），
  但把每分支的 chip 文字 + tone 收進 `CHIP_LABELS` 常數、函式改引用，且每分支上方補「觸發條件 + 意義」註解。

---

## 1. 邊界

### 動（純函式庫）

- **`scripts/lib/signal-factors/accumulation.ts`**
  - 新增 `computeTrendReversal()`（時間結構切分判定，§2）。
  - 新增 `computeSingleDayConcentration()`（單日集中度判定，§5）。
  - 兩者純函式、吃新到舊序列、不查 DB。放檔尾新 section「PLAN 8：籌碼面觀察標籤」。
- **`scripts/lib/signal-factors/institutional.ts`**
  - `computeInstitutionalFlow()` 回傳值加 `institutionCrowded: boolean`（§4）。**score / degraded / marginChasing 不動**。
  - 新增 `classifyInstBackground()`（近 5 日 vs 前 15 日方向分類，§6）。純函式。
  - `InstitutionalFlowConfig` 上方補「刻意排除自營商」設計理由註解（§7）。
- **`scripts/lib/signal-factors/config.ts`**
  - `SignalScanConfig` 新增欄位（§2.3 / §4.3 / §5.3 / §6.3 彙整見 §1 末）。
  - `DEFAULT_SIGNAL_CONFIG` 補預設值；`resolveSignalConfig` 手寫展開合併。
- **`scripts/lib/signal-factors/factors.test.ts`**
  - 每個新純函式補 4~6 案（§2.5 / §4.5 / §5.5 / §6.5）。

### 動（掃描腳本）

- **`scripts/screening/run-signal-scan.ts`**
  - `SignalResult` 型別：`instBackground?: InstBackground` 新欄位（§6.1）。`warnings` 型別不變（仍 `string[]`）。
  - **eod `preStaged.forEach`（約 L744）+ realtime `preStaged.forEach`（約 L1332）**：
    算 `computeTrendReversal(accInputs.get(s.code)?.trustNetBuyNewestFirst ?? [], config...)`；
    算 `computeSingleDayConcentration(accInputs.get(s.code)?.foreignPlusDealerNewestFirst ?? [], config...)`；
    命中則把對應字串 push 進該 setup 列的 `warnings`（**取代現在硬編的 `warnings: []`**）。
  - **`computeBreakoutFactors`（約 L324）**：`flow.institutionCrowded` → push `"institution-crowded"` 進
    `warnings`（跟現有 `flow.marginChasing` 那行並排）。
  - **eod / realtime 的 breakout `results.push`（約 L861 / L1454）**：加 `instBackground:
    classifyInstBackground(accInputs.get(s.code)?..., config...)`（`accInputs` 在 PLAN 7 已對 breakout 那 ~20 檔撈了
    20 日窗，**零額外查詢**——見 §6.2）。
  - **`degraded` 語意不變**：新標籤資料不足時**不觸發**（回 false / null），不 push `degraded`——
    這些是「明確發現的訊號」不是「不確定」。唯一例外：`instBackground` 資料不足回 `null`（不是 `"unknown"`），前端不渲染。

### 動（前端呈現）

- **`components/signal/labels.ts`**
  - 新增 `export type Tone`（從 `InstitutionalFlowPanel.tsx` 搬過來當單一出處，或 `labels.ts` re-export；
    避免循環 import——`labels.ts` 目前不 import 元件，`Tone` 是純型別，搬過來最乾淨）。
  - 新增 `WARNING_LABELS: Record<WarningKey, { title; detail; trigger; tone }>`（§8.1）。
  - 新增 `CHIP_LABELS`（§8.2，chip 文字 + tone 常數化）。
  - 新增 `INST_BACKGROUND_LABELS: Record<InstBackground, { text; hint }>`（§6.4）。
  - `FACTOR_LABELS` 不動（新標籤不是「因子」）。
- **`components/signal/InstitutionalFlowPanel.tsx`**
  - `resolveInstChip()`：新增「`institution-crowded` 命中」分支（tone `warning`，文字「法人擁擠」）；
    每分支上方補觸發條件註解；chip 文字改引用 `CHIP_LABELS`。
  - `Tone` / `TONE_CHIP` 若搬到 `labels.ts` → 這裡 re-export 維持既有 import 路徑不炸。
- **`components/signal/pre-breakout-chip.ts`**
  - `resolvePreBreakoutChip()`：新增「`trend-reversal` 或 `concentration` 命中」分支（優先於現有 9 條，
    tone `destructive` / `warning`）；每分支補觸發條件註解；chip 文字引用 `CHIP_LABELS`。
  - **簽名擴充**：現在只吃 `preInst`，要加 `warnings: string[]` 參數（比照 `resolveInstChip`）。
- **`components/signal/WarningBanner.tsx`（新元件）**
  - `<WarningBanner warnings={string[]} />` → 對每個命中的 warning 查 `WARNING_LABELS` 渲染一行
    `⚠ {title}：{detail}`，底色依 tone（`border-{tone}/30 bg-{tone}/10 text-{tone}`，比照現有提示框寫法）。
  - 空陣列 → 不渲染。screening 展開列 + watchlist 卡片共用。
- **`components/screening/SignalDetail.tsx`**
  - L23~L28 寫死的 `margin-chasing` 紅框 → 換成 `<WarningBanner warnings={row.warnings} />`（多個 warning 一起渲染）。
  - breakout 分支：`InstitutionalFlowPanel` 下方加一行 `instBackground` 小灰字（查 `INST_BACKGROUND_LABELS`）。
- **`components/screening/ScreeningPanel.tsx`**
  - `instCell()`（表格「籌碼」欄，L38）：維持「擠進 chip」精簡做法（表格空間有限），但
    `marginChasing` 的比對改成「`warnings` 命中任一 `destructive` tone 的 warning」→ 顯示對應 `WARNING_LABELS[key].title`；
    多個命中取 tone 最重的一個。
  - setup 列現在也可能有 warnings → `instCell` 目前 `if (!r.inst) return "—"` 會讓 setup 列的 warning
    在表格看不到。**加**：setup 列若 `r.warnings.length > 0` → 顯示 warning chip（紅/琥珀），否則維持 `—`。
- **`components/watchlist/WatchlistCard.tsx`**
  - L36~L39 `chip`：`resolvePreBreakoutChip(row.preInst)` → `resolvePreBreakoutChip(row.preInst, row.warnings)`；
    `resolveInstChip(row.inst, [])` → `resolveInstChip(row.inst, row.warnings)`（**現在傳空陣列，改傳實際 warnings**）。
  - 走勢圖（L108）下方、法人籌碼區塊（L113）上方，新增 `<WarningBanner warnings={row.warnings} />`。
  - breakout 卡片：法人籌碼區塊下方加 `instBackground` 小灰字（同 `SignalDetail`）。
- **`components/screening/BreakoutFactorBars.tsx`**：不動（`instBackground` / warnings 不是長條因子）。
- **`components/signal/FactorList.tsx`**：不動（底排因子維持現狀，新標籤走 chip / banner 不進底排）。

### 動（型別 / action 邊界）

- **`lib/actions/signal-scan.ts`**：`SignalScanView` 透傳 `SignalResult` → `instBackground` 自動帶（`ScanResultLite = SignalResult`）。
  確認 `instBackground` 是可序列化 plain（string | null），無需轉換。
- **`lib/actions/watchlist.ts`**
  - `WatchlistCardRow` 加 `warnings: string[]`（醞釀卡片要顯示 `trend-reversal` / `concentration`）
    + `instBackground: InstBackground | null`（breakout 卡片要顯示）。
  - `buildCardRow()`：
    - `warnings`：從 `ctx.latestScan.resultByCode.get(code)?.warnings ?? []` 取（**讀最近掃描結果，不在 action 現算**——
      跟 `relativeStrength` / `preInst` 分數一致的策略：全市場百分位 watchlist 幾檔算不出。
      `trend-reversal` / `concentration` 雖然不需要母體，但為了「卡片與 screening 頁一致」統一從掃描 JSON 帶）。
    - `instBackground`：同上，`resultByCode.get(code)?.instBackground ?? null`。
  - **既有 `buildCardRow` 已讀 `ctx.latestScan`（`prByCode` / `preInstByCode`）**——`resultByCode` 也在
    `LatestScan` 裡（PLAN 3 加的），直接多讀兩個欄位，**0 新查詢、0 新讀檔**。
- **`lib/latest-scan.ts`**：`ScanResultLite = SignalResult` 已含 `warnings`，`instBackground` 加進 `SignalResult`
  後自動涵蓋。`buildLatestScan` **不用改**（`resultByCode.set(r.code, r)` 整包存）。

### 不動

- **`prisma/schema.prisma`**：無 migration。純計算層 + 前端。
- **`totalScore` 合成 / `rankWithinStages` / gate 門檻 / `stats.*`**：一律不動。
- **`computeTrustRawMetrics` / `computeOtherInstitutionRatio` / `computeInstitutionalFlow` 的 score 輸出**：不動
  （`computeInstitutionalFlow` 只加一個回傳布林欄，score 分支不碰）。
- **`fetchInstitutionalFlowInputs` 的 `lookbackDays`**：不動（`instBackground` 複用 PLAN 7 已撈的 `accInputs` 20 日窗，見 §6.2）。
- **`fetchAccumulationRawInputs`**：不動（PLAN 7 已把 code 清單擴為 `[...preCodes, ...breakoutCodes]`，
  `trustNetBuyNewestFirst` / `foreignPlusDealerNewestFirst` 20 日序列 setup + breakout 都有）。
- **`FACTOR_LABELS` / `STAGE_LABELS` / `STAGE_ORDER`**：不動。

### 新增 config 欄位彙整（§2.3 / §4.3 / §5.3 / §6.3 細節在各節）

`SignalScanConfig` 新增：

```ts
// 新增在 preBreakout 子物件（trend-reversal + concentration 都是 setup 階段）
preBreakout: {
  // ...現有...
  trendReversal: {
    recentDays: number;   // 5   —— 「近段」切分點
    priorDays: number;    // 15  —— 「前段」（recentDays + priorDays 應 = institutionalWindowDays 20）
    minDataDays: number;  // 12  —— 兩段合計有效天數 < 此值 → 不判定（回 false）
  };
  concentration: {
    thresholdRatio: number;  // 0.5 —— 單一交易日買超 ÷ 窗內總「正買超」> 此值 → 命中
    minWindowDays: number;   // 10  —— 窗內有效天數 < 此值 → 不判定
    minTotalNetBuy: number;  // 0   —— 窗內總買超 <= 此值（法人整體在賣）→ 不判定（避免除以極小值 / 負值）
  };
};
// 新增在 breakout.institutionalFlow 子物件
institutionalFlow: {
  // ...現有 lookbackDays / trustWeight / ... / marginChasing ...
  crowdedThreshold: number;   // 0.8 —— (trustRatio + foreignRatio) > 此值 → institutionCrowded
  background: {
    recentDays: number;       // 5
    priorDays: number;        // 15
    activityEpsilon: number;  // 前段「淨買超合計 ÷ volumeMa20」絕對值 <= 此值 → 視為「前段無動作」；預設 0.02
    minDataDays: number;      // 12 —— 資料不足 → instBackground = null
  };
};
```

**所有預設值都是經驗建議、未經回測校準**——§10 明列為待確認項。

---

## 2. `trend-reversal`（優先度 1）

### 2.1 現況分析

- `computeTrustRawMetrics(netBuySeriesNewestFirst, sharesOutstanding, windowDays, minDaysRatio)`
  （`accumulation.ts` L136）對整個 20 日窗算 `buyFrequency`（買超天數佔比）與 `netRatio`（淨買超股數 ÷ 發行量）。
  兩者都是**等權加總 / 佔比**，時間位置資訊在加總後消失。
- `run-signal-scan.ts` 的 `preStaged.forEach` 用 `accInputs.get(s.code)?.trustNetBuyNewestFirst`
  （已是 20 日窗、新到舊）算 setup 的 `trustScore`。同一份序列即可切分。

### 2.2 新函式

**檔案**：`scripts/lib/signal-factors/accumulation.ts` 檔尾新 section。

```ts
// ============================================================================
// PLAN 8 §2：computeTrendReversal —— 投信買超的時間結構（前段扎實 / 近段轉賣）
// ============================================================================
//
// 目的：偵測「前 priorDays 天投信淨買超為正、近 recentDays 天悄悄轉負」的假突破誘多劇本。
//   computeTrustRawMetrics 的 20 日等權加總看不到這個轉折（前正後負相抵後總和仍可能為正）。
//
// 觸發：近段淨買超合計 < 0  且  前段淨買超合計 > 0。
//   —— 「近段本身在賣、但前段還在買」才算轉賣訊號；兩段都賣 = 一路在賣（不是「轉」），不觸發。
// 不動任何分數，只回布林讓 run-signal-scan.ts 掛進 warnings。
//
// config：trendReversal.{ recentDays, priorDays, minDataDays }。
//   recentDays + priorDays 通常 = institutionalWindowDays(20)；序列比 20 短時按實際長度切。

export interface TrendReversalConfig {
  recentDays: number;   // 5
  priorDays: number;    // 15
  minDataDays: number;  // 12（兩段合計有效天數下限，比照 computeBase 保守門檻精神）
}

/**
 * trustNetBuyNewestFirst：投信淨買超序列，日期新到舊（run-signal-scan 的 accInputs 已備）。
 * 回傳 true = 命中「近段轉賣、前段在買」；資料不足 / 未命中 → false。
 */
export function computeTrendReversal(
  trustNetBuyNewestFirst: number[],
  config: TrendReversalConfig,
): boolean {
  const { recentDays, priorDays, minDataDays } = config;
  const n = trustNetBuyNewestFirst.length;
  if (n < minDataDays) return false;

  const recent = trustNetBuyNewestFirst.slice(0, recentDays);
  const prior = trustNetBuyNewestFirst.slice(recentDays, recentDays + priorDays);
  // 近段 / 前段各自至少要有一筆才有意義
  if (recent.length === 0 || prior.length === 0) return false;

  const recentSum = recent.reduce((s, v) => s + v, 0);
  const priorSum = prior.reduce((s, v) => s + v, 0);

  return recentSum < 0 && priorSum > 0;
}
```

### 2.3 config

`SignalScanConfig.preBreakout.trendReversal`（型別 = `TrendReversalConfig`）。
`DEFAULT_SIGNAL_CONFIG.preBreakout.trendReversal = { recentDays: 5, priorDays: 15, minDataDays: 12 }`。
`resolveSignalConfig` 的 `preBreakout` 展開加：

```ts
trendReversal: {
  recentDays: pb?.trendReversal?.recentDays ?? d.preBreakout.trendReversal.recentDays,
  priorDays: pb?.trendReversal?.priorDays ?? d.preBreakout.trendReversal.priorDays,
  minDataDays: pb?.trendReversal?.minDataDays ?? d.preBreakout.trendReversal.minDataDays,
},
```

影響範圍：只加在 `preBreakout` 子物件，`resolveSignalConfig` 手寫展開多 3 行。無巢狀陣列。

### 2.4 `SignalResult` 型別 / 接入點

- **型別不動**（`warnings: string[]` 已存在）。
- **接入點**：eod `preStaged.forEach`（約 L744）+ realtime `preStaged.forEach`（約 L1332）。
  現在每個 setup 列 `warnings: []`（硬編）。改為：

```ts
const warnings: string[] = [];
if (computeTrendReversal(accInputs.get(s.code)?.trustNetBuyNewestFirst ?? [], pb.trendReversal)) {
  warnings.push("trend-reversal");
}
if (computeSingleDayConcentration(  // §5
  accInputs.get(s.code)?.foreignPlusDealerNewestFirst ?? [], pb.concentration,
)) {
  warnings.push("concentration");
}
// ...results.push({ ..., warnings, ... })
```

- **`run-signal-scan.ts` L814 / L1399 的註解「pre-breakout 恆無 warnings（PLAN §4）」刪除**，
  改註「PLAN 8：setup 可帶 trend-reversal / concentration」。

### 2.5 測試案例（`factors.test.ts`，`computeTrendReversal`）

`const TR_CFG = { recentDays: 5, priorDays: 15, minDataDays: 12 };`

1. **序列長度 < minDataDays → false**：`Array(10).fill(1000)` → false。
2. **前段買、近段轉賣 → true**：`[-500,-500,-500,-500,-500, ...15 個 +1000]` → `recentSum < 0 && priorSum > 0` → true。
3. **兩段都在賣（一路賣，不是「轉」）→ false**：`Array(20).fill(-500)` → `priorSum < 0` → false。
4. **兩段都在買（正常累積）→ false**：`Array(20).fill(1000)` → `recentSum > 0` → false。
5. **近段剛好打平（recentSum === 0）→ false**：`[100,-100,50,-50,0, ...15 個 +1000]`（近 5 合計 0）→ `0 < 0` false → false。
6. **前段打平（priorSum === 0）+ 近段賣 → false**：前 15 天正負相抵合計 0 → `0 > 0` false → false。
7. **邊界：序列恰 12 筆（= minDataDays），近 5 賣前 7 買 → true**（priorDays 被序列長度截短仍成立）。

---

## 3. （併入 §2 / §5 —— 無獨立第 3 需求編號，保留章節對齊六項指令）

指令的「需求 3」= `institution-crowded`，在本 PLAN 編為 §4（因 `trend-reversal` §2 之後接
`institution-crowded` 較符合「setup warning → breakout warning」的閱讀順序）。本節留空對齊。

---

## 4. `institution-crowded`（優先度 2）

### 4.1 現況分析

- `computeInstitutionalFlow`（`institutional.ts` L94）已算出 `trustRatio` / `foreignRatio`
  （近 `lookbackDays`(5) 日淨買超合計 ÷ `volumeMa20`）並回傳（PLAN §4.2 中繼值）。
- 目前 `trustRatio + foreignRatio` 只在「突破當日法人淨賣超 → `min(score, sellCapScore)`」用到
  （L158）。沒有「濃度過高」的標記。
- `sellCapScore` 封頂管「法人**已反手**」；`institution-crowded` 管「法人**尚未反手、但濃度已過高**」，互補。

### 4.2 修改函式

**檔案**：`scripts/lib/signal-factors/institutional.ts`。`computeInstitutionalFlow` 回傳型別加一欄：

```ts
): {
  score: number;
  degraded: boolean;
  marginChasing: boolean;
  institutionCrowded: boolean;  // ← PLAN 8 §4：(trustRatio + foreignRatio) > crowdedThreshold。不動 score。
  trustRatio: number;
  foreignRatio: number;
  todayTrustDir: -1 | 0 | 1 | null;
  todayForeignDir: -1 | 0 | 1 | null;
}
```

實作：在函式末尾（`return` 前，`trustRatio` / `foreignRatio` 已算好處）加：

```ts
// PLAN 8 §4：法人濃度過高（近 lookbackDays 日淨買超佔均量比例過大）→ 散戶籌碼淺、體質脆弱。
//   !!! 不動 score !!! 只回布林。用「兩個 ratio 之和」與 sellCapScore 的封頂邏輯同一把尺。
//   degraded 早退分支（volumeMa20 缺 / 近窗不足）已提前 return，該處 institutionCrowded 恆 false。
const institutionCrowded =
  trustRatio + foreignRatio > config.crowdedThreshold;
```

**degraded 早退分支**（L127~L137）也要補 `institutionCrowded: false`（那條 return 的物件加一欄）。

### 4.3 config

`InstitutionalFlowConfig` 加 `crowdedThreshold: number`（頂層，跟 `sellCapScore` 並排）。
`DEFAULT_INSTITUTIONAL_FLOW_CONFIG.crowdedThreshold = 0.8`。
`resolveSignalConfig` 的 `breakout.institutionalFlow` 展開加：

```ts
crowdedThreshold:
  bo?.institutionalFlow?.crowdedThreshold ?? d.breakout.institutionalFlow.crowdedThreshold,
```

影響範圍：`InstitutionalFlowConfig` interface 加 1 欄、`DEFAULT_INSTITUTIONAL_FLOW_CONFIG` 加 1 行、
`resolveSignalConfig` 加 1 行。`factors.test.ts` 的 `DEFAULT_INSTITUTIONAL_FLOW_CONFIG` 深比對測試
（「resolveSignalConfig: 無 override = DEFAULT」）自動涵蓋。

### 4.4 `SignalResult` 型別 / 接入點

- **型別不動**。
- **接入點**：`computeBreakoutFactors`（約 L324）現有：

```ts
const warnings: string[] = [];
if (flow.marginChasing) warnings.push("margin-chasing");
if (flow.institutionCrowded) warnings.push("institution-crowded");  // ← 加這行
```

`warnings` 由 `computeBreakoutFactors` 回傳、breakout `results.push` 帶 `warnings: factors.warnings`（既有），
eod / realtime 兩路徑共用 `computeBreakoutFactors` → 一處改兩路徑生效。

### 4.5 測試案例（`factors.test.ts`，`computeInstitutionalFlow` 的 `institutionCrowded`）

沿用現有 `IF = DEFAULT_INSTITUTIONAL_FLOW_CONFIG`（`crowdedThreshold: 0.8`）。

1. **trustRatio + foreignRatio 遠超 0.8 → true**：投信 5 日合計 = `ma * 0.6`、外資 = `ma * 0.5`
   → sum 1.1 > 0.8 → `institutionCrowded === true`。
2. **sum 剛好 0.8（邊界，用嚴格大於）→ false**：投信 `ma*0.4` + 外資 `ma*0.4` → sum 0.8 → `0.8 > 0.8` false。
3. **sum < 0.8（正常濃度）→ false**：投信 `ma*0.2` + 外資 `ma*0.2` → sum 0.4 → false。
4. **volumeMa20 缺（degraded 早退）→ institutionCrowded false**：`volumeMa20: null` → 早退分支回 false。
5. **法人淨賣超（負 ratio）→ false**：`trustRatio + foreignRatio < 0` → false（濃度是「買方濃度」）。
6. **institutionCrowded === true 時 score 與沒有此判定完全一致**（不動分數）：
   造一組 sum > 0.8 且當日法人淨買超（不觸發 sellCap）的輸入，斷言 `score` 等於手算的
   `trustFlow * 0.6 + foreignFlow * 0.4`（clip 後），且 `institutionCrowded === true`。

---

## 5. `concentration`（優先度 5，改動範圍評估）

### 5.1 現況分析

- `computeOtherInstitutionRatio(foreignPlusDealerNewestFirst, volumeNewestFirst, windowDays, minDaysRatio)`
  （`accumulation.ts` L166）= `sum(外資+自營淨買超) / sum(volume)`，帶正負號。**逐日明細在函式內加總後消失**。
- **但**：`run-signal-scan.ts` 的 `accInputs.get(code)?.foreignPlusDealerNewestFirst` **本身就是完整逐日序列**
  （`fetchAccumulationRawInputs` 產出、新到舊、20 筆），setup 迴圈與 `buildBreakoutPreInst` 都拿得到。
- **改動範圍結論**：**不需要修改 `computeOtherInstitutionRatio` / `computeTrustRawMetrics` 的簽名或呼叫端**。
  新增一個獨立純函式重吃一次 `foreignPlusDealerNewestFirst` 序列即可。指令擔心的「聚合後沒保留明細」
  在本專案結構下不成立（明細一直在 `accInputs`）。→ **改動範圍其實不大**，放最後純粹因為它是第 5 順位需求。

### 5.2 新函式

**檔案**：`scripts/lib/signal-factors/accumulation.ts` 檔尾（`computeTrendReversal` 之後）。

```ts
// ============================================================================
// PLAN 8 §5：computeSingleDayConcentration —— 單日買超集中度（外資+自營）
// ============================================================================
//
// 目的：computeOtherInstitutionRatio 的「20 日合計買超 ÷ 20 日合計量」把「單日爆量買超」
//   跟「分散 20 天穩定買超」算成相近比例。這裡檢查窗內單一交易日買超佔「窗內總正買超」的比例，
//   超過 thresholdRatio → 命中（那波「累積」其實是單日一次性動作）。
//
// 只看外資+自營（config §7 已說明突破當日自營 delta hedging 噪音，但這裡是 20 日窗、非突破當日單日，
//   訊噪比足夠；投信版留待後續，見 PLAN 8 §10 未決事項）。
//
// 分母用「窗內總正買超」（只加 > 0 的日子），不用淨買超合計——避免「有幾天大賣把分母壓到極小
//   → 單日佔比爆衝」的假陽性。窗內總正買超 <= minTotalNetBuy（法人整體沒在買）→ 不判定。
//
// config：concentration.{ thresholdRatio, minWindowDays, minTotalNetBuy }。

export interface ConcentrationConfig {
  thresholdRatio: number;   // 0.5
  minWindowDays: number;    // 10
  minTotalNetBuy: number;   // 0
}

/**
 * seriesNewestFirst：外資+自營淨買超序列，日期新到舊（run-signal-scan 的 accInputs.foreignPlusDealerNewestFirst）。
 * 回傳 true = 命中「單日買超佔窗內總正買超 > thresholdRatio」；資料不足 / 窗內沒在買 / 未命中 → false。
 */
export function computeSingleDayConcentration(
  seriesNewestFirst: number[],
  config: ConcentrationConfig,
): boolean {
  const { thresholdRatio, minWindowDays, minTotalNetBuy } = config;
  if (seriesNewestFirst.length < minWindowDays) return false;

  const positives = seriesNewestFirst.filter((v) => v > 0);
  if (positives.length === 0) return false;

  const totalPositive = positives.reduce((s, v) => s + v, 0);
  if (totalPositive <= minTotalNetBuy) return false;

  const maxSingleDay = Math.max(...positives);
  return maxSingleDay / totalPositive > thresholdRatio;
}
```

### 5.3 config

`SignalScanConfig.preBreakout.concentration`（型別 = `ConcentrationConfig`）。
`DEFAULT_SIGNAL_CONFIG.preBreakout.concentration = { thresholdRatio: 0.5, minWindowDays: 10, minTotalNetBuy: 0 }`。
`resolveSignalConfig` 的 `preBreakout` 展開加 3 行（比照 §2.3）。

### 5.4 `SignalResult` 型別 / 接入點

- **型別不動**。
- **接入點**：同 §2.4（eod / realtime 的 `preStaged.forEach`，跟 `trend-reversal` 並排 push）。

### 5.5 測試案例（`factors.test.ts`，`computeSingleDayConcentration`）

`const CC_CFG = { thresholdRatio: 0.5, minWindowDays: 10, minTotalNetBuy: 0 };`

1. **序列長度 < minWindowDays → false**：`Array(8).fill(1000)` → false。
2. **單日爆量（1 天 8000、其他 19 天各 100）→ true**：`maxSingleDay 8000 / totalPositive ~9900` ≈ 0.81 > 0.5 → true。
3. **分散累積（20 天各 500）→ false**：`500 / 10000` = 0.05 → false。
4. **窗內完全沒買超（全負 / 全 0）→ false**：`Array(20).fill(-500)` → `positives.length === 0` → false。
5. **單日佔比剛好 0.5（用嚴格大於）→ false**：`[1000, 1000]` 補到 10 筆其餘 0 → `1000/2000 = 0.5` → `0.5 > 0.5` false。
6. **有大賣日壓低淨買超但分母用總正買超 → 仍正確**：`[5000, -8000, 1000, 1000, ...6 個 500]`
   → `totalPositive = 5000+1000+1000+3000 = 10000`、`maxSingleDay 5000 / 10000 = 0.5` → false（驗證分母不受賣日影響）。
7. **單日佔比 0.6 + 有賣日 → true**：`[7000, -3000, 1000, ...8 個 500]` → `totalPositive ~12000`、`7000/12000 ≈ 0.58` → true。

---

## 6. `instBackground`（優先度 3，中性背景欄位）

### 6.1 現況分析與型別新增

- 突破階段 `computeInstitutionalFlow` 只看近 `lookbackDays`(5) 天，無「這波法人早佈局 vs 剛進場」的背景。
- 兩種情境對突破品質解讀甚至相反（早佈局 = 有備而來 / 剛進場 = 追突破），所以**是中性資訊、不是風險**
  → 不能塞 `warnings`（會被誤讀成警訊）→ 新增獨立欄位。

**`run-signal-scan.ts` 型別新增**：

```ts
export type InstBackground = "positioned-early" | "fresh-entry";
// SignalResult 加：
export interface SignalResult {
  // ...
  // PLAN 8 §6：突破階段法人背景（中性，非風險）。只在 breakoutDay / extended 帶；資料不足 → 省略（undefined）。
  instBackground?: InstBackground;
}
```

分類：
- `"positioned-early"` = 前 15 日**也**在買（前段淨買超為正）→ 過去 20 日持續佈局。
- `"fresh-entry"` = 前 15 日幾乎無動作（前段淨買超 ÷ volumeMa20 絕對值 ≤ `activityEpsilon`）**且**近 5 日在買。
- 其他（前段在賣 / 近段沒買 / 資料不足）→ `undefined`（欄位不帶），前端不渲染。

### 6.2 資料撈取評估（關鍵）

- **不需要延伸 `fetchInstitutionalFlowInputs` 的 `lookbackDays`**，也不用另開查詢。
- **PLAN 7 已對 breakout 階段那 ~20 檔撈了 `accInputs`**（`fetchAccumulationRawInputs`，
  code 清單 = `[...preCodes, ...breakoutCodes]`），`accInputs.get(code).trustNetBuyNewestFirst` 與
  `.foreignPlusDealerNewestFirst` 都是 20 日窗、新到舊。`buildBreakoutPreInst` 正在用。
- `classifyInstBackground` 直接吃 `accInputs.get(s.code)?.trustNetBuyNewestFirst`（或
  `foreignPlusDealerNewestFirst`，看要「投信背景」還是「三大法人背景」——**建議用投信**，跟 setup 的
  `trustScore` 主因子一致，且突破階段 `institutionalFlow` 的 `trustWeight`(0.6) > `foreignWeight`) →
  **零額外查詢**。
- `volumeMa20` 從 `s.volumeMa20`（staged 每檔已帶）取，`activityEpsilon` 判定用。

### 6.3 新函式

**檔案**：`scripts/lib/signal-factors/institutional.ts`。

```ts
// ============================================================================
// PLAN 8 §6：classifyInstBackground —— 突破階段法人背景（中性分類，非風險）
// ============================================================================
//
// 比較近 recentDays 日 vs 前 priorDays 日投信淨買超方向（合計仍是 recentDays + priorDays 日窗）：
//   positioned-early：前段淨買超 > 0（過去 20 日持續佈局，有備而來）
//   fresh-entry     ：前段「淨買超 ÷ volumeMa20」絕對值 <= activityEpsilon（前段沒動作）且近段 > 0（剛進場追突破）
//   其他 / 資料不足  ：null（前端不渲染）
// 純中性背景資訊，不進 warnings、不動 score。

export interface InstBackgroundConfig {
  recentDays: number;       // 5
  priorDays: number;        // 15
  activityEpsilon: number;  // 0.02
  minDataDays: number;      // 12
}

export function classifyInstBackground(
  trustNetBuyNewestFirst: number[],
  volumeMa20: number | null,
  config: InstBackgroundConfig,
): "positioned-early" | "fresh-entry" | null {
  const { recentDays, priorDays, activityEpsilon, minDataDays } = config;
  const n = trustNetBuyNewestFirst.length;
  if (n < minDataDays || volumeMa20 === null || volumeMa20 <= 0) return null;

  const recent = trustNetBuyNewestFirst.slice(0, recentDays);
  const prior = trustNetBuyNewestFirst.slice(recentDays, recentDays + priorDays);
  if (recent.length === 0 || prior.length === 0) return null;

  const recentSum = recent.reduce((s, v) => s + v, 0);
  const priorSum = prior.reduce((s, v) => s + v, 0);
  const priorActivity = Math.abs(priorSum) / volumeMa20;

  if (priorSum > 0) return "positioned-early";
  if (priorActivity <= activityEpsilon && recentSum > 0) return "fresh-entry";
  return null;
}
```

（註：`positioned-early` 判定放在 `fresh-entry` 之前——前段在買就算早佈局，不管前段活躍度。）

### 6.4 config + 前端 label

- `SignalScanConfig.breakout.institutionalFlow.background`（型別 = `InstBackgroundConfig`）。
  `DEFAULT`：`{ recentDays: 5, priorDays: 15, activityEpsilon: 0.02, minDataDays: 12 }`。
  `resolveSignalConfig` 的 `breakout.institutionalFlow` 展開加巢狀 `background: { ...4 行 ... }`
  （比照 `marginChasing` 子物件的展開寫法）。
- **`components/signal/labels.ts`**：

```ts
export const INST_BACKGROUND_LABELS: Record<"positioned-early" | "fresh-entry", { text: string; hint: string }> = {
  "positioned-early": { text: "法人早佈局", hint: "過去 20 日投信持續買超，突破前已進場" },
  "fresh-entry": { text: "法人剛進場", hint: "前 15 日投信無明顯動作，近 5 日才買進、追突破" },
};
```

### 6.5 測試案例（`factors.test.ts`，`classifyInstBackground`）

`const BG_CFG = { recentDays: 5, priorDays: 15, activityEpsilon: 0.02, minDataDays: 12 }; const MA = 1_000_000;`

1. **資料不足（< minDataDays）→ null**：`Array(10).fill(1000)` → null。
2. **volumeMa20 缺 → null**：`Array(20).fill(1000)`, `volumeMa20: null` → null。
3. **前段在買 → positioned-early**：`Array(20).fill(5000)` → `priorSum > 0` → `"positioned-early"`。
4. **前段幾乎無動作 + 近段在買 → fresh-entry**：`[...5 個 +8000, ...15 個 0]`（priorSum 0）→ `priorActivity 0 <= 0.02 && recentSum > 0` → `"fresh-entry"`。
5. **前段小賣（活動高於 epsilon）+ 近段買 → null**：`[...5 個 +8000, ...15 個 -3000]`
   → `priorSum -45000`，`priorActivity 0.045 > 0.02`，`priorSum` 不 > 0 → null。
6. **前段無動作但近段也沒買 → null**：`[...5 個 -1000, ...15 個 0]` → `recentSum < 0` → null。
7. **前段活動剛好 = epsilon（邊界，用 <=）→ fresh-entry**：造 `priorActivity` 恰 0.02 + 近段買 → `"fresh-entry"`。

### 6.6 接入點

eod breakout `results.push`（約 L861）+ realtime（約 L1454）：

```ts
const bg = classifyInstBackground(
  accInputs.get(s.code)?.trustNetBuyNewestFirst ?? [],
  s.volumeMa20 ?? null,
  b.institutionalFlow.background,
);
results.push({
  // ...現有...
  ...(bg ? { instBackground: bg } : {}),
});
```

（用 spread + 條件——`bg` 為 null 時欄位不帶，跟 `fromWatchlist` 同模式。）

---

## 7. 補設計理由註解：突破階段不看自營商（純文件）

**檔案**：`scripts/lib/signal-factors/institutional.ts`，`InstitutionalFlowConfig` interface 上方
（約 L74 前）補一段：

```ts
// ============================================================================
// 【設計：突破階段的 institutionalFlow 刻意只採「投信 + 外資」，排除自營商】
//
// 醞釀階段（accumulation.ts 的 computeOtherInstitutionRatio）用「外資 + 自營」是 20 日窗、看長期累積，
// 自營的方向雜訊會被時間拉長攤平。
//
// 但突破階段 computeInstitutionalFlow 是 lookbackDays(5) 短窗、且要判「突破當日」單日方向——
// 自營商當日買賣有大量「避險性交易」（發行權證 / 選擇權後的 delta hedging），跟「看多這檔股票」
// 無關卻會灌進淨買賣超數字。5 日短窗下這種噪音佔比過高、訊噪比不足，會讓「今日方向」判定失真。
// 故突破階段只採 trust(投信) + foreign(外資) 兩者。
//
// ⚠ 不要為了「跟醞釀階段對稱」而把自營加回來——兩個階段的窗長與判定目的不同，對稱不是目標。
// （PLAN 8 §7）
// ============================================================================
```

無程式碼改動。

---

## 8. 標籤系統統一管理

### 8.1 `WARNING_LABELS` 中央清單

**檔案**：`components/signal/labels.ts`。

```ts
import type { Tone } from "./InstitutionalFlowPanel"; // 或把 Tone 定義搬來這裡（見下）

export type WarningKey =
  | "margin-chasing"
  | "trend-reversal"
  | "concentration"
  | "institution-crowded";

/**
 * warnings 中央清單（PLAN 8 §8.1）。
 *   title   —— chip / banner 的短標題
 *   detail  —— banner 大區塊的一句說明（給使用者看的意義）
 *   trigger —— 觸發條件白話（給開發者 / 未來的自己看，說明「什麼情況會亮這個」）
 *   tone    —— 顏色語意（destructive 紅 = 較確定的風險；warning 琥珀 = 值得注意）
 * 所有頁面（SignalDetail / ScreeningPanel / WatchlistCard）渲染 warning 都查這個 map。
 * 門檻值本身在 scripts/lib/signal-factors/config.ts 的 SignalScanConfig（首版未校準，見 PLAN 8 §10）。
 */
export const WARNING_LABELS: Record<WarningKey, {
  title: string;
  detail: string;
  trigger: string;
  tone: Tone;
}> = {
  "margin-chasing": {
    title: "融資追價",
    detail: "突破當日三大法人（投信＋外資）淨賣超，且本檔融資餘額近期增速排在自己歷史前 20%——散戶追價、法人可能在派發。系統僅標記，未調整分數。",
    trigger: "breakoutDay/extended 階段 · 突破當日投信+外資淨賣超 · computeMarginSurgePercentile > surgePercentileThreshold(80)",
    tone: "destructive",
  },
  "trend-reversal": {
    title: "近期轉賣",
    detail: "投信在前 15 個交易日淨買超為正、但最近 5 個交易日轉為淨賣——20 日總量看起來仍在累積，實際上近期已在出貨，疑似假突破誘多。",
    trigger: "setup 階段 · 投信近 5 日淨買超合計 < 0 且 前 15 日淨買超合計 > 0（computeTrendReversal）",
    tone: "destructive",
  },
  "concentration": {
    title: "單日爆量",
    detail: "近 20 個交易日外資＋自營的買超，超過一半集中在單一交易日——那波「法人累積」其實是一次性動作，不是穩定進場。",
    trigger: "setup 階段 · 窗內單一交易日買超 ÷ 窗內總正買超 > thresholdRatio(0.5)（computeSingleDayConcentration，只看外資+自營）",
    tone: "warning",
  },
  "institution-crowded": {
    title: "法人擁擠",
    detail: "近 5 個交易日投信＋外資的淨買超合計，佔 20 日均量的比例過高——法人籌碼濃度大、散戶浮額少，一旦法人反手賣壓會很急。此時尚未反手，僅為體質提示。",
    trigger: "breakoutDay/extended 階段 · (trustRatio + foreignRatio) > crowdedThreshold(0.8)（computeInstitutionalFlow）",
    tone: "warning",
  },
};
```

**`Tone` 型別歸屬**：目前定義在 `InstitutionalFlowPanel.tsx`。`labels.ts` 是純常數檔、被兩頁 import，
不宜反過來 import 元件。**方案**：把 `export type Tone` + `TONE_CHIP` 常數搬到 `labels.ts`，
`InstitutionalFlowPanel.tsx` 改成 `export { Tone, TONE_CHIP } from "./labels"`（re-export，既有 import 路徑不炸）。
`pre-breakout-chip.ts` 的 `import type { Tone } from "./InstitutionalFlowPanel"` 仍可用。

### 8.2 `CHIP_LABELS` + chip 函式註解

**目標**：chip 文字不再是散在 `resolveInstChip` / `resolvePreBreakoutChip` 裡的字串 literal，
收進 `labels.ts` 常數；每個分支補「觸發條件 + 意義」註解。**函式的分支結構不改**（if/else 判斷邏輯不動）。

`components/signal/labels.ts`：

```ts
/** 突破階段結論 chip（resolveInstChip 用）。key = 語意代號，非顯示順序。 */
export const INST_CHIP = {
  noData:          { text: "籌碼資料不足", tone: "muted" as Tone },
  recentBullPend:  { text: "近期偏多・今日未定", tone: "muted" as Tone },
  recentBearPend:  { text: "近期偏空・今日未定", tone: "muted" as Tone },
  recentFlatPend:  { text: "近期中性・今日未定", tone: "muted" as Tone },
  allInBuy:        { text: "法人同步進場", tone: "success" as Tone },
  keepBuy:         { text: "法人續買", tone: "success" as Tone },
  splitBull:       { text: "法人分歧偏多", tone: "warning" as Tone },
  marginChaseStrong:{ text: "融資追價警示", tone: "destructive" as Tone },
  marginChaseWeak: { text: "法人撤出＋融資追價", tone: "destructive" as Tone },
  flipToday:       { text: "近期強・今日翻臉", tone: "warning" as Tone },
  allOut:          { text: "法人同步撤出", tone: "destructive" as Tone },
  crowded:         { text: "法人擁擠", tone: "warning" as Tone },       // ← PLAN 8 §4 新增
  recentBullFlat:  { text: "近期偏多・今日持平", tone: "muted" as Tone },
  recentBearFlat:  { text: "近期偏空・今日持平", tone: "muted" as Tone },
} as const;

/** 醞釀階段結論 chip（resolvePreBreakoutChip 用）。 */
export const PRE_CHIP = {
  noData:          { text: "籌碼資料不足", tone: "muted" as Tone },
  trendReversal:   { text: "投信近期轉賣", tone: "destructive" as Tone },  // ← PLAN 8 §2
  concentration:   { text: "外資單日爆量", tone: "warning" as Tone },      // ← PLAN 8 §5
  trustStreakOnly: { text: "投信近期連續買", tone: "success" as Tone },
  trustSplitOnly:  { text: "投信買盤分散", tone: "muted" as Tone },
  trustHeavyStreak:{ text: "投信持續進場", tone: "success" as Tone },
  trustHeavySplit: { text: "投信分散布局", tone: "success" as Tone },
  bothBull:        { text: "法人合力偏多", tone: "success" as Tone },
  trustMildBull:   { text: "投信小幅偏多", tone: "warning" as Tone },
  otherBullNoTrust:{ text: "外資自營偏多・投信未跟", tone: "warning" as Tone },
  noSetup:         { text: "籌碼尚無明顯佈局", tone: "muted" as Tone },
  neutral:         { text: "籌碼中性", tone: "muted" as Tone },
} as const;
```

`resolveInstChip()` / `resolvePreBreakoutChip()` 改成 `return INST_CHIP.allInBuy;` 這種，
且每個 `return` 上方一行註解，例如：

```ts
// 近 5 日強(ratioSum>0.3) + 今日買 → 法人火力集中，最強的偏多訊號
if (strong) return INST_CHIP.allInBuy;
```

```ts
// trustScore 40~69（中等）+ otherInstScore>=70（外資自營強）→ 兩邊合力，偏多
if (other >= 70) return PRE_CHIP.bothBull;
```

**chip 函式的新分支**（PLAN 8 新標籤）：
- `resolveInstChip(inst, warnings)`：函式最前面加
  `if (warnings.includes("institution-crowded")) return INST_CHIP.crowded;`
  （放在 `noData` 檢查之後、其他判斷之前——濃度提示優先於一般流向結論；但 `margin-chasing` 相關的
  `destructive` chip 仍優先於 `crowded`，所以順序是 noData → marginChasing 分支 → crowded → 一般流向。
  實作時確認：現有 `marginChasing` 只在 `selling` 分支內判定，`crowded` 要獨立前置檢查）。
- `resolvePreBreakoutChip(preInst, warnings)`：函式最前面（`noData` 之後）加
  `if (warnings.includes("trend-reversal")) return PRE_CHIP.trendReversal;`
  `if (warnings.includes("concentration")) return PRE_CHIP.concentration;`

### 8.3 `WarningBanner` 元件

**檔案**：`components/signal/WarningBanner.tsx`（新）。

```tsx
import { WARNING_LABELS, type WarningKey } from "./labels";
import { cn } from "../../lib/cn";

const BANNER_CLASS: Record<string, string> = {
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-warning/30 bg-warning/10 text-warning",
  success: "border-success/30 bg-success/10 text-success",
  muted: "border-border bg-muted text-muted-foreground",
};

/** 命中的 warnings 逐條渲染成提示框（PLAN 8 §8.3）。screening 展開列 + watchlist 卡片共用。 */
export function WarningBanner({ warnings }: { warnings: string[] }) {
  const hits = warnings.filter((w): w is WarningKey => w in WARNING_LABELS);
  if (hits.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {hits.map((key) => {
        const { title, detail, tone } = WARNING_LABELS[key];
        return (
          <div key={key} className={cn("rounded border p-2 text-xs", BANNER_CLASS[tone])}>
            ⚠ {title}：{detail}
          </div>
        );
      })}
    </div>
  );
}
```

### 8.4 前端接入點彙整

| 檔案 | 改動 |
|---|---|
| `components/screening/SignalDetail.tsx` | L23~L28 寫死 `margin-chasing` 框 → `<WarningBanner warnings={row.warnings} />`；breakout 分支 `InstitutionalFlowPanel` 下加 `instBackground` 一行小灰字（查 `INST_BACKGROUND_LABELS`，`row.instBackground` 有值才渲染） |
| `components/screening/ScreeningPanel.tsx` | `instCell()`：`marginChasing` 比對改用 `WARNING_LABELS`；setup 列 `r.warnings.length > 0` → 顯示 warning chip（原本 `if (!r.inst) return "—"`）；chip 文字引用 `WARNING_LABELS[key].title` |
| `components/watchlist/WatchlistCard.tsx` | `chip` 兩個 `resolve*Chip` 傳 `row.warnings`（現傳 `[]`）；走勢圖下 + 法人區塊上加 `<WarningBanner warnings={row.warnings} />`；breakout 卡片法人區塊下加 `instBackground` 一行 |
| `components/signal/InstitutionalFlowPanel.tsx` | `resolveInstChip` 加 `crowded` 前置分支 + 分支註解 + 引用 `INST_CHIP`；`Tone`/`TONE_CHIP` 搬到 `labels.ts` 後 re-export |
| `components/signal/pre-breakout-chip.ts` | `resolvePreBreakoutChip` 簽名加 `warnings` + `trendReversal`/`concentration` 前置分支 + 分支註解 + 引用 `PRE_CHIP` |

---

## 9. 明確排除範圍（本 PLAN 不處理）

- **重手版**：用修正係數真的打折 `trustScore` / `chipScore` / `institutionalFlow.score`。本次只做 warnings / 中性欄位。
- **外資 / 自營商的 `buyFrequency` 指標**：前次討論已決定用 `concentration` 警訊取代這個方向。
- **歷史回測驗證各門檻值**：門檻先用經驗建議（§10 明列），回測是後續獨立工作。
- **投信版 `concentration`**：本次 `concentration` 只做外資+自營（使用者指定）。投信版留待後續（§10）。
- **加嚴 setup gate / setup 底排加突破因子 / 進度條改視覺**：PLAN 7 已列為獨立優化，本 PLAN 不碰。

---

## 10. 驗收條件

### 10.1 不動分數（硬性）

- `pnpm exec tsc --noEmit` 乾淨。
- `pnpm tsx --test scripts/lib/signal-factors/factors.test.ts`：**既有全部案例（約 40 案）分數斷言完全不變**
  + 新增案例（`computeTrendReversal` 7 + `institutionCrowded` 6 + `computeSingleDayConcentration` 7
  + `classifyInstBackground` 7 ≈ 27 案）全過。
- `git stash`（存起本 PLAN 改動）→ `pnpm tsx scripts/screening/run-signal-scan.ts --date=<最近交易日>` 存 A →
  `git stash pop` → 同指令存 B → **逐檔 diff**：
  - `results[].totalScore` A == B（每一檔，浮點容差 0）。
  - `results[].scores.*` A == B。
  - `results[].rank` / `results[].stage` A == B。
  - `stats.{preBreakout,breakoutDay,extended,passedGate,...}` A == B。
  - 唯一允許的差異：B 的 setup 列 `warnings` 可能非空（`trend-reversal` / `concentration`）；
    B 的 breakout 列可能多 `instBackground` 欄、`warnings` 可能多 `institution-crowded`。

### 10.2 新標籤產出正確

- `data/signal-scan-results/<date>.json`：
  - 抽幾檔 setup，手動用序列驗證 `trend-reversal`（前 15 買、近 5 賣）/ `concentration`（單日 > 50%）判定正確。
  - 抽幾檔 breakout，驗證 `institution-crowded`（ratio 和 > 0.8）/ `instBackground` 分類正確。
  - 全部 setup 的 `warnings` 型別仍是 `string[]`（不是 undefined）。

### 10.3 前端呈現（curl / 使用者確認）

- `/screening`：
  - setup 展開列若命中 `trend-reversal` → 頂部紅框；表格「籌碼」欄顯示「近期轉賣」紅 chip（原本 setup 是 `—`）。
  - breakout 展開列命中 `institution-crowded` → 頂部琥珀框 + 法人區塊 chip 轉琥珀「法人擁擠」；
    法人區塊下方一行「法人早佈局 / 法人剛進場」小灰字。
  - 既有 `margin-chasing` 呈現不回歸（改走 `WarningBanner` 後文字 / 顏色一致）。
- `/watchlist`：
  - 醞釀卡片命中 `trend-reversal` → 走勢圖下方紅框 + 標頭 chip 轉「投信近期轉賣」。
  - 突破卡片命中 `institution-crowded` → 走勢圖下方琥珀框 + 法人區塊下「法人早佈局 / 剛進場」一行。
  - 未命中的卡片：無 banner、chip 與改動前一致（無回歸）。

### 10.4 標籤系統管理可讀性

- `components/signal/labels.ts` 一個檔看得到：4 個 warning 的 title / detail / trigger / tone；
  兩階段所有 chip 的文字 + tone。
- `resolveInstChip` / `resolvePreBreakoutChip` 每個 `return` 上方有觸發條件註解。

---

## 11. 實作順序建議

依「資料現成、改動小、風險低」排（＝指令建議順序）：

1. **`WARNING_LABELS` / `CHIP_LABELS` / `Tone` 搬遷 + chip 函式註解**（§8）——純前端重構，不碰計算。
   先做這個，後面加標籤時直接往清單裡塞。commit 1。
2. **`trend-reversal`**（§2）——純函式 + config + test + 接入 `preStaged.forEach`。資料現成（`accInputs`）。
3. **`institution-crowded`**（§4）——`computeInstitutionalFlow` 加一個回傳布林 + config + test。改動最集中。
4. **`instBackground`**（§6）——新函式 + 新型別 + config + test + 接入 breakout push。複用 PLAN 7 的 `accInputs`。
5. **自營商設計理由註解**（§7）——純文件。
6. **`concentration`**（§5）——純函式 + config + test + 接入。放最後（第 5 順位需求；改動範圍評估已確認不大）。
7. **前端呈現**（§8.3 `WarningBanner` + §8.4 各頁接入 + `instBackground` 顯示）——把 2~6 的產出接到 UI。
8. **`lib/actions/watchlist.ts`**（`WatchlistCardRow` 加 `warnings` / `instBackground`，從 `resultByCode` 帶）。

Commit 切分建議：
- **commit 1**：§8 標籤系統統一管理（`labels.ts` 清單 + chip 函式重構 + 註解）——純重構，行為不變。
- **commit 2**：`signal-factors/` 四個純函式 + config 欄位 + `factors.test.ts`（§2/§4/§5/§6/§7）——不動分數。
- **commit 3**：`run-signal-scan.ts` 接入 + `SignalResult.instBackground` 型別 + JSON 產出驗證。
- **commit 4**：前端呈現（`WarningBanner` + 各頁 + `instBackground` 顯示 + `watchlist.ts` 帶欄位）。

---

## 12. 風險與回退

| 風險 | 說明 | 對策 |
|---|---|---|
| `totalScore` 意外變動 | `computeInstitutionalFlow` 加回傳欄時不小心動到 score 分支 | §10.1 逐檔 diff；新欄位只在 `return` 物件加一個 key，score 計算行不碰；`factors.test.ts` 既有「不動分數」案例（L237、L255…）守住 |
| setup 首次有 warnings 打破前端假設 | 某處前端假設 `stage==="setup"` 的 `warnings` 一定空（如 `SignalDetail` setup 分支不渲染 banner） | §8.4 明列 setup 分支也要接 `WarningBanner`；`ScreeningPanel.instCell` setup 列加 warning chip 分支；grep `stage === "setup"` 全掃一遍 |
| `Tone` / `TONE_CHIP` 搬遷造成 import 斷裂 | 多處 `import { Tone } from "./InstitutionalFlowPanel"` | 搬到 `labels.ts` 後在 `InstitutionalFlowPanel.tsx` re-export（`export { Tone, TONE_CHIP } from "./labels"`），既有路徑不炸；tsc 驗證 |
| 門檻值未校準 → 誤報 / 漏報過多 | 所有預設值是拍腦袋（§10 待確認） | 全走 config，可事後 `resolveSignalConfig` override 調；輕手版本來就只標記不動分數，誤報的代價是「多一個提示框」不是「排名錯亂」 |
| `concentration` 分母選擇爭議 | 用「窗內總正買超」而非「淨買超合計」 | §5.2 註解寫明理由（避免賣日壓低分母造成假陽性）；test case 6 專門驗證這點 |
| `instBackground` 用投信還是三大法人 | §6.2 建議投信（跟 setup 主因子一致） | PLAN 定案用投信；若實盤覺得該看三大法人，改 `classifyInstBackground` 的入參一行、不影響結構 |

**回退**：純計算 + 前端，無 migration。`git revert` commit 2~4 即復原計算與 UI；commit 1（標籤重構）
可獨立保留（行為等價）。`data/signal-scan-results/*.json` 重跑一次掃描即回舊格式
（setup 無 warnings、breakout 無 `institution-crowded` / `instBackground`）。

---

## 13. 對 CLAUDE.md / docs 的後續更新（實作完成後）

- **CLAUDE.md**
  - `MarginTrading` 條 / `signal-factors` 段：`institutional.ts` 除 `marginChasing` 外新增
    `institutionCrowded` 回傳欄 + `classifyInstBackground`；`accumulation.ts` 新增 `computeTrendReversal` /
    `computeSingleDayConcentration`。
  - `SignalResult` 段：新增 `instBackground?: "positioned-early" | "fresh-entry"`（中性背景，非 warnings）；
    `warnings` 現在 setup 階段也可能非空（`trend-reversal` / `concentration`），breakout 多 `institution-crowded`。
    刪掉「setup 恆 `[]`」的敘述。
  - `components/signal/` 段：`labels.ts` 新增 `WARNING_LABELS`（warnings 中央清單，含 trigger 註解）/
    `INST_CHIP` / `PRE_CHIP`（chip 文字常數化）/ `INST_BACKGROUND_LABELS`；`Tone` / `TONE_CHIP` 移到 `labels.ts`；
    新元件 `WarningBanner.tsx`（screening 展開列 + watchlist 卡片共用）。
  - `/watchlist` 段 / `/screening` 段：卡片 / 展開列新增 warning 提示框（`WarningBanner`）與
    `instBackground` 一行；`WatchlistCardRow` 加 `warnings` / `instBackground` 欄。
  - `config.ts` 段：`SignalScanConfig` 新增 `preBreakout.trendReversal` / `preBreakout.concentration` /
    `breakout.institutionalFlow.crowdedThreshold` / `breakout.institutionalFlow.background`。
- **docs/PROGRESS.md**：新增「PLAN 8：籌碼面觀察標籤 + 標籤系統統一管理」段，記實測
  （逐檔 `totalScore` diff = 0、各標籤觸發樣本、`factors.test.ts` 案例數）。
- **docs/ROADMAP.md**：新增 `## 9.` 段（第 8 節是 PLAN 7），打勾式清單列本 PLAN 五項需求 + 標籤系統統一管理。
- **README.md**：檢查「目前功能」是否要提及籌碼面風險標籤；`scripts/` 結構無變動（不新增腳本）。

---

## 14. 未決事項 / 待確認

以下參數目前全是**經驗建議、未經專案自己的歷史資料回測校準**，PLAN 定案先用建議值，
標注「待累積實盤資料 / 回測後再定案」：

| 項目 | 建議值 | 待確認點 |
|---|---|---|
| `trendReversal.recentDays` / `priorDays` | 5 / 15 | 切分點是否 5/15 最能分辨「轉賣」；要不要用 recentDays 淨買超**斜率**而非只看正負號 |
| `trendReversal.minDataDays` | 12 | 資料不足門檻 |
| `concentration.thresholdRatio` | 0.5 | 單日佔比 > 50% 算不算太寬鬆 / 嚴格 |
| `concentration` 分母 | 窗內總正買超 | 是否該用「淨買超合計」或「總成交量」 |
| `concentration` 是否也做投信版 | 本次只做外資+自營 | 投信版留後續，或這次一起（純函式重用、成本近零） |
| `institutionalFlow.crowdedThreshold` | 0.8 | `trustRatio + foreignRatio` > 0.8 的「過高」界線 |
| `instBackground.activityEpsilon` | 0.02 | 「前段無動作」的活躍度上限（前段淨買超 ÷ volumeMa20） |
| `instBackground` 用投信 vs 三大法人序列 | 投信 | §6.2 建議投信；實盤觀察後可改 |
| 四個標籤要不要真的影響分數 | 本次一律不影響 | 累積樣本後獨立回測評估，屆時另開 PLAN（重手版） |
| chip 新分支的優先序 | crowded 在一般流向之前、marginChasing 之後 | 實際看到多標籤同時命中的卡片後可能要調 |
