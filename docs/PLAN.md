# PLAN：Watchlist 頁 UI 改版——卡片 gallery + 階段 tab + 盤中資料源

觀察清單頁從「鬆散的三表快照表格 + 買入狀態 input」改成「卡片 gallery + 階段分頁」，
視覺與資料對齊已完成的 screening 頁展開列。

**分支**：`feat/watchlist-card-gallery`（已從 `main` 開）。merge 時機等使用者發話。

**需求來源**：使用者 2026-09-01 對話，附設計圖（4908 前鼎卡片：代號 / 漲跌% / 名稱 / 收盤 /
stage pill / 籌碼結論 chip / 60 日走勢線圖 / 法人買賣 diverging bar / 底排「量增 x2.3 ·
距年高 10% · 強度 PR90 · 突破 +9.5%」）。

---

## 0. 邊界

**動：**

- `lib/actions/watchlist.ts`：`listWatchlist()` 回傳型別重寫成卡片結構化資料；
  非當日資料時走 MIS 盤中報價 fallback（**A 方案**：一進頁自動打、阻塞 render，無按鈕、無快取）。
- `app/watchlist/page.tsx`：`<WatchlistTable>` → `<WatchlistGallery>`。
- 新增 `components/signal/`（screening + watchlist 共用的訊號展示元件目錄）：
  - `labels.ts`：標籤中文名 + stage 標籤/pill 顏色的**單一出處**（純常數，非元件）。
  - `InstitutionalFlowPanel.tsx`：從 `components/screening/InstitutionalFlow.tsx` **原封搬來**
    （改 import 路徑、stage/標籤常數改吃 `labels.ts`）。零客製 prop。
  - `FactorList.tsx`：突破因子「label + 原始值」呈現（**無長條圖**，watchlist 卡片底排用）。
  - `FreshnessBadge.tsx`：`fresh ? <LightningBoltIcon/> : <ClockIcon/>`（卡片左上角）。
- 新增 `components/watchlist/WatchlistGallery.tsx`（"use client"：3 個 stage tab +
  responsive grid 1/2/3/4 欄）、`components/watchlist/WatchlistCard.tsx`（單張卡，純展示）。
- `components/screening/InstitutionalFlow.tsx`：**刪除**（內容搬到 `components/signal/`）。
- `components/screening/SignalDetail.tsx`：import 路徑改 `../signal/`。`isPre` 分支邏輯不動。
- `components/screening/BreakoutFactorBars.tsx`：標籤字串改 import `signal/labels.ts`（值不變）。
- `components/screening/ScreeningPanel.tsx`：`STAGE_LABELS` / `STAGE_PILL_CLASS` 改 import
  `signal/labels.ts`（值不變，只是搬家）。
- `package.json`：`+ @radix-ui/react-icons`（`pnpm add`）。

**不動：**

- `scripts/screening/run-signal-scan.ts`：**完全不改**。醞釀中（pre-breakout）卡片本次
  **不做法人籌碼區塊**（跟 screening 現況一致），使用者說要另想 UI、之後補規格。
  因此不需要在 pre-breakout 的 `SignalResult` 補 `inst` 中繼值。
- `prisma/schema.prisma`：不動。買入狀態欄位（`isPurchased` / `buyPrice` / `buyDate` /
  `targetPrice` / `stopLossPrice` / `notes`）保留，只是 UI 不再提供 input。
- `lib/actions/watchlist.ts` 的 `addToWatchlist` / `removeFromWatchlist` / `updateWatchlistItem`：
  **保留不刪**（`updateWatchlistItem` 雖無 UI 呼叫，schema 欄位還在，YAGNI：不做移除 migration）。
- `components/watchlist/WatchlistTable.tsx`：先留著，新版 gallery 驗證無誤後才 `git rm`。

---

## 1. 觀察股的「階段」——即時重算，不是 source 欄位

`WatchlistItem.source`（`"breakout"` / `"accumulation"` / `"manual"` / null）是「當初從哪個
策略加入」的**靜態標記**，不等於「這檔現在處於哪個階段」。一檔用 `breakout` 加入的股票兩週後
可能已是 `extended` 甚至跌回 `pre-breakout`。

**tab 分類即時重算**，用 screening 頁同一套 `consecutiveAboveBand()`（`scripts/lib/signal-factors/staging.ts`）：

| 連續站上布林上軌天數 | stage | tab 中文名 |
|---|---|---|
| `<= 0` | `pre-breakout` | 醞釀中 |
| `1 ~ 2` | `breakout-day` | 首次突破 |
| `> 2` | `extended` | 延續爆發 |

`source` 欄位保留不動；加入清單時仍照舊記錄（`ScreeningPanel` 的 `stageToSource` 不改）。

**預設 tab**：`breakout-day`（首次突破）。空 tab 顯示「此分類目前無觀察股」。

---

## 2. 資料源自動切換（A 方案）

`listWatchlist()` 開頭查「DB 最新 `DailyQuote`（`securityType="stock"`）日期 == Asia/Taipei 今日？」
（比照 `lib/actions/signal-scan.ts` 的 `getScanMode`）：

- **相符**（`dataFresh: true`）→ 全部用 DB 資料，卡片左上角 **⚡ 閃電**（`LightningBoltIcon`）。
- **不相符**（`dataFresh: false`）→ 對所有觀察股 code 打 `fetchAllMisQuotes`
  （`scripts/lib/mis-quotes.ts`），拿 `close` / `volume` / `high`：
  - 有成交價 → `priceSource: "realtime"`
  - 缺成交價（`z` 為 `-`）→ 用 `high` 代入 → `priceSource: "estimated"`（卡片標「估」）
  - `z` / `h` 都缺 → 該檔 `close` 用 DB 昨收，`priceSource: "eod"`（退化）
  - **左上角一律 🕐 時鐘**（`ClockIcon`）——即使抓到即時，日期仍非今日交易日定案。
    ⚡ 只給 `dataFresh: true`。

**行為代價（已與使用者確認接受）**：

- 一進頁 Server Component `await listWatchlist()` 阻塞直到 MIS 回來。
- 觀察股 < 50 檔 = `fetchAllMisQuotes` 1 批（`BATCH_SIZE=120`）= 1 次 HTTP = 約 1~2 秒空白載入。
- 每次進頁 / 重整 / `revalidatePath("/watchlist")` 都重打，**無快取**（不落 JSON、不加節流）。
- `page.tsx` 已是 `force-dynamic`，不影響。

**籌碼恆用 DB 最新一筆**（盤中拿不到當日即時籌碼）：

- 沿用 `InstitutionalFlowPanel`（= 搬過來的 `InstitutionalFlow.tsx`）既有邏輯：
  `todayTrustDir` / `todayForeignDir` 為 null 時，元件底部自動顯示
  「尚未取得今日法人資料，以上為近日資料。」——**不加時鐘**（使用者確認沿用文字區塊）。

---

## 3. 卡片內容

| 區塊 | breakout-day / extended | 醞釀中 (pre-breakout) |
|---|---|---|
| 左上 badge（`FreshnessBadge`） | ⚡ / 🕐 | ⚡ / 🕐 |
| 代號（3xl）/ 漲跌%（漲紅跌綠）/ 名稱 / 收盤 | ✓ | ✓ |
| stage pill（`labels.ts` 的 `STAGE_LABELS` + `STAGE_PILL_CLASS`） | 首次突破 / 延續爆發 | 醞釀中 |
| 籌碼結論 chip（`InstitutionalFlowPanel` 的 `resolveInstChip` 結論；或抽出當獨立小工具） | ✓ | ✗ |
| 60 日走勢 Sparkline（`components/ui/Sparkline` + `lib/spark-series` 的 `buildSparkSeries`） | ✓ | ✓ |
| 法人籌碼區塊（`InstitutionalFlowPanel`：diverging bar + 結論 chip + 過期文字） | ✓ | **✗（本次不做，待補規格）** |
| 底排因子（`FactorList`） | 量增 x2.3 · 距年高 10% · 強度 PR90 · 突破 +9.5% | 量增 x2.3 · K棒 · 力道 · 位階（三分數 0~100） |

**底排因子呈現**（照設計圖，`FactorList` = label + 原始值，非長條圖）：

- breakout 階段：`量增`=`x{volumeRatio}`；`距年高`=`{proximityLongPct}%`（原始值，`<= 0`）；
  `強度`=`PR{n}`（見下方 §3.1）；`突破`=`{breakoutMarginPct >= 0 ? "+" : ""}{n}%`（原始值）。

### 3.1 強度 PR 欄（方案 1：讀最近掃描結果，不現算全市場 RS）

相對強度（PR）是「這檔近期漲幅在**全市場**的百分位」，單支股票算不出來（screening 頁能算是因為
它本來就掃全市場 2000+ 檔排名）。watchlist <50 檔之間排名無意義。

**做法**：`listWatchlist()` 讀 `data/signal-scan-results/` 最新一份 `{date}.json`（eod 結果；
比照 `lib/actions/signal-scan.ts` 的 `getSignalScanResult` 讀檔套路，但**就地寫在 `watchlist.ts`
內**——不動 `signal-scan.ts`）。組出 `{ scanDate: string, prByCode: Map<string, number> }`。

每檔卡片：

- 該檔在掃描結果裡 → 顯示 `PR{scores.relativeStrength}`。
  - `scanDate !== refDate`（掃描結果比卡片資料舊，例：卡片今日盤中 / 掃描昨天 eod）
    → `PR{n}` 旁加 **🕐** 小時鐘（`ClockIcon`），代表這個 PR 是舊的。
  - `scanDate === refDate` → 純 `PR{n}`，無時鐘。
- 該檔不在掃描結果裡（沒過 gate / 從沒跑過掃描 / 目錄空）→ 顯「—」。

型別上 `WatchlistCardRow.factors` 多兩個欄位：`relativeStrength: number | null`（不在掃描結果 = null）、
`relativeStrengthStale: boolean`（`scanDate !== refDate`）。
- pre-breakout 階段：`量增` + K棒 / 力道 / 位階三分數（`candleScore` / `volumeScore` / `baseScore`，
  0~100，`>=70` 綠 / `40~70` `text-foreground/80` / `<40` 灰，null 顯「—」+ degraded 加「不足」tag，
  比照 `WatchlistPerfTable` 的 `ScoreItem`）。

---

## 4. `listWatchlist()` 新回傳型別

```ts
export interface WatchlistCardRow {
  stockCode: string;
  name: string;
  addedAt: string;
  source: string | null;

  stage: "pre-breakout" | "breakout-day" | "extended"; // consecutiveAboveBand() 即時判定
  dataFresh: boolean;                                   // DB 最新交易日 == 台北今日
  priceSource: "eod" | "realtime" | "estimated";

  close: number;
  changePercent: number;
  volumeRatio: number | null;                          // 今日 volume / volumeMa20
  spark: SparkPoint[];                                 // 近 60 日相對布林中軌偏離（舊 → 新）

  // 面向分數（0~100，缺資料為 null）——pre-breakout 底排用；breakout 卡片也可留著（YAGNI：先都算）
  candleScore: number | null;
  volumeScore: number | null;
  baseScore: number | null;
  degraded: string[];

  // 法人 diverging bar 中繼值——只在 breakout-day / extended 組；pre-breakout = null
  inst: {
    trustRatio: number;
    foreignRatio: number;
    todayTrustDir: -1 | 0 | 1 | null;
    todayForeignDir: -1 | 0 | 1 | null;
  } | null;

  // 底排突破因子原始值——只在 breakout-day / extended 組；pre-breakout = null
  factors: {
    proximityLongPct: number;         // 距一年高點 %（<= 0）
    breakoutMarginPct: number;        // (close - bollingerUpper) / bollingerUpper * 100
    relativeStrength: number | null;  // §3.1：最近掃描結果的 PR；不在結果裡 = null
    relativeStrengthStale: boolean;   // §3.1：掃描結果日期 != 卡片資料日期
  } | null;
}
```

**計算共用**（都已存在，直接 import，不重寫）：

- `consecutiveAboveBand`（`scripts/lib/signal-factors/staging.ts`）——階段判定。
- `computeCandleShape` / `computeVolumeStrength` / `computeBase`（`scripts/lib/signal-factors/`）
  ——三分數，比照 `lib/actions/dashboard.ts` 的 `getWatchlistPerformance` 用法。
- `computeInstitutionalFlow`（`scripts/lib/signal-factors/institutional.ts`）——`inst` 中繼值，
  比照 `run-signal-scan.ts` 的 `breakoutExtras()`。
- `computeBreakoutMargin` / `computeProximityToHigh`（`scripts/lib/signal-factors/breakout.ts`）
  ——`factors` 原始值。
- `buildSparkSeries`（`lib/spark-series.ts`）+ `SPARK_WINDOW` / `SparkPoint`（`lib/dashboard-spark.ts`）
  ——走勢圖序列。
- `fetchAllMisQuotes`（`scripts/lib/mis-quotes.ts`）——非當日盤中報價。

**邊界轉換**（`"use server"` action 回傳前）：`Date` → ISO 字串、`Decimal` → number、
`BigInt`（volume / *NetBuy）→ Number。比照既有 `watchlist.ts` / `dashboard.ts`。

**每檔查詢量**：延續 `getWatchlistPerformance` 現狀（每檔數次 `findFirst` / `findMany`），
清單 < 50 檔可接受。MIS 抓取只在 `!dataFresh` 時觸發、一次抓全部 code。

---

## 5. 共用決策總結（使用者關切點）

| 東西 | 共用方式 | 位置 |
|---|---|---|
| 標籤中文名（突破幅度 / 相對強度 / 投信 / 外資 / 法人籌碼 …）、stage 標籤 + pill 顏色 | 純常數檔，改一處全改。不引 i18n 框架（YAGNI） | `components/signal/labels.ts` |
| 法人籌碼區塊（diverging bar + 結論 chip + 過期文字） | 同一個元件，零客製 prop | `components/signal/InstitutionalFlowPanel.tsx` |
| 突破因子 | **不共用元件**（screening 長條圖 vs watchlist 純數字，硬包 `variant` 會過度複雜）。共用的是「算好的資料」+ `labels.ts` 標籤 | screening: `BreakoutFactorBars`（長條）／ watchlist: `signal/FactorList`（純數字） |
| Sparkline / buildSparkSeries / signal-factors 計算 | 已是共用，直接用 | 既有位置 |
| 新鮮度 badge（⚡ / 🕐） | 薄元件 | `components/signal/FreshnessBadge.tsx` |

**目錄理由**：`components/screening/` 綁定「選股頁」，但 watchlist 也要法人籌碼 + 因子展示。
開 `components/signal/`（對應 `scripts/lib/signal-factors/`）語意乾淨——「凡呈現訊號因子的
共用 UI 都在這」。screening 專屬的（`ScreeningPanel` / `SignalDetail` / `SignalSparkPanel` /
`BreakoutFactorBars`）留在 `components/screening/`。

---

## 6. 收尾

- `pnpm exec tsc --noEmit` 乾淨。
- `curl http://localhost:3000/watchlist`（打使用者的 dev server）確認渲染；打不通就請使用者開。
- 兩種資料源手動驗一遍：DB 有當日資料（⚡）／ 無當日資料（🕐 + MIS 阻塞載入）。
  無當日資料的驗證時機 = 交易日盤中，或臨時把 `dataFresh` 判斷改成永遠 false 測一次再改回。
- `git rm components/watchlist/WatchlistTable.tsx`（gallery 確認無誤後）。
- 更新 `docs/PROGRESS.md`（新增「Watchlist 頁卡片 gallery 改版」段，記設計理由與實測）。
- 更新 `CLAUDE.md` 的「前端」段 `/watchlist` 頁描述。
- 更新 `docs/ROADMAP.md` 對應項目打勾（若有）。
- README「目前功能」檢查是否需同步。
