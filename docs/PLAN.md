# PLAN：股票資料品質修正——權證過濾誤殺 bug + 下市標記 `delistedAt`

源自 2026-09-01 的 8/31 行情覆蓋調查：DB 內 2,148 檔一般股票有 207 檔缺 8/31 行情。
調查結論分四類（詳細過程與逐檔清單見 `docs/PROGRESS.md` 對應段落，完成本計劃時回寫）：

1. **權證過濾誤殺（bug，2 檔）**：`toSecurityType` 的「名稱含『購』/『售』→ warrant」判斷
   排在「4 碼數字 → stock」之前，**2945 三商家購**（TWSE）與 **3085 新零售**（TPEx）
   每天被三支 pipeline 腳本當權證跳過。兩檔 8/31 都有真實成交（三商家購收 40.00 /
   量 41,569 股；新零售收 11.8 / 量 9,210 股）。現況：行情停在 8/27（FinMind 回補塞的）、
   **融資融券兩檔完全空白**、法人斷續（2945 至 8/27、3085 至 7/8）。
2. **早已下市的殭屍 Stock（約 168 檔）**：99 檔從無行情（2020 回補起點前下市），
   約 69 檔最後行情停在 2020~2026 年中（下市/併購：康友-KY、中壽、新光金、京城銀…）。
3. **當日零成交（約 29 檔，多為上櫃冷門股）**：官方 API 開高低收為 `--`，解析器跳過。
   設計行為，不處理。
4. **停牌/換股（4 檔）**：三商壽 2867（9/1 併玉山金永久下市）、中光電 5371（9/3 轉
   中光電投控 3718）、巧新 1563（減資，9/7 復牌）、沛爾生醫 6949（1 拆 20，9/7 復牌）。

**決策**（已與使用者確認）：bug 修正＋回補；殭屍股與永久下市股用 `Stock.delistedAt`
標記，**一律不刪資料**；復牌股不處理（pipeline 自動接回）；3718 掛牌後由
`fill-daily-quotes` 既有機制自動建檔，5371 歷史不接。

**分支**：`feat/stock-data-hygiene`（已從 `main` 開）。merge 時機等使用者發話。

---

## 0. 邊界

**動：**

- 新檔 `scripts/lib/security-type.ts`：共用 `toSecurityType`。
- `scripts/pipeline/fill-daily-quotes.ts` / `fill-institutional-trading.ts` /
  `fill-margin-trading.ts`：刪各自的 `toSecurityType` 複製，改 import 共用版。
- `prisma/schema.prisma`：`Stock` 加 `delistedAt DateTime?`＋migration。
- 新檔 `scripts/backfill/mark-delisted.ts`：下市標記維護腳本（雙向：標記＋復活清除）。
- `lib/actions/health.ts`：`getDbHealth` 的 `stockCount` 分母排除已下市。
- `scripts/backfill/backfill-daily-quotes.ts` / `backfill-institutional-trading.ts`：
  迴圈排除已下市（省 FinMind 配額）。
- 一次性回補（`scripts/_temp/`，不進正式碼）：2945/3085 的行情缺口。

**不動：**

- `run-signal-scan.ts` 候選池與 gate——殭屍股無當日行情，天然被排除，不加 `delistedAt`
  條件（實作時驗證此假設，若候選撈取以 `Stock` 表為起點才順手加 where）。
- 評分邏輯、前端頁面、`WatchlistItem`。
- 不刪任何 `Stock` / `DailyQuote` / 子表資料。
- `prisma/seed.ts`：seed 重跑可能復活殭屍股的問題，靠「重跑 `mark-delisted.ts`」解，
  不改 seed 邏輯。

---

## 1. `toSecurityType` 抽共用 + 修判斷順序

新檔 `scripts/lib/security-type.ts`，判斷順序改為：

```
00 開頭            → etf
4 碼 + 1 碼英文    → preferred
4 碼數字           → stock        ← 提前到「購/售」名稱判斷之前（修 bug 的核心）
6 碼數字 或 名稱含「購」「售」 → warrant
5 碼數字           → bond
其餘               → other
```

安全性論證：台股權證代號一律 6 碼（上市數字 6 碼、上櫃 5 碼數字+P 等由「其餘」或
5 碼規則接住——實作時抽 10 筆真實權證代號驗證），4 碼數字提前不會漏擋權證；
名稱判斷降為 fallback，只攔非 4 碼、名稱帶購/售的衍生品。

三支 pipeline 腳本刪掉各自複製、改 import。`scripts/archive/` 內的複製不動（封存區）。

**單測**（併入 `scripts/lib/signal-factors/factors.test.ts` 旁新開
`scripts/lib/security-type.test.ts`）：`2945 三商家購 → stock`、`3085 新零售 → stock`、
6 碼權證 → warrant、名稱含「購」的 5 碼/其他碼 → warrant/bond 不誤放、
`00` ETF、特別股、TAIEX（"TAIEX" → other，確認不影響既有特殊列）。

## 2. 回補 2945 / 3085

修完第 1 節後執行（順序固定）：

1. **行情**：`scripts/_temp/` 一次性腳本用 FinMind `TaiwanStockPrice` 補兩檔
   2026-08-28 起的缺口（upsert `DailyQuote`，比照 `backfill-daily-quotes.ts` 寫法）。
2. **技術指標**：`pnpm tsx scripts/pipeline/calculate-technical-indicators.ts 2945 3085`
   （full 模式全歷史重算）。
3. **融資融券**：`pnpm tsx scripts/pipeline/fill-margin-trading.ts --backfill=45`
   （官方 API 兩邊都支援歷史日期；upsert 冪等，其他股票重寫無害；45 天讓
   margin-chasing 的 40 天百分位母體夠用）。
4. **法人**：2945 用 `fill-institutional-trading.ts --date=...` 逐日補 8/28 起缺口
   （T86 支援歷史）；3085 的 TPEx 歷史缺口（7/9~今）用 FinMind 盡力補，補不齊接受
   degraded（TPEx 在 FinMind 效果本來就有限）。

## 3. `Stock.delistedAt` + 標記腳本

- schema：`delistedAt DateTime?`（null = 存續）。`pnpm prisma migrate dev`。
- `scripts/backfill/mark-delisted.ts`（手動、低頻，比照 `update-shares-outstanding.ts`
  定位，不進 daily pipeline）：
  - **標記**：`securityType = stock` 且（最後 `DailyQuote` 日期距 DB 全市場最新交易日
    **> 60 個日曆日**，或從無行情）→ `delistedAt` = 最後行情日；從無行情者設
    `2020-01-01`（語意：回補起點前已下市）。60 天緩衝不會誤傷減資/分割型停牌
    （巧新/沛爾約兩週）。
  - **復活清除**：`delistedAt` 非 null 但最近 60 天內出現新 `DailyQuote` → 清回 null
    （復牌、seed 誤標都靠這條自癒）。
  - 輸出：本次標記/清除清單與總數。
- 跑完首輪後抽查：三商壽 2867、中光電 5371 應被標記；巧新 1563、沛爾 6949 在
  60 天規則下**不會**被標記（最後行情 8 月底）。

## 4. 下游接上 `delistedAt`

- `getDbHealth`：`stockCount` 與四表覆蓋率分母改 `where: { securityType: "stock", delistedAt: null }`。
  預期效果：分母從 2,148 → ~1,975（扣約 170 檔殭屍＋2 檔永久下市），覆蓋率從天花板
  ~90% 回到誠實的 ~98%+。
- `backfill-daily-quotes.ts` / `backfill-institutional-trading.ts`：撈股票清單時加
  `delistedAt: null`，全量回補少打 ~170 檔 × N 次 FinMind。
- 其他讀 `Stock` 的地方（`listWatchlist`、`getWatchlistPerformance`、seed）不動。

## 5. 驗收

1. `pnpm exec tsc --noEmit` 乾淨；新舊單測全過。
2. `fill-daily-quotes.ts --date=2026-08-28`、`--date=2026-08-31` 重跑後，2945 兩日
   `DailyQuote` 入庫（TWSE 歷史可補即為 bug 修好的直接證據）。
3. 回補後 2945/3085：`DailyQuote` 補到最新交易日、`MarginTrading` 有近 45 日資料、
   `TechnicalIndicator` 全歷史重算完成。
4. `mark-delisted.ts` 首輪執行，標記數 ≈ 170（±5），抽查上述 4 檔行為正確。
5. 首頁 Dashboard 資料狀態卡覆蓋率顯著上升（分母修正）。
6. 收尾：`CLAUDE.md`（`toSecurityType` 共用檔、`delistedAt` 欄位語意、`mark-delisted.ts`
   條目）、`docs/PROGRESS.md`（調查過程＋修正紀錄）、`README.md`（腳本清單）同步更新；
   刪 `scripts/_temp/`。
