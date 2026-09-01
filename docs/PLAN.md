# PLAN：Screening 頁表格 UI 改版

`/screening` 結果表格重畫：tab 收斂成三階段、欄位比照設計圖、展開列改成「線圖 / 法人籌碼 /
突破因子」三欄。法人籌碼與突破因子的呈現規格（長條長度對齊公式量尺、chip 組合表、數字語意）
定義在 `docs/UI.md`，**本計劃完成後 `docs/UI.md` 併入 `docs/PROGRESS.md` 對應段落後刪除**
（規格已落實成程式碼 + PROGRESS 紀錄，不再需要獨立規格檔）。

這份是單一任務的實作規格書，做完即被下一份 PLAN 取代；穩定知識回寫 `CLAUDE.md`，
過程紀錄回寫 `docs/PROGRESS.md`。

**分支**：`feat/screening-ui`（已從 `main` 開）。merge 時機等使用者發話。

---

## 0. 邊界

**動：**

- `components/screening/ScreeningPanel.tsx`：tab、欄位、排序邏輯、`RowGroup`。
- `components/screening/`：新增展開列子元件 3 支（`SignalDetail` / `InstitutionalFlow` / `BreakoutFactorBars`）。
- `components/ui/Sparkline.tsx`：新檔，從 `WatchlistPerfTable.tsx` 抽出的純 SVG 走勢圖。
- `lib/spark-series.ts`：新檔，`buildSparkSeries()` 純函式（`dashboard.ts` 現有 inline 邏輯抽出）。
- `lib/actions/signal-scan.ts`：新增 `getSignalSpark(code)` action、`SignalScanView` 型別隨後端擴充。
- `scripts/screening/run-signal-scan.ts`：`SignalResult` 加欄位（`volumeRatio` / `inst` / `factors`），只在
  breakout-day / extended 有值。**不動評分邏輯、不動階段判定、不動 gate。**
- `scripts/lib/signal-factors/institutional.ts`：`computeInstitutionalFlow` 回傳擴充（多回已算好的中繼值）。
- `scripts/lib/signal-factors/breakout.ts`：`computeProximityToHigh` 回傳擴充（短/長窗分數與原始 % 分開回）。
- `scripts/lib/signal-factors/factors.test.ts`：補新回傳值的 assertion。
- `components/dashboard/WatchlistPerfTable.tsx` / `lib/actions/dashboard.ts`：改 import（用抽出的
  `Sparkline` / `buildSparkSeries`），行為不變。

**不動：**

- 任何評分公式、權重、曲線、gate 門檻、階段判定（`consecutiveAboveBand`）。
- Prisma schema、migration。
- `SignalScanOutput` 的 `stats` / `warnings` 結構。
- realtime 背景任務機制（spawn / progress.json / 輪詢）。
- `docs/UI.md` 的規格內容本身（照它實作；本計劃收尾才刪檔）。

---

## 1. Tab（第 1 點需求）

- 移除「全部」tab。
- 剩三個，順序固定：**今日突破 → 已延伸 → 醞釀中**（`breakout-day` / `extended` / `pre-breakout`）。
- 預設選中「今日突破」。
- `StageFilter` 型別去掉 `"all"`，直接 = `SignalStage`。
- 連帶清掉只為「全部」存在的邏輯：
  - `sortedRows` 裡 `sortKey === "rank"` 時的 `b.totalScore - a.totalScore` 次要排序。
  - 「全部檢視：排名為各階段內名次…不可直接比較」提示段。
  - `toggleSort` 裡 `key === "totalScore"` 預設降冪的特例可留（純表格排序偏好，無害）。
- 每個 tab 內單一階段，`rank` 是該階段內名次，預設 `sortKey="rank"` / `sortDir="asc"`。
- tab count badge 維持（`（12）`）。

---

## 2. 表格欄位（第 2 點需求，比照設計圖）

由左到右（checkbox 欄不算）：

| 欄位 | key | 內容 | 資料來源 | 對齊 |
|---|---|---|---|---|
| 排名 | `rank` | `r.rank` | 既有 | 右 |
| 代號 | `code` | `r.code` | 既有 | 左 |
| 名稱 | `name` | `r.name` | 既有 | 左 |
| 價格 | `close` | `r.close.toFixed(2)`；`priceSource==="estimated"` 尾隨琥珀「估」badge（`bg-warning/10 text-warning`） | 既有 | 右 |
| 漲跌% | `changePercent` | `r.changePercent.toFixed(2)`（**百分比**，不是點數），漲紅跌綠（`text-up`/`text-down`）；設計圖 `+5.55` 讀作 `+5.55%` | 既有 | 右 |
| 狀態 | `stage` | 階段中文 pill，底色分級（見下） | `r.stage` | 左 |
| 量增 | `volumeRatio` | `x{r.volumeRatio.toFixed(1)}`（如 `x2.5`）；**醞釀中階段顯示 `—`**（該欄後端為 `undefined`） | **新增**（見 §4） | 右 |
| 籌碼 | `inst` | 一句話結論 chip（UI.md 1.4 組合表）＋ 盤中沿用昨日籌碼時附「昨」小 badge | **新增**（見 §4）；醞釀中顯示 `—` | 左 |
| 總分 | `totalScore` | `r.totalScore.toFixed(1)` | 既有 | 右 |

- 移除舊「收盤/即時」欄名 → 改叫「價格」。
- 移除舊「降級項目」獨立欄。`degraded` 資訊移到展開列（維持現有展開列裡的呈現）。
- 舊「追」badge（`warnings.includes("margin-chasing")`）：從「價格」欄移出，改掛在「籌碼」chip 上
  （UI.md 1.4：marginChasing 情境的 chip 本身就是紅色「融資追價警示」）。展開列紅框提示維持。
- `estimated` 列淡色（`text-muted-foreground`）維持。

### 狀態 pill 底色（使用者已定）

| stage | 文字 | class |
|---|---|---|
| `breakout-day` | 今日突破 | `bg-destructive/10 text-destructive` |
| `extended` | 已延伸 | `bg-warning/10 text-warning` |
| `pre-breakout` | 醞釀中 | `bg-muted text-muted-foreground` |

複用狀態語意 token（同大盤號誌燈那組），符合 CLAUDE.md「元件不直接寫色階數字」。

### 排序

- 每欄仍可點擊排序（`toggleSort`）。
- `inst`（籌碼）欄不可排序（chip 是分類不是量）——`Column` 加 `sortable?: boolean`，`false` 時 th 不掛 onClick、不顯箭頭。
- `volumeRatio` 欄排序：醞釀中 tab 全 `—`，該 tab 下點它無效果（值都 undefined），可接受。

---

## 3. 展開列（第 3 點需求）

`RowGroup` 展開時渲染 `<SignalDetail row={r} />`（原 `Detail` function 搬進新檔
`components/screening/SignalDetail.tsx`，`ScreeningPanel.tsx` 已 640 行）。

### 3.0 依 stage 分支（第 F 點：醞釀中只有線圖）

```
SignalDetail:
  頂部：margin-chasing 紅框（若 warnings 含）、estimated 琥珀框（若 estimated）—— 維持現有
  if stage === "pre-breakout":
     只渲染 <SignalSparkPanel code={row.code} />（左側線圖）
     不渲染法人 / 突破因子
     不渲染舊「評分明細 / 原始指標」網格   ← 使用者要「只有左側線圖」
  else (breakout-day / extended):
     三欄 grid（設計圖：左線圖 / 中法人 / 右突破因子）
       左： <SignalSparkPanel code={row.code} />
       中： <InstitutionalFlow inst={row.inst} warnings={row.warnings} />
       右： <BreakoutFactorBars factors={row.factors} rs={row.scores.relativeStrength} />
```

版面：桌機 `grid-cols-1 lg:grid-cols-3 gap-6`，窄螢幕直向堆疊。設計圖三欄在一張深色卡內
（`rounded-lg border border-border bg-card p-4`）。

### 3.1 左欄：近 60 交易日線圖（`SignalSparkPanel`）

- **按需撈**（第 D 點使用者確認）：`SignalSparkPanel` 是 client 子元件，`useEffect` 依 `code`
  呼叫 `getSignalSpark(code)`；載入中顯示 `資料載入中…`（同 `Sparkline` 的「資料不足」框樣式），
  回來後渲染 `<Sparkline points={points} rising={...} />`。
- `rising` 取該檔當日漲跌方向：`row.changePercent >= 0`。傳進 `SignalSparkPanel` 或一起放進
  spark 回傳。傾向前者（action 只回 `SparkPoint[]`，方向前端已有）。
- 切換展開列時元件卸載重撈。**不做跨列快取**（YAGNI；展開通常一次看一檔）。

#### `components/ui/Sparkline.tsx`（新檔，抽出）

- 從 `WatchlistPerfTable.tsx` 搬 `Sparkline` function + `SPARK_UP` / `SPARK_DOWN` /
  `SPARK_BASELINE` HEX 常數，全部 `export`。
- props 不變：`{ points: SparkPoint[]; rising: boolean }`。
- `SParkPoint` 型別、`SPARK_CLIP`、`SPARK_WINDOW` **留在 `lib/dashboard-spark.ts` 不動**，
  `Sparkline.tsx` 從那 import（改動面最小；`dashboard-spark.ts` 名字雖帶 dashboard，實為
  spark 共用常數檔，暫不改名以免波及）。
- `WatchlistPerfTable.tsx` 改成 `import { Sparkline } from "../ui/Sparkline"`，刪除本地定義與常數。
- 純 SVG、無 DB、無互動 → 放 `components/ui/` 合理（與 `Card.tsx` / `Button.tsx` 同層，兩個使用者）。

#### `lib/spark-series.ts`（新檔，抽出）

- `dashboard.ts` 的 `getWatchlistPerformance` 裡「把每天 close 對到同日 bollingerMid 算 dev 夾
  ±SPARK_CLIP」那段 inline map，抽成純函式：

  ```ts
  export function buildSparkSeries(
    quoteWindow: { date: Date; close: number }[],   // 舊到新或新到舊，實作對齊現況
    midByDate: Map<number, number | null>,          // date.getTime() -> bollingerMid
  ): SparkPoint[]
  ```

- `dashboard.ts` 改呼叫它，行為必須完全等價（比對現有輸出）。
- 新 action `getSignalSpark` 也用它。兩個使用者 → 抽出不違反 YAGNI。

#### `getSignalSpark(code)` action（`lib/actions/signal-scan.ts`）

```ts
export async function getSignalSpark(code: string): Promise<SparkPoint[]> {
  // 撈該 code 近 SPARK_WINDOW 筆 DailyQuote（date desc, close）
  // 撈該 code 近 SPARK_WINDOW 筆 TechnicalIndicator（date desc, bollingerMid）
  // buildSparkSeries(...) → SparkPoint[]
  // 查不到 → 回 []
}
```

- 只讀 DB、回可序列化陣列。`SparkPoint.dev` 是 `number | null`，可直接序列化。
- realtime / eod 都用同一支（都是讀 DB 歷史，跟當下報價源無關）。

### 3.2 中欄：法人籌碼（`InstitutionalFlow`，依 UI.md 第一節）

props：`{ inst: SignalResult["inst"]; warnings: string[] }`（`inst` 必有值，因為只有 breakout 階段渲染此欄）。

- **頂部 chip**：純函式 `resolveInstChip(inst, warnings)` →
  `{ text: string; tone: "success" | "warning" | "destructive" | "muted" }`，同檔（只此元件用）。
  依 UI.md 1.4 組合表逐條件：
  - 近5日流向方向 = `sign(inst.trustRatio * trustWeight + inst.foreignRatio * foreignWeight)` 或更簡單
    用兩者 ratio 合計正負 + 強弱門檻（實作時對齊 UI.md 1.4「強/中/弱」——門檻可先取
    ratio 合計 > 0.3 為「強」、> 0 為「中」、<= 0 為「弱」，首版拍板、註解標「待校準」）。
  - 今日方向 = `inst.todayTrustDir` + `inst.todayForeignDir` 合計正負；任一為 `null` → 「今日未定」情境（灰）。
  - `warnings.includes("margin-chasing")` → marginChasing 分支。
  - `inst` 標記資料不足（後端 degraded）→「籌碼資料不足」灰 chip。
  - 對照表輸出對應文字與顏色（`tone` → `bg-{tone}/10 text-{tone}`）。
- **投信 / 外資 各一列 diverging bar**：
  - 容器寬度代表 `±clipDivisor`（±0.5 = ±50%）。中線在正中。
  - 買超（ratio > 0）：綠條從中線往右，寬度 = `min(|ratio|, 0.5) / 0.5 * 50%`。
  - 賣超（ratio < 0）：紅條從中線往左，同公式。
  - **柱長用 `inst.trustRatio` / `inst.foreignRatio`（近5日淨買超÷volumeMa20），不是股數、不是分數**
    （UI.md 1.2 / 1.3 的核心規則）。
  - 右側文字：`{(ratio*100).toFixed(0)}%`，帶正負號。
  - 小箭頭 ▲/▼：依 `inst.todayTrustDir` / `inst.todayForeignDir`（**今日單日**方向，與柱子近5日累積是兩回事）。
    買=綠▲、賣=紅▼、`null`（盤中無當日）= 不顯箭頭。
  - **柱子與箭頭不同號時**（近5日買、今日賣 = 翻臉）：柱子 `opacity-50`（UI.md 1.3）。
- **融資追價警示列**：只在 `warnings.includes("margin-chasing")` 時渲染，
  紅底文字（`border-destructive/30 bg-destructive/10 text-destructive`），文案例：
  「融資 5 日增速排自己歷史前 20%，且今日法人翻空」。不觸發時**完全不佔版位**（UI.md 1.3）。
- **盤中沿用昨日籌碼提示**：`inst` 為「今日資料 null」情境時（`todayTrustDir === null`），
  區塊底部一行灰紅字「尚未取得今日法人資料，以下為近日資料」（對應設計圖中欄紅字 + 表格「昨」badge）。

顏色：綠/琥珀/紅 = `success` / `warning` / `destructive` token（UI.md 1.3 註「顏色：綠=高分無警示／
琥珀=封頂但無融資警示／紅=封頂且有融資警示或直接同步撤出」）。台股漲跌色（`up`/`down`）語意不同、不複用。

### 3.3 右欄：突破因子（`BreakoutFactorBars`，依 UI.md 第二節）

props：`{ factors: SignalResult["factors"]; rs: number }`（`rs` = `row.scores.relativeStrength`，本身即百分位分數）。

4 列，每列固定 4 欄（標籤 / 長條 / 分數 / 原始值灰字）：

| 列標籤 | 長條寬度（0~100 內部分數） | 分數數字 | 原始值灰字 |
|---|---|---|---|
| 突破幅度 | `factors.breakoutMarginScore` | 同左，粗體 | `{breakoutMarginPct >= 0 ? "+" : ""}{breakoutMarginPct.toFixed(1)}%` |
| 相對強度 | `rs`（`scores.relativeStrength`） | 同左 | `{rs.toFixed(0)} 分位` |
| 距 60 日高點 | `factors.proximityShortScore` | 同左 | `{proximityShortPct.toFixed(1)}%`（距高點負距離，例 `-8.4%`） |
| 距一年高點 | `factors.proximityLongScore` | 同左 | `{proximityLongPct.toFixed(1)}%` |

- 長條顏色分級（UI.md 2.3）：`>=70` 綠（`bg-success`）／`40~69` 琥珀（`bg-warning`）／`<40` 紅（`bg-destructive`）。
  抽 helper `barTone(score)` 同檔。
- 長條軌道 `bg-muted`，填充寬度 `${score}%`。
- 原始值 `text-muted-foreground/70`，不參與長條寬度（UI.md 2.2 核心規則）。
- **不放位階（base）因子**（使用者已定；UI.md 2.1 說 base 獨立呈現但設計圖右欄無 base）。
- `factors` 內某項為 degraded（後端已標 `row.degraded`）時，該列分數字後加「不足」小 tag，
  灰字顯示可得的原始值或 `—`。

---

## 4. 後端擴充（第 C / E 點：只補回傳值，不動評分）

### 4.1 `SignalResult` 新欄位

```ts
export interface SignalResult {
  // ...既有欄位不動...
  volumeRatio?: number;   // 觸發量比。breakout-day / extended 有值；pre-breakout undefined
  inst?: {
    trustRatio: number;              // 近 lookbackDays 日投信淨買超 ÷ volumeMa20
    foreignRatio: number;            // 同上，外資
    todayTrustDir: -1 | 0 | 1 | null;   // 今日投信淨買超方向（null = 盤中無當日資料）
    todayForeignDir: -1 | 0 | 1 | null;
  };
  factors?: {
    breakoutMarginScore: number;     // = scores.breakoutMargin（重述，方便前端一次拿齊）
    breakoutMarginPct: number;       // (close - bollingerUpper) / bollingerUpper * 100
    proximityShortScore: number;     // computeProximityToHigh 短窗分數
    proximityLongScore: number;      // 長窗分數
    proximityShortPct: number;       // 收盤距短窗高點的 % 距離（<= 0）
    proximityLongPct: number;        // 距長窗高點的 % 距離
  };
}
```

- 三個都 optional，只在 breakout-day / extended 的 push 裡帶。pre-breakout 的 push 不帶（維持
  現有 `scores` / `detail` 結構——雖然展開列不再顯示，`data/signal-scan-results/*.json` 落地仍保留供除錯）。
- `relativeStrength` 原始百分位不另立欄：`scores.relativeStrength` 本身就是（`rankScore` 輸出），前端直接用。

### 4.2 `computeInstitutionalFlow` 回傳擴充（`institutional.ts`）

現回 `{ score, degraded, marginChasing }`，加：

```ts
): {
  score: number;
  degraded: boolean;
  marginChasing: boolean;
  trustRatio: number;    // trustSum / volumeMa20（volumeMa20 缺 → 0）
  foreignRatio: number;  // foreignSum / volumeMa20
  todayTrustDir: -1 | 0 | 1 | null;   // sign(todayTrustNetBuy)；null 傳入 → null
  todayForeignDir: -1 | 0 | 1 | null;
}
```

- `trustSum` / `foreignSum` 函式內已算（`toFlowScore` 裡的 `series.reduce`）——提出來共用，不重算。
- volumeMa20 缺值早退分支：`trustRatio` / `foreignRatio` 回 `0`，`todayXxxDir` 照常算。
- 純計算擴充，**score / degraded / marginChasing 邏輯一字不改**。

### 4.3 `computeProximityToHigh` 回傳擴充（`breakout.ts`）

現回 `{ score, degraded }`，加 `shortScore` / `longScore`（函式內已分開算）＋
`shortPct` / `longPct`（收盤距各窗最高點的 % 距離）：

```ts
): { score: number; degraded: boolean;
     shortScore: number; longScore: number;
     shortPct: number; longPct: number } {
```

- `shortPct = (referenceClose - max(shortWindow)) / max(shortWindow) * 100`（`computeProximityScale`
  內部已有 max 計算，提出來或就地重算一行）。`longPct` 同理。
- degraded 早退分支（`validCloses.length < shortWindowDays`）：`shortScore=longScore=50`、
  `shortPct=longPct=0`。
- **合成公式 `shortScore*0.5 + longScore*0.5` 不動。**

### 4.4 `run-signal-scan.ts` 組裝

- `computeBreakoutFactors` 的 `BreakoutFactorOutput` 加透傳 `inst` / `factors` 子物件
  （從 `computeInstitutionalFlow` / `computeProximityToHigh` 的新回傳值組），或直接在
  breakout-day / extended 的 `results.push` 處組裝（傾向後者，`computeBreakoutFactors` 只多回
  raw 值、組裝在呼叫端）。
- `volumeRatio`：push 時帶 `s.volumeRatio`（`staged` 已有，breakout 階段必有值）。
- realtime 路徑（`runRealtime`）同步帶這些欄位；`todayTrustDir` / `todayForeignDir` realtime 恆
  `null`（當日法人拿不到），`volumeRatio` realtime 有（即時量比）。

### 4.5 `factors.test.ts`

- `computeInstitutionalFlow`：補 assert 新回傳的 `trustRatio` / `foreignRatio`（用已知輸入手算對比）、
  `todayTrustDir` 對 `null` / 正 / 負 / 0 四種輸入。
- `computeProximityToHigh`：補 assert `shortScore + longScore` 與舊 `score * 2` 一致（等價性）、
  degraded 分支的新欄位預設值。

---

## 5. `SignalScanView` / action 邊界（`lib/actions/signal-scan.ts`）

- `SignalResult` 已全是 number/string/plain object → `toView` 不用改（新欄位是 optional plain object，可序列化）。
- `SignalScanView.results` 型別隨 `SignalResult` 自動帶新欄位。
- 新增 `getSignalSpark(code: string): Promise<SparkPoint[]>`（§3.1）。import `SparkPoint` /
  `SPARK_WINDOW` from `lib/dashboard-spark`、`buildSparkSeries` from `lib/spark-series`。

---

## 6. 驗證

1. `pnpm exec tsc --noEmit`（scripts + app 都要乾淨）。
2. `pnpm tsx --test scripts/lib/signal-factors/factors.test.ts`（31 案 + 新增案全過）。
3. `pnpm tsx scripts/screening/run-signal-scan.ts --date=<最近交易日>`：
   - 跑得完、`data/signal-scan-results/<date>.json` 有新欄位。
   - 隨機挑 2 檔 breakout：手動核對 `inst.trustRatio` ≈ (近5日投信淨買超 / volumeMa20)、
     `factors.breakoutMarginPct` ≈ (close-上軌)/上軌×100、`factors.proximityShortScore +
     proximityLongScore` ≈ `scores.proximityToHigh * 2`。
   - `totalScore` / `rank` / `scores` 與改動前**逐檔完全一致**（評分沒被碰到）——改動前先存一份
     `<date>.json` 比對。
4. `curl http://localhost:3000/screening`（使用者的 dev server）：
   - 三 tab、無「全部」、預設「今日突破」。
   - 欄位順序、狀態 pill 底色、量增 `x2.5` / 醞釀中 `—`、籌碼 chip。
   - 展開 breakout 列：三欄，線圖非同步載入、法人 diverging bar 柱長比例合理、突破因子 4 列顏色分級。
   - 展開醞釀中列：只有線圖。
5. `curl http://localhost:3000/`（Dashboard）：`WatchlistPerfTable` 走勢圖與改動前**視覺一致**
   （`Sparkline` / `buildSparkSeries` 抽出後行為等價）。
6. `pnpm build`（整專案 typecheck + 靜態預渲染不炸）。

---

## 7. 收尾

- `docs/PROGRESS.md`：新增段落記錄本次改版（tab 收斂、欄位、展開列三欄、後端新增回傳欄位、
  `Sparkline` / `buildSparkSeries` 抽出）。**把 `docs/UI.md` 的規格重點（法人籌碼區長條量尺規則、
  1.4 chip 組合表、突破因子長條用分數不用原始值）併入這個 PROGRESS 段落**，之後看實作理由查
  PROGRESS 即可。
- **刪除 `docs/UI.md`**（`git rm docs/UI.md`）——規格已落實成程式碼 + PROGRESS 紀錄，獨立規格檔
  完成階段性任務。
- `docs/ROADMAP.md`：本次不對應既有 todo 項（UI 打磨屬前端迭代，ROADMAP 無此條），不打勾。
  若要追蹤可在「已完成」段補一行；否則略過。
- `CLAUDE.md`：前端段補記——`components/ui/Sparkline.tsx`（走勢圖共用元件出處）、
  `lib/spark-series.ts`（`buildSparkSeries` 純函式，dashboard + screening 共用）、
  screening 展開列三欄結構與 stage 分支（醞釀中只有線圖）、`SignalResult` 新增
  `volumeRatio` / `inst` / `factors` 欄位（只 breakout 階段有值）。移除 `docs/UI.md` 的引用
  （PROGRESS 維護段目前沒提到 UI.md，確認無殘留引用再收工）。
- 不 merge，等使用者發話。
