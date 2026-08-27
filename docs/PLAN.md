# 盤後選股 v2（投信吃貨訊號）— `calculate-accumulation-score.ts`

## 背景與目標

ROADMAP 第 1 階段。現有 `calculate-breakout-strength.ts` 抓「已發生的帶量突破事件」（門檻式篩選）。本任務做互補的「醞釀期」偵測：找**還沒**出現第一根突破、但籌碼/技術面已在蓄勢的股票（投信默默建倉 + 帶寬收斂 + 窒息量）。

計分採**乘法結構**：`最終分數 = 籌碼分數 × 技術就緒係數`。籌碼是主因，技術面只放大或抑制它、不能取代它。不用硬門檻（連續係數取代 cliff 式篩選），因為「投信連買幾天算數」「集中度多高算高」這些數字還沒被資料庫實際分布驗證過，先跑排名結果再肉眼/回測校準參數。落地方式比照 `calculate-screen-score.ts`：純函式、匯出 `calculateAccumulationScore(date)`、結果寫 JSON 不寫資料庫。

已納入的落地細節：a/b 重疊改用「因子 b 排除投信」從結構上消除（非事後校準）、連續天數脆弱性改用頻率型指標、淨額帶正負號、視窗加總（非逐日比例平均）、絕對流動性下限（pool eligibility）、與突破清單互斥、輸出格式對齊突破腳本以利回測。

## 資料現況（已確認，無前置作業）

`InstitutionalTrading` 已完整回補：324 個交易日（2025-05-02 → 2026-08-26）、589,786 筆、1,989 檔股票。投信 / 其他法人分數的 20 天視窗有充足歷史。（PROGRESS.md line 28「backfill 從未執行」為過時註記，實際已跑過，收尾時順手更正該行。）

## 設計

### 新檔案

- **`scripts/accumulation-shared.ts`** — 純函式庫（無 Prisma/CLI），比照 `breakout-shared.ts`。放常數（權重、視窗天數、`MIN_AVG_VOLUME_SHARES`、`READINESS_FLOOR`）與各評分函式、`computeReadinessCoefficient`、`combineFinalScore`。
- **`scripts/calculate-accumulation-score.ts`** — 主腳本，比照 `calculate-screen-score.ts` 結構（`buildSnapshots` → 算籌碼分數 + 技術就緒係數 → 相乘排名 → 寫 `data/accumulation-score-results/{date}.json`）。

### 重用既有程式

- `computeBase(latestBandwidth, bandwidthHistory)` — `breakout-shared.ts:215`，**直接 import**。它算的就是「帶寬歷史百分位（深度）+ 低帶寬持續天數」，即壓縮度分數。口徑與突破腳本一致，未來兩系統結果可對比。需 ≥40 天歷史（`BASE_MIN_HISTORY_DAYS`），不足回傳 `{degraded:true}`。
- `fetchHistoryWindow(prisma, asOfDate, codes, maxDays)` — `breakout-shared.ts:58`，抓 close + bollingerBandwidth 視窗，餵給 `computeBase` 與窒息量的多日量比。
- `rankScore(values, lowerIsBetter, naScore)` — `breakout-shared.ts:28`，各子指標轉 cross-sectional 百分位。**維持 codebase 一致的正規化風格，不另發明算法。**
- `clip` — `breakout-shared.ts:47`。
- 常數命名慣例：比照 `RS_WINDOW_DAYS` / `BASE_MAX_WINDOW_DAYS`（`accumulation-shared.ts` 定 `INSTITUTIONAL_WINDOW_DAYS = 20`、`SQUEEZE_VOLUME_WINDOW_DAYS = 5`、`MIN_AVG_VOLUME_SHARES = 500_000`、`READINESS_FLOOR = 0.5` 等，寫死不留活動範圍）。
- 候選池查詢比照 `fetchTodayQuotes` — `calculate-breakout-strength.ts:52`（`securityType: "stock"`）。

### 候選池資格篩選（pool eligibility，非訊號門檻）

在算分數前先排除：

1. **`close > bollingerUpper`**（今日已站上上軌）→ 與 `calculate-breakout-strength.ts:131` 的觸發條件互斥，兩份清單天生不重疊。需當日 `TechnicalIndicator.bollingerUpper`。
2. **絕對流動性下限**：近 20 日均量（`TechnicalIndicator.volumeMa20`）低於 `MIN_AVG_VOLUME_SHARES`（初值 500_000 股 = 500 張，寫在 shared 常數）→ 剔除長期沒人交易的死股，避免「量/均量」比值天生不穩的冷門股系統性霸榜。
3. `volumeMa20` 為 null 或 ≤ 0 → 無法算窒息量，剔除。

`sharesOutstanding` 為 null **不**剔除（投信分數對該股 degraded 給中性分即可）。

### Step 1：籌碼分數（0~100，主排序依據）

`籌碼分數 = 投信分數 × 0.7 + 其他法人分數 × 0.3`
投信佔七成（主因子）；其他法人只當「確認性訊號」——外資/自營商方向與投信一致代表更多資金同步吃貨，不一致也不重扣、只是少加分。

**投信分數** — `InstitutionalTrading.investmentTrustNetBuy`，近 `INSTITUTIONAL_WINDOW_DAYS`(=20) 個交易日，兩子指標各半權重、各自 `rankScore` 正規化後合併：
- 子 1「買超頻率」= 窗內 `investmentTrustNetBuy > 0` 的天數 ÷ 有資料天數。頻率型，對偶發中斷一天不敏感、**不歸零**（連續天數只當次要參考記進 `detail`，不參與計分）。
- 子 2「買超佔發行量比例」= 窗內 `investmentTrustNetBuy` 淨額加總 ÷ `sharesOutstanding`（**帶正負號**）。`sharesOutstanding` 為 null → 此子項 degraded，投信分數只用子 1。
- `rankScore(lowerIsBetter=false)`。窗內有資料天數 < 一半 → 投信分數 degraded 給中性 50。

**其他法人分數** — 排除投信，只算外資 + 自營商，近 20 天：
- `otherInstitutionRatio = sum(foreignNetBuy + dealerNetBuy) / sum(DailyQuote.volume)` — **比例的加總**（非逐日比例平均，清淡日分母小會暴衝），**帶正負號**（倒貨為負）。
- 排除投信 → 從結構上消除與投信分數的雙重計數，不再需要事後正交化。
- `rankScore(lowerIsBetter=false)`。窗內資料不足 → degraded 給 50。

### Step 2：技術就緒係數（0.5~1.0，調節項）

`技術原始分 = 壓縮度分數 × 0.5 + 窒息量分數 × 0.5`（0~100）
`就緒係數 = READINESS_FLOOR + (1 - READINESS_FLOOR) × 技術原始分 / 100`（`READINESS_FLOOR = 0.5` → 映射到 0.5~1.0）

下限 0.5 是刻意設計：技術面完全沒收斂只把籌碼分數打對折，不歸零、不把股票從排名抹掉（「還沒收斂」≠「沒價值」，可能只是還沒到最佳進場點，肉眼校準時仍要看得到）。連續係數取代 cliff 式剔除，符合「不用硬門檻」原則。

- **壓縮度分數** — 直接 `computeBase(latestBandwidth, bandwidthHistory)`：`latestBandwidth` = 當日 `TechnicalIndicator.bollingerBandwidth`；`bandwidthHistory` = 往前最多 `BASE_MAX_WINDOW_DAYS`(=240) 筆（不含當日，`fetchHistoryWindow` 取）。degraded 由 `computeBase` 自帶（<40 天）。
- **窒息量分數** — 近 `SQUEEZE_VOLUME_WINDOW_DAYS`(=5) 天平均量比 `mean(DailyQuote.volume[t] / TechnicalIndicator.volumeMa20[t])`（多日平均，非單日，濾隨機低量雜訊）。比值越低越窒息、分數越高：`rankScore(lowerIsBetter=true)`。近5日資料不足3天 → degraded 給 50。
- 任一子項 degraded → 該子項用中性 50 續算（係數仍算得出），degraded 標記進輸出。

### Step 3：最終分數與輸出

`最終分數 = 籌碼分數 × 就緒係數`
「投信瘋買、技術面還沒收斂」→ 最終約為籌碼分數的 50~75%，仍排得進前段；「技術面完美收斂、無法人買盤」→ 籌碼分數本身趨近 0，乘上係數依然低，不會誤闖前排。

**待校準參數**（先給預設，跑完看前 20~30 名再調，全寫在 `accumulation-shared.ts` 常數）：

| 參數 | 初值 | 調整方向 |
|---|---|---|
| 籌碼分數內部：投信 / 其他法人 | 0.7 / 0.3 | — |
| 投信分數內部：頻率 / 佔比 | 0.5 / 0.5 | — |
| 技術原始分：壓縮度 / 窒息量 | 0.5 / 0.5 | — |
| `READINESS_FLOOR` | 0.5 | 技術面該壓更重 → 降到 0.3~0.2；不該壓那麼重 → 拉到 0.7 |

- 排名、印前 20~30 名到 console（比照 `calculate-screen-score.ts:376-381`），欄位含籌碼分數、就緒係數、最終分數、degraded。
- 輸出 `data/accumulation-score-results/{date}.json`：

  ```
  {
    date, windowDays: INSTITUTIONAL_WINDOW_DAYS,
    params: { chipWeights, trustSubWeights, techWeights, readinessFloor },
    poolStats: { totalStocks, excludedAboveBand, excludedIlliquid, scored },
    results: [
      { code, name, date, close,
        chipScore, readinessCoef, finalScore, rank,
        breakdown: { trustScore, otherInstScore, squeezeScore, quietVolumeScore },
        detail: { trustBuyFreq, trustConsecutiveDays, trustNetRatio,
                  otherInstRatio, squeezeDepthDays, avgVolumeRatio5d },
        degraded: string[] }
    ]
  }
  ```

  `code` + `date` 欄位格式與 `calculate-breakout-strength.ts` 輸出一致 → 之後可寫簡單比對腳本：取某天冷水區 top-N，掃描後續 N 個交易日的 `breakout-strength-results/*.json` 看命中率，驗證預測力。

- CLI：`--date=YYYY-MM-DD`，不帶則取最新 `DailyQuote` 日期。`main()` / `isMain` guard / `prisma.$disconnect()` 比照現有腳本。

## 不做（本版範圍外）

- 參數的資料驅動校準（先跑結果，肉眼看前 20~30 名再調上表參數）。
- 寫入資料庫、進 `daily-pipeline.ts`（比照 `calculate-screen-score.ts` / `calculate-breakout-strength.ts`，獨立手動執行）。
- 冷水區→突破命中率比對腳本（輸出格式已鋪好，腳本本身之後另寫）。

## 驗證

1. `npx tsx scripts/calculate-accumulation-score.ts --date=<最近交易日>`：
   - 確認 `poolStats` 合理（`excludedAboveBand` 應與當天突破腳本 `triggered` 量級相近；`excludedIlliquid` 剔掉數百檔冷門股）。
   - top 20~30 肉眼看：應多為近期橫盤收斂、量縮、投信小幅連續進的中小型股；**不應**出現長期無量的殭屍股（若出現，調高 `MIN_AVG_VOLUME_SHARES`）。
   - 檢查有無「投信瘋買但技術面沒收斂」的股票落在中前段（就緒係數 ~0.5~0.75）——這是乘法結構該有的行為；也確認「技術面收斂但無法人買盤」的股票確實在後段。
   - 檢查 `degraded` 分布：TPEx 標的在投信 / 其他法人分數 degraded 偏多屬預期。
2. 挑 2~3 檔 top 名次股票，手動用 `DailyQuote` / `InstitutionalTrading` / `TechnicalIndicator` 原始資料驗算 `detail` + `breakdown` 的中間值（投信買超頻率、其他法人集中度比例、近5日平均量比、帶寬百分位、就緒係數）。
3. 跑 `--date` 帶一個非交易日 → 應印「無 DailyQuote，跳過」並正常結束（比照 `calculate-screen-score.ts:359`）。
4. TypeScript 編譯無誤（`npx tsc --noEmit` 或專案既有 lint 流程）。

## 收尾

- `docs/PROGRESS.md`：新增段落記錄設計理由、實測數字、已知 caveats；順手更正 line 28「backfill-institutional-trading.ts 從未執行」（實際 `InstitutionalTrading` 已有 2025-05 起 324 個交易日的完整資料）。
- `docs/ROADMAP.md`：勾選第 1 階段 5 個子項；若全數完成，回覆中明確提醒使用者「盤後選股 v2 階段已全部完成」。
- `CLAUDE.md`「既有腳本」區塊：新增 `calculate-accumulation-score.ts` 與 `accumulation-shared.ts` 條目。
- `README.md`「目前功能」「使用方式」：補上新腳本。
