# 股市觀察 Agent - Phase A + Phase B 任務指令

## 背景

Schema 目前已有 `Stock`、`Sector`、`Tag`/`StockTag`、`DailyQuote`、`NewsArticle`/`NewsStock`、`WatchlistItem`、`AnalysisResult`,seed script 已完成(股票清單+產業別)。

這次任務目標:擴充 schema、回補歷史報價、計算技術指標、跑一版全市場篩選,產出候選觀察股清單。**新聞、財報、三大法人的實際抓取邏輯不在這次範圍內**,只需要先把對應的資料表建好。

---

## 任務 1:Schema 擴充

在 `prisma/schema.prisma` 新增以下內容,並執行 `npx prisma migrate dev --name add_fundamentals_and_indicators`。

```prisma
// 月營收
model MonthRevenue {
  id           Int      @id @default(autoincrement())
  stockCode    String
  year         Int
  month        Int
  revenue      BigInt
  revenueYoY   Float?
  revenueMoM   Float?
  createdAt    DateTime @default(now())

  stock Stock @relation(fields: [stockCode], references: [code])

  @@unique([stockCode, year, month])
}

// 季報核心數字
model FinancialStatement {
  id              Int      @id @default(autoincrement())
  stockCode       String
  year            Int
  quarter         Int
  revenue         BigInt?
  grossProfit     BigInt?
  operatingIncome BigInt?
  netIncome       BigInt?
  eps             Float?
  createdAt       DateTime @default(now())

  stock Stock @relation(fields: [stockCode], references: [code])

  @@unique([stockCode, year, quarter])
}

// 三大法人籌碼(獨立表,不併入 DailyQuote)
model InstitutionalTrading {
  id                Int      @id @default(autoincrement())
  stockCode         String
  date              DateTime
  foreignNetBuy     BigInt?  // 外資買賣超(股數或金額,依資料源決定,備註清楚單位)
  investmentTrustNetBuy BigInt?  // 投信買賣超
  dealerNetBuy      BigInt?  // 自營商買賣超
  source            Market
  fetchedAt         DateTime @default(now())

  stock Stock @relation(fields: [stockCode], references: [code])

  @@unique([stockCode, date])
  @@index([date])
}

// 技術指標(獨立表,不併入 DailyQuote)
model TechnicalIndicator {
  id             Int      @id @default(autoincrement())
  stockCode      String
  date           DateTime
  ma5            Float?
  ma10           Float?
  ma20           Float?
  ma60           Float?
  bollingerUpper Float?
  bollingerMid   Float?
  bollingerLower Float?
  volumeMa20     Float?
  calculatedAt   DateTime @default(now())

  stock Stock @relation(fields: [stockCode], references: [code])

  @@unique([stockCode, date])
  @@index([date])
}
```

另外在既有的 `AnalysisResult` model 加一個欄位(為之後的資料品質護欄預留位置,這次不需要實作邏輯):

```prisma
model AnalysisResult {
  // ...既有欄位
  dataQuality Json?
}
```

**Stock model 記得補上對應的反向關聯**(`monthRevenues`、`financialStatements`、`institutionalTradings`、`technicalIndicators`),Prisma 通常會提示你需要加,照它的錯誤訊息補齊即可。

---

## 任務 2:歷史報價回補(Phase A)

在 `scripts/backfill-daily-quotes.ts` 撰寫回補腳本。

**資料來源**:FinMind `TaiwanStockPrice`,針對 `Stock` 表裡 `securityType = 'stock'` 的股票(先只處理一般股票,ETF/特別股/其他之後再看需不需要),逐一查詢。

**API 呼叫方式**:
```
GET https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id={股票代號}&start_date={90個交易日前的日期}&end_date={今天}
```
- `start_date` 建議往回抓 **120 個日曆天**(涵蓋週末國定假日後,足夠湊到 90+ 個交易日),不用精算到剛好90天
- 請先查證 FinMind API token 的正確帶入方式(通常是在 query string 加 `&token=你的token`,實際請以官方文件為準),把 token 存在 `.env` 的 `FINMIND_TOKEN`

**執行邏輯**:
```
1. 讀取 Stock 表裡所有 securityType = 'stock' 的代號清單
2. 對每支股票:
   a. 先查資料庫,這支股票在 DailyQuote 裡最新的日期是哪天
      - 如果已經有接近今天的資料(例如最新日期在3天內),視為已回補過,跳過
      - 否則才呼叫 API
   b. 呼叫 FinMind,拿到這支股票過去約120天的日線資料
   c. 逐筆 upsert 進 DailyQuote(唯一鍵是 stockCode + date)
      - source 欄位:填入這支股票在 Stock 表裡對應的 market 值(TWSE 或 TPEx)
   d. 每處理50支股票,印出進度(例如「已處理 250/2500」)
   e. 每次 API 呼叫之間加入約 6-7 秒延遲,避免超過 FinMind 每小時額度
3. 全部跑完後,印出總計:處理了幾支股票、寫入了幾筆 DailyQuote、跳過了幾支(已有資料)、失敗了幾支(附上失敗的代號清單方便之後重跑)
```

**延遲機制的實作方式,明確指定**:請用 `for` 迴圈搭配 `await` 依序處理,**不要用 `setInterval`**。原因是 `setInterval` 是固定時間就觸發下一次,不管上一次的 API 呼叫有沒有處理完,如果某次呼叫比較慢,會導致多個請求疊加、更容易撞到 rate limit,也難以追蹤錯誤對應到哪一支股票。正確寫法大致像這樣:

```typescript
for (const stock of stocks) {
  await fetchAndSaveOneStock(stock);
  await sleep(6500); // 等上一支處理完,才開始等待、再進下一支
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

這樣可以保證呼叫是一次一次、乾淨依序執行,不會重疊,出錯時也容易定位是卡在哪一支股票。

**重要**:這支腳本預期會跑數小時,**務必支援中斷後重新執行能接續進度**(靠上面 2.a 的「檢查資料庫是否已有近期資料」機制達成),不要設計成必須一次跑完否則從頭來過。

**執行前提醒我**:因為會跑很久,建議你在背景執行、先去做別的事,不用一直盯著。

---

## 任務 3:技術指標計算(Phase B - 前半)

在 `scripts/calculate-technical-indicators.ts` 撰寫計算腳本。

**執行邏輯**:
```
1. 讀取 Stock 表裡所有 securityType = 'stock' 的代號清單
2. 對每支股票:
   a. 從 DailyQuote 讀出這支股票依日期排序的完整歷史(應該是任務2回補的90+天資料)
   b. 對每一個交易日,計算:
      - ma5 / ma10 / ma20 / ma60:往前推對應天數的收盤價平均,資料不足則留 null
      - bollingerMid = ma20
      - bollingerUpper / bollingerLower = ma20 ± 2倍(20日收盤價的標準差)
      - volumeMa20:往前20天成交量的平均,資料不足則留 null
   c. 逐筆 upsert 進 TechnicalIndicator(唯一鍵 stockCode + date)
3. 印出進度與最終統計(處理幾支股票、寫入幾筆 TechnicalIndicator)
```

這支腳本**完全是本地運算,不呼叫任何外部 API**,執行速度應該很快(頂多幾分鐘),不用擔心 rate limit。

---

## 任務 4:篩選條件設計與執行(Phase B - 後半)

### 4a. 篩選條件的資料結構

先支援兩種條件,設計一個簡單的 JSON 格式,存在 `scripts/screener-conditions.json`(或直接寫在程式碼裡當常數,由你決定哪個方便):

```json
[
  { "type": "bollinger_breakout", "direction": "upper" },
  { "type": "volume_surge", "multiplier": 2.0 }
]
```

- `bollinger_breakout`:當日收盤價 > `bollingerUpper`(direction: upper,代表向上突破)或 < `bollingerLower`(direction: lower)
- `volume_surge`:當日成交量 > `volumeMa20 * multiplier`

### 4b. 篩選執行腳本

在 `scripts/run-screener.ts` 撰寫:

```
1. 讀取上面的篩選條件設定
2. 找出資料庫裡「最新」的交易日期(從 DailyQuote 或 TechnicalIndicator 取 MAX(date))
3. 對每支股票,取出當天的 DailyQuote + TechnicalIndicator,依序檢查是否符合全部條件
4. 把符合條件的股票整理成清單(代號、名稱、觸發了哪個條件、收盤價、漲跌幅)
5. 印出結果表格到終端機(不用寫進資料庫,這次先讓我人工看結果)
   - 同時額外寫一份 JSON 檔案到 data/screener-results/{日期}.json,方便之後回頭查
```

---

## 執行順序提醒

**請照任務 1 → 2 → 3 → 4 的順序執行,每完成一個任務先跟我回報結果再繼續下一個。**

任務 2(歷史回補)會跑比較久,執行前先跟我確認一次「大概要跑多久、預計處理幾支股票」,讓我心裡有底,不用真的跑完才發現要等好幾小時。