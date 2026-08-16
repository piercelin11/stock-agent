# Stock Agent

台股觀察/分析工具。抓取證交所（TWSE）與櫃買中心（TPEX）公開資料，篩選出當日漲幅前段的個股，未來會存入 PostgreSQL 並透過 Claude Code 互動式地做族群分析、新聞整合等工作。

## 目前功能

- `top20-gainers.js`：抓取當日 TWSE + TPEX 收盤資料，篩選出一般股票（排除 ETF、權證、特別股等），依漲幅排序。

## 環境需求

- Node.js
- PostgreSQL（規劃中，詳見 [docs/PLAN.md](docs/PLAN.md)）

## 環境變數

在專案根目錄建立 `.env`：

```
DATABASE_URL="postgresql://<user>:<password>@localhost:5432/stock_agent?schema=public"
```

## 使用方式

```bash
node top20-gainers.js
```

## 專案規劃

詳見 [docs/PLAN.md](docs/PLAN.md)。
