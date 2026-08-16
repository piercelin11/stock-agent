# 股市觀察 Agent - 專案初始化指令

## 專案背景

這是一個股市觀察/分析工具的後端專案。核心概念：用自己寫的腳本抓取台股資料（證交所/櫃買中心 OpenAPI + FinMind API），存進 PostgreSQL，之後透過 Claude Code 互動式地做篩選、族群分析、新聞整合等工作。這份文件是第一階段：把資料庫和專案骨架搭起來。

## 技術選型（已確認）

- **語言**：TypeScript（跟 Prisma 搭配有完整型別支援與自動補全，值得用）
- **ORM**：Prisma
- **資料庫**：PostgreSQL（本機，透過 pgAdmin 管理，資料庫已建立完成，名稱 `stock_agent`）
- **命名慣例**：Prisma model 用單數（`Stock` 不是 `Stocks`），欄位用 camelCase（`stockCode` 不是 `stock_code`）

## 環境變數

`.env` 裡的連線字串變數名稱用 Prisma 預設的 `DATABASE_URL`：

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

連線字串格式（我已經建立好空的 PostgreSQL 資料庫，密碼部分請換成你自己的）：
```
DATABASE_URL="postgresql://postgres:我的密碼@localhost:5432/stock_agent?schema=public"
```

---

## 任務清單

### 任務 1：專案初始化

1. `npm init -y`
2. 安裝套件：`prisma`、`@prisma/client`、`typescript`、`ts-node`、`@types/node`、`dotenv`
3. `npx tsc --init`（基本 TypeScript 設定即可，不用太複雜）
4. `npx prisma init --datasource-provider postgresql`
5. 建立 `.gitignore`，排除：`node_modules`、`.env`、`dist`、`*.log`
6. 建立資料夾結構：
   ```
   /prisma          -- schema.prisma、seed.ts、migrations（Prisma 自動管理）
   /scripts         -- 之後的資料抓取腳本放這裡（例如 top20 篩選腳本）
   /src             -- 共用邏輯（如果之後需要）
   ```

### 任務 2：撰寫 Prisma Schema

請依照以下設計撰寫 `prisma/schema.prisma`，這是完整的欄位規劃，可以直接使用，但如果你發現有更合理的寫法（例如更適合的型別、索引），可以調整並跟我說明原因：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum SecurityType {
  stock
  etf
  preferred
  warrant
  bond
  other
}

enum Market {
  TWSE
  TPEx
}

// 正式產業別（獨立 model，一支股票對應一個）
model Sector {
  id     Int     @id @default(autoincrement())
  name   String  @unique
  stocks Stock[]
}

// 股票基本資料
model Stock {
  code         String        @id
  name         String
  market       Market
  securityType SecurityType
  sectorId     Int?
  sector       Sector?       @relation(fields: [sectorId], references: [id])

  dailyQuotes  DailyQuote[]
  tags         StockTag[]
  newsLinks    NewsStock[]
  watchlistItem WatchlistItem?
}

// 概念題材（多對多，會動態變動）
model Tag {
  id     Int        @id @default(autoincrement())
  name   String     @unique
  stocks StockTag[]
}

model StockTag {
  stockCode String
  tagId     Int
  createdAt DateTime @default(now())

  stock Stock @relation(fields: [stockCode], references: [code])
  tag   Tag   @relation(fields: [tagId], references: [id])

  @@id([stockCode, tagId])
}

// 每日報價快取表
model DailyQuote {
  id        Int      @id @default(autoincrement())
  stockCode String
  date      DateTime
  open      Float
  high      Float
  low       Float
  close     Float
  volume    BigInt
  change    Float
  source    Market
  fetchedAt DateTime @default(now())

  stock Stock @relation(fields: [stockCode], references: [code])

  @@unique([stockCode, date])
  @@index([date])
}

// 新聞
model NewsArticle {
  id             Int      @id @default(autoincrement())
  title          String
  link           String
  source         String
  publishedAt    DateTime
  sentiment      String?
  sentimentScore Float?
  createdAt      DateTime @default(now())

  stocks NewsStock[]
}

model NewsStock {
  newsId    Int
  stockCode String

  news  NewsArticle @relation(fields: [newsId], references: [id])
  stock Stock       @relation(fields: [stockCode], references: [code])

  @@id([newsId, stockCode])
}

// 手動維護的正式觀察名單
model WatchlistItem {
  stockCode String   @id
  addedAt   DateTime @default(now())
  notes     String?

  stock Stock @relation(fields: [stockCode], references: [code])
}

// AI 產出的分析結果歷史紀錄
model AnalysisResult {
  id        Int      @id @default(autoincrement())
  date      DateTime
  stockCode String?
  type      String   // "screener" | "watchlist_summary" | "sector_ranking" 等
  content   String
  createdAt DateTime @default(now())
}
```

完成後執行 `npx prisma migrate dev --name init`，確認 migration 成功、資料表在 PostgreSQL 裡建立完成。

### 任務 3：撰寫 Seed Script（動態逐筆寫入 Stock + Sector）

在 `prisma/seed.ts` 撰寫一支腳本，邏輯如下：

1. 呼叫 FinMind 的 `TaiwanStockInfo` dataset（不需要帶 `stock_id` 參數，會一次回傳全部股票清單）：
   ```
   GET https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo
   ```
2. 回傳的每一筆資料包含：`industry_category`（產業別）、`stock_id`（代號）、`stock_name`（名稱）、`type`（市場別，值為 `twse` 或 `tpex` 之類，需要對應到我們的 `Market` enum）
3. 對每一筆資料：
   - 先用 `industry_category` 的值，透過 `upsert` 確保 `Sector` 表裡有對應的資料列（沒有就新增，有就跳過）
   - 再用 `stock_id` 透過 `upsert` 寫入 `Stock` 表，關聯到剛剛對應的 `sectorId`
4. **securityType 判斷邏輯**：目前先用簡單規則判斷（之後可以再細化）：
   - 代號開頭是 `00` → `etf`
   - 代號結尾是英文字母且長度為 5（如 `1101B`）→ `preferred`
   - 代號恰好 4 位數字 → `stock`
   - 其他情況 → `other`
5. 印出處理進度（例如「已處理 500/2000 筆」），並在結束後印出總筆數、各 securityType 的統計數量方便檢查

在 `package.json` 加入 Prisma seed 慣例設定，讓之後可以用 `npx prisma db seed` 重複執行這支腳本：

```json
"prisma": {
  "seed": "ts-node prisma/seed.ts"
}
```

執行這支腳本，完成後幫我確認：
- `Stock` 表總筆數
- `Sector` 表總筆數
- 隨機列出 5 筆 `Stock` 資料（含關聯的 sector 名稱）供我肉眼檢查

### 任務 4：撰寫 CLAUDE.md

在專案根目錄建立 `CLAUDE.md`，內容至少包含以下區塊：

**專案目的**：簡述這是台股觀察/分析 agent 的後端資料層。

**資料表結構總覽**：列出目前 schema 裡的所有 model 及其用途（一兩句話說明每張表是做什麼的）。

**資料來源與限制**（這段很重要，之後每次開新對話都要讓 Claude Code 記得這些）：
- FinMind API：未註冊 300 次/小時，註冊後 600 次/小時；大部分 dataset 需要指定 `stock_id`（例外：`TaiwanStockInfo` 可一次拿全部）；`TaiwanStockNews` 只有標題/連結/簡短描述，沒有全文
- 證交所 OpenAPI（`openapi.twse.com.tw`）：免註冊免金鑰，一次可拿全上市市場當日資料（`STOCK_DAY_ALL`），官方未公布明確 rate limit，自行節流即可
- 櫃買中心 OpenAPI（`www.tpex.org.tw/openapi`）：同上，但欄位命名跟證交所不同，且回傳資料混合了股票/ETF/權證/可轉債，需要過濾
- 過濾規則：ETF 代號開頭為 `00`；權證名稱含「購」或「售」；可轉債代號為 4 碼股票代號 + 1-2 碼流水號（共 5-6 碼數字）；一般股票為恰好 4 碼數字

**開發慣例**：
- Prisma model 單數命名、欄位 camelCase
- 新增/更新基礎資料（股票清單、產業別）用 `npx prisma db seed`，不要每次手寫新腳本
- `.env` 的資料庫連線變數名稱是 Prisma 預設的 `DATABASE_URL`

**目前進度**：簡述目前已完成 schema + seed 基礎資料，尚未開始每日報價/新聞/篩選邏輯的開發（之後每次進度更新，麻煩幫我一併更新這個區塊）。

**既有腳本**：如果我之後把先前寫的漲幅排行 top20 腳本放進 `/scripts` 資料夾，麻煩在這裡註記它的用途和使用方式。

### 任務 5：收尾檢查

完成以上所有任務後，跑一次 `npx prisma studio`（Prisma 內建的資料庫瀏覽介面），確認可以正常開啟並看到剛剛 seed 進去的資料，截圖或描述結果讓我確認。

---

## 執行順序提醒

請照任務 1 → 2 → 3 → 4 → 5 的順序執行，**每完成一個任務先跟我回報結果**，不要一次把五個任務全部做完才回報——如果中途某個環節卡住（例如 seed script 資料格式跟預期不符），我們可以及早發現並調整。