# Stock Agent

台股觀察/分析 agent 的後端資料層。抓取證交所（TWSE）與櫃買中心（TPEx）公開資料與 FinMind API，存進 PostgreSQL，透過 Claude Code 互動式地做篩選、族群分析、新聞整合等工作。

## 目前功能

- `top20-gainers.js`：抓取當日 TWSE + TPEx 收盤資料，篩選出一般股票（排除 ETF、權證、特別股等），依漲幅排序（尚未整合進資料庫）。
- `scripts/backfill-daily-quotes.ts`：用 FinMind API 逐支股票回補近期歷史報價至 `DailyQuote`。
- `scripts/fill-gap-mi-index.ts`：用證交所 `MI_INDEX` 報表 API 一次補齊指定單一天的全上市市場報價，並自動新增資料庫沒有的股票記錄。
- `scripts/calculate-technical-indicators.ts`：計算 MA5/10/20/60、布林通道、量能均線等技術指標。
- `scripts/run-screener.ts`：依條件（`scripts/screener-conditions.json`）跑全市場篩選，產出候選觀察股清單。
- `scripts/daily-pipeline.ts`：每日排程主控腳本，串接以上缺漏檢查、補齊、算指標、跑篩選流程。

## 環境需求

- Node.js
- PostgreSQL

## 環境變數

在專案根目錄建立 `.env`：

```
DATABASE_URL="postgresql://<user>:<password>@localhost:5432/stock_agent?schema=public"
FINMIND_API_KEY="<可選，未設定則使用未註冊額度 300次/小時>"
```

## 使用方式

```bash
# 初次建置資料庫（股票清單 + 產業別）
npx prisma db seed

# 逐支股票回補歷史報價
npx tsx scripts/backfill-daily-quotes.ts

# 補齊指定單一天的全市場報價
npx tsx scripts/fill-gap-mi-index.ts --date=2026-08-14

# 計算技術指標
npx tsx scripts/calculate-technical-indicators.ts

# 跑篩選
npx tsx scripts/run-screener.ts

# 每日主流程（缺漏檢查 → 補齊 → 算指標 → 跑篩選）
npx tsx scripts/daily-pipeline.ts

# 舊版：不寫入資料庫，只印出當日漲幅前 20 名
node top20-gainers.js
```

## 專案規劃

詳見 [docs/PLAN.md](docs/PLAN.md)。
