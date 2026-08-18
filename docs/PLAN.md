# 開發指令:估值/市值/產業熱度(Phase B 擴充)

## 背景與原則

本專案為台股觀察 agent(TypeScript + Node.js + Prisma + PostgreSQL)。本次任務目標:補上 screen_score 所缺的 value(PE/PB)、size(市值)、theme_heat(產業熱度)三類資料。

遵守既有專案原則:

- 確定性運算(抓取/計算)全部用程式碼寫死,不經過 LLM。
- 所有抓取腳本比照 `fill-gap-mi-index.ts` 的模式:匯出 `fillOneDay*(date)` 函式、可獨立執行、非交易日自動跳過、可重複執行(冪等,upsert by unique key)。
- 權證/可轉債/ETF 不入庫(估值端點本來就不含這些,但寫入前仍要 join Stock 表過濾,只寫入 Stock 表已存在的代號)。

---

## Step 1:Schema Migration

在 `schema.prisma` 新增以下內容後跑 migration:

```prisma
model StockValuation {
  id            Int      @id @default(autoincrement())
  stockCode     String
  date          DateTime @db.Date
  peRatio       Decimal? @db.Decimal(10, 2)  // 虧損公司為 null
  pbRatio       Decimal? @db.Decimal(10, 2)
  dividendYield Decimal? @db.Decimal(6, 2)
  closePrice    Decimal? @db.Decimal(10, 2)  // BWIBBU_d 有附,順手存
  source        String   // "TWSE" | "TPEX"
  fetchedAt     DateTime @default(now())

  stock Stock @relation(fields: [stockCode], references: [code])

  @@unique([stockCode, date])
  @@index([date])
}

model IndustryHeatSnapshot {
  id               Int      @id @default(autoincrement())
  sectorId         Int
  date             DateTime @db.Date
  avgChangePercent Decimal  @db.Decimal(8, 4) // 等權平均漲跌幅
  risingCount      Int      // 上漲家數
  fallingCount     Int      // 下跌家數
  totalCount       Int      // 當日有成交的成分股數
  rank             Int      // 當日排名(1 = 最熱)
  createdAt        DateTime @default(now())

  sector Sector @relation(fields: [sectorId], references: [id])

  @@unique([sectorId, date])
  @@index([date])
}
```

`Stock` model 加兩個欄位:

```prisma
  sharesOutstanding          BigInt?   // 已發行普通股數
  sharesOutstandingUpdatedAt DateTime?
```

並在 `Stock` 加上 `stockValuations StockValuation[]` 關聯、`Sector` 加上 `heatSnapshots IndustryHeatSnapshot[]` 關聯。

注意:不存 heatScore。熱度分數之後要用時從這些原始欄位現算,避免公式調整後需要重刷歷史。

---

## Step 2:產業熱度計算(先做,不需打 API)

建立 `scripts/calculate-industry-heat.ts`:

1. 匯出 `calculateOneDayHeat(date: Date)`:
   - 從 `DailyQuote` 取該日所有報價,join `Stock` 取得 `sectorId`,依 sector 分組。
   - 每組計算:等權平均漲跌幅(changePercent 的算術平均)、上漲家數(changePercent > 0)、下跌家數(< 0)、總家數。
   - 排除當日無成交(volume = 0 或無資料)的股票,不計入分母。
   - 依 avgChangePercent 由高到低排名寫入 rank。
   - upsert by `[sectorId, date]`。
   - 若該日 `DailyQuote` 無任何資料(非交易日),直接 return,不報錯。
2. CLI 進入點:
   - `npx tsx scripts/calculate-industry-heat.ts` → 算最近一個交易日。
   - `npx tsx scripts/calculate-industry-heat.ts --backfill 20` → 從最近交易日往回補 20 個「有 DailyQuote 資料的日子」(不是日曆日 20 天)。
3. 執行回補 20 個交易日,完成後抽查:印出最近一日的產業排名前 5 名與各自的平均漲跌幅,人工目視是否合理。

此步驟是純資料庫計算,zero API call,先做可以順便驗證 schema 設計。

---

## Step 3:估值抓取(TWSE + TPEx)

建立 `scripts/fill-gap-valuation.ts`,匯出 `fillOneDayValuation(date: Date)`。

### 3a. TWSE(已實測確認可行)

端點:`https://www.twse.com.tw/exchangeReport/BWIBBU_d?response=json&date=YYYYMMDD&selectType=ALL`

已驗證事實:

- 全市場一次回傳(實測涵蓋 1101~9958,約 1000 檔普通股),可用 `date` 查歷史。
- 欄位順序:`證券代號, 證券名稱, 收盤價, 殖利率(%), 股利年度, 本益比, 股價淨值比, 財報年/季`。
- 本益比缺值時為 `"-"`(虧損公司),寫入 null。殖利率可能為 `"0.00"`,照實存。
- 數字可能含千分位逗號(如 `"1,475.00"`),parse 前要去逗號。
- 若用 `response=csv` 會拿到 Big5(ms950)編碼,需轉碼;**優先用 `response=json`**,若 json 回傳格式異常再 fallback csv + iconv-lite 轉碼。
- 非交易日回傳的 `stat` 欄位不是 `"OK"`,比照 MI_INDEX 的處理方式跳過。
- 日期欄位是民國年(如 `115年08月17日`),民國年 + 1911 = 西元年。

**開發時先驗證兩件事**(寫個臨時測試或直接在腳本開發時確認):

1. `date` 參數帶歷史日期(如 20260601)時,回傳的資料日期確實是該日,不是最新日。(注意:回傳標題裡的日期是民國年格式,要轉換後比對。)
2. 回傳筆數與 Stock 表中 `market = TWSE` 的普通股筆數量級一致(允許小幅差異,新上市/下市造成)。差異超過 5% 要 log warning。

### 3b. TPEx(端點未實測,需先探索)

TPEx 有對應的「上櫃股票個股本益比、殖利率、股價淨值比(依日期查詢)」查詢頁面。開發時:

1. 先到 `https://www.tpex.org.tw` 的上櫃盤後資訊區找到該頁面,從瀏覽器開發者工具找出實際的資料端點(TPEx 舊版端點通常在 `/web/stock/aftertrading/` 路徑下,回傳 JSON)。
2. 也可測試 OpenAPI 版本 `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis`(此端點存在但可能只給最新一天,且不確定欄位,需實測)。
3. 確認後比照 TWSE 的方式寫入,`source = "TPEX"`。注意 TPEx 日期參數格式可能是民國年(如 `115/08/17`),與 TWSE 的西元 YYYYMMDD 不同,實測確認。
4. 若 TPEx 歷史查詢端點找不到或不穩定,退而求其次:只抓最新一天(OpenAPI 版),並在交接文件註明此限制。

### 3c. 寫入規則

- upsert by `[stockCode, date]`。
- 只寫入 Stock 表已存在的代號(join 過濾),被過濾掉的代號 log 出來(數量即可,不用逐檔)。
- 先執行「抓今天(最近交易日)」即可,不回補歷史。腳本要支援 `--date YYYYMMDD` 參數,日後想回補隨時可補。

---

## Step 4:股本更新(月頻)

建立 `scripts/update-shares-outstanding.ts`:

資料源(已實測確認):

- 上市:`https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv`
- 上櫃:`https://mopsfin.twse.com.tw/opendata/t187ap03_O.csv`(未實測,但與 _L 同系列,欄位結構應一致,開發時確認)

已驗證事實:

- CSV 為 UTF-8(含 BOM,parse 時去 BOM)。
- **最後一欄「已發行普通股數或TDR原股發行股數」直接就是股數**,直接取用。
- **絕對不要**用「實收資本額 ÷ 面額」推算——面額不是每家都 10 元(實測案例:國巨 2327 面額為 2.5 元),用固定面額會算錯。
- 欄位「公司代號」對應 Stock.code。

寫入規則:

- 更新 `Stock.sharesOutstanding` 與 `sharesOutstandingUpdatedAt`。
- CSV 中有但 Stock 表沒有的代號:跳過並 log(可能是特別股或未入庫標的)。
- Stock 表有但 CSV 沒有的:log warning,不動原值。
- 此腳本獨立執行,不進 daily pipeline;先手動跑一次,之後每月跑一次即可(可在交接文件註記,暫不設排程)。

市值不落地存欄位:要用時以 `sharesOutstanding × 當日收盤價` 現算。

---

## Step 5:整合與驗證

1. 將 `fillOneDayValuation` 與 `calculateOneDayHeat` 接進 `daily-pipeline.ts`,順序放在 DailyQuote 抓取與 TechnicalIndicator 計算之後(熱度依賴當日 DailyQuote)。
2. 驗證冪等性:同一天重跑兩次 pipeline,資料筆數不變。
3. 驗證失敗路徑:估值端點失敗時不能中斷整條 pipeline(catch + log,其餘步驟照跑)。
4. 完成後更新交接文件:新增三個資料表用途、資料源端點與已知限制(TPEx 歷史查詢能力、股本月頻更新方式)。

## 明確不做的事

- 不建 heatScore 欄位、不做市值加權熱度(第一版等權即可)。
- 不做題材/概念股 Tag 的自動化(維持手動)。
- 不回補估值歷史(腳本支援即可,不執行)。
- 不將股本更新排進 daily pipeline。