# 股市觀察 Agent - Phase C:候選股深度資料抓取

## 背景

`scripts/run-screener.ts` 已經會產出 `data/screener-results/{日期}.json`(例如 `data/screener-results/2026-08-18.json`),裡面是當天篩選出的候選股清單。這次任務要寫一支腳本,讀取這份候選清單,針對每一支候選股,補抓籌碼面、基本面、消息面資料,寫進資料庫。

**這次任務不涉及**:全市場資料、技術指標(那些已經在 Phase A/B 完成),也不涉及 AI 報表產出(那是 Phase D)。這次純粹是「資料補強」,結束時資料庫裡應該要有候選股完整的四個面向資料可查。

---

## 任務 1:Schema 微調(如果需要)

檢查 `NewsArticle` model,**確認 `link` 欄位有沒有唯一性約束**,如果沒有,加上去(避免同一則新聞被不同候選股的抓取流程重複寫入):

```prisma
model NewsArticle {
  // ...既有欄位
  link String @unique
}
```

如果需要異動,執行對應的 migration。

---

## 任務 2:撰寫 `scripts/fetch-candidate-details.ts`

**用法**:
```
node scripts/fetch-candidate-details.js --date=2026-08-18
```
(若不帶 `--date`,預設讀取 `data/screener-results/` 目錄下最新的一份 JSON 檔)

### 執行邏輯

```
1. 讀取對應的 screener-results JSON 檔,取出候選股代號清單
2. 對每一支候選股代號,依序(for + await,不要平行處理)執行以下四個步驟:

   a. 籌碼面:呼叫 FinMind TaiwanStockInstitutionalInvestorsBuySell
      - data_id = 該股票代號
      - 日期區間:近30天
      - 逐筆 upsert 進 InstitutionalTrading(唯一鍵 stockCode + date)
      - 欄位對應:外資買賣超 → foreignNetBuy、投信買賣超 → investmentTrustNetBuy、
        自營商買賣超 → dealerNetBuy(請先呼叫一次確認 FinMind 實際回傳的欄位名稱,
        對應到我們 schema 裡的三個欄位,可能需要做欄位名稱轉換)
      - source 欄位:填入該股票在 Stock 表裡對應的 market 值

   b. 基本面 - 月營收:呼叫 FinMind TaiwanStockMonthRevenue
      - data_id = 該股票代號
      - 日期區間:近12個月
      - 逐筆 upsert 進 MonthRevenue(唯一鍵 stockCode + year + month)

   c. 基本面 - 季報:呼叫 FinMind TaiwanStockFinancialStatements
      - data_id = 該股票代號
      - 日期區間:近8季(約2年)
      - 逐筆 upsert 進 FinancialStatement(唯一鍵 stockCode + year + quarter)
      - 注意:FinMind 這支資料集可能是「多筆細項組成一份財報」的格式(例如營收、毛利分別是不同列),
        請先呼叫一次確認實際回傳格式,再決定怎麼整理成我們 schema 裡「一列代表一季」的結構

   d. 消息面:呼叫 FinMind TaiwanStockNews
      - data_id = 該股票代號
      - 日期區間:近14天
      - 對每一則新聞,用 link 欄位檢查資料庫裡是否已經存在(避免重複寫入)
        - 不存在 → 新增進 NewsArticle
        - 已存在 → 略過建立,但仍需確保 NewsStock 有對應這支股票的關聯記錄
          (同一則新聞可能與多支候選股都相關,要能對應到多支股票)

3. 每處理完一支候選股,印出進度(例如「已處理 5/30 檔:2330 台積電」)
4. 每次 API 呼叫之間加入約6秒延遲(維持之前的節流慣例)
5. 全部完成後,印出總結:
   - 處理了幾檔候選股
   - 各類別分別寫入了幾筆(籌碼/月營收/季報/新聞)
   - 有沒有任何一支股票的某個步驟失敗(列出失敗的股票代號+步驟+錯誤原因,方便之後重跑)
```

### 錯誤處理原則

**單一步驟失敗,不要讓整支腳本中斷**——例如某支股票的新聞抓取失敗,應該記錄下來、繼續處理下一支股票的下一個步驟,而不是整個流程停掉。最後的總結報告要清楚列出哪些地方失敗了,方便你決定要不要針對性重跑。

---

## 任務 3:驗證

腳本執行完後,幫我確認:

1. 隨機挑 2-3 檔候選股,分別查詢 `InstitutionalTrading`、`MonthRevenue`、`FinancialStatement`、`NewsArticle`(透過 `NewsStock` 關聯),確認資料格式合理、數字看起來正常
2. 確認 `NewsStock` 的多對多關聯運作正常(如果有新聞同時關聯到多支候選股,檢查有沒有正確建立多筆關聯記錄)

---

## 暫不處理(明確排除,留待之後決定)

- **TaiwanStockPER(估值/本益比)**:這個資料是「隨股價每天變動」的性質,比較適合掛在 `DailyQuote` 而不是 `FinancialStatement`(因為 FinancialStatement 是季度性質,PER 卻是每日的)。這次先不做,等之後確定要加,再另外討論要不要在 `DailyQuote` 加 `pe`/`pb` 欄位。
- **Yahoo 股市 RSS 補充新聞來源**:規劃中,這次只用 FinMind 的新聞資料集。
- **市值(TaiwanStockMarketValue)**:上次提過可以加在 `Stock` 表上,這次先不做,之後有需要再補。

---

## 執行順序提醒

任務1(schema檢查)→ 任務2(撰寫並執行腳本)→ 任務3(驗證)。任務2執行前,先確認一下候選股數量(從 JSON 檔案數一下),讓我知道大概要跑多久(依候選股數量 × 4次呼叫 × 6秒估算),不用等跑完才知道時間。