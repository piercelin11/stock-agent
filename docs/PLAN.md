# 開發指令:screen_score 全市場評分腳本

## 背景與原則

延續既有專案原則:確定性運算全部用程式碼寫死,**這個腳本完全不呼叫任何 LLM**,零額外外部 API 呼叫(所有輸入資料都已經在資料庫裡)。

這個腳本要做的事:針對「最新交易日」的全市場股票(`Stock.securityType = "stock"`),用類似 DSA `scorer.py` 的九因子加權概念,算出一個 0~100 的 `screenScore`,並輸出排名。這是一個**獨立於 `run-screener.ts` 的新功能**,不是取代它——`run-screener.ts` 的布林條件式篩選(布林突破+量增)繼續保留,兩者互補:一個是規則觸發式篩選,一個是全市場排名評分。

## Step 0(可選,建議一起做):補齊 stability/momentum/reversal 需要的指標

延伸 `calculate-technical-indicators.ts`,新增以下欄位到 `TechnicalIndicator`(全部可用現有 `DailyQuote` 的 open/high/low/close 歷史算出,不需新 API):

- `volatility20d`:近 20 個交易日「日報酬率」的標準差(百分比)
- `maxDrawdown20d`:近 20 個交易日內,從任一高點到之後低點的最大跌幅(百分比,負值)
- `atr20`:近 20 個交易日 True Range 的平均值(True Range = max(high-low, |high-prevClose|, |low-prevClose|))
- `rsi14`:14 日 RSI(標準公式:近 14 日漲幅平均 / (漲幅平均+跌幅平均) × 100)
- `macdStatus`:用 12/26/9 EMA 算 MACD 線與訊號線,回傳 `"bullish"`(MACD 線上穿訊號線後仍在上方)| `"bearish"`(下穿後仍在下方)| `null`(無明顯訊號)

這步驟做完 momentum/reversal/stability 三個因子才能跟 DSA 的公式對得上;不做的話這三個因子要用簡化版(只用當日漲跌幅,無 MACD/RSI/波動度加成),腳本要能在欄位為 null 時優雅降級,不能報錯。

## Step 1:建立 `calculate-screen-score.ts`

放在跟其他腳本同一目錄。匯出函式:

```typescript
export async function calculateScreenScore(date: Date): Promise<{
  date: string;
  scoredCount: number;
  isNonTradingDay: boolean;
}>
```

### 1a. 抓全市場快照

一次查詢組出當天所有 `Stock.securityType = "stock"` 的完整資料列,包含:

- `DailyQuote`(close, change, volume)
- `TechnicalIndicator`(ma5/10/20/60, bollinger 三值, volumeMa20, 以及 Step 0 補的五個新欄位,若沒做 Step 0 則這五個是 undefined)
- `StockValuation`(peRatio, pbRatio)
- `Stock.sharesOutstanding`
- `IndustryHeatSnapshot`(該股所屬 sectorId 當天的 avgChangePercent, rank, totalCount)
- 需要 60 個交易日前的收盤價(算 60 日漲跌幅用),用 `DailyQuote` 依 stockCode 抓最近 61 筆(含當天)取最舊一筆

若當天 `DailyQuote` 無資料(非交易日),直接 return `{ isNonTradingDay: true, scoredCount: 0 }`,不報錯,比照其他腳本的模式。

### 1b. 實作橫向百分位排名函式(對應 DSA 的 `_rank_score`)

```typescript
// 對應 python 版 _rank_score:cross-sectional percentile rank，0~100
// lowerIsBetter=true 時，數值越小排名分數越高（例如 PE、PB）
// naScore：該股票這個欄位缺值時給的預設分數
function rankScore(
  values: (number | null)[],
  lowerIsBetter: boolean,
  naScore: number,
): number[]
```

邏輯:過濾掉 null/NaN 值先排序算百分位(用「小於等於自己的個數 / 有效值總數 × 100」,`lowerIsBetter` 決定排序方向),null 值一律填 `naScore`。全部值都是 null 時,整批回傳 `naScore`。

**這個函式是全部因子計算的共用基礎,務必先寫好並用假資料單元測試過(至少測:全部有值、部分 null、全部 null 三種情況),再往下接九個因子。**

### 1c. 九個因子的計算規則

每個因子回傳 0~100。以下是每個因子的計算依據,**參數(base 值、斜率、上下限)可以抄 DSA `_DEFAULT_SCORING_PROFILE` 裡對應的值當初始值**,不需要重新調參:

- **value**:`peRatio` 排除 ≤0 或 ≥500 者後做 `rankScore(lowerIsBetter=true, naScore=25)`,`pbRatio` 排除 ≤0 或 ≥50 者後同樣處理;兩者依 DSA 的權重比例混合(PE 權重較高)
- **size**:市值 = `sharesOutstanding × close`,取 log10 後 `rankScore(lowerIsBetter=false, naScore=35)`(市值越大分數越高,注意方向不要反了)
- **liquidity**:成交金額 = `close × volume`,取 log10 後 `rankScore(lowerIsBetter=false, naScore=20)`
- **momentum**:base 60 分 + 當日漲跌幅 × 斜率,漲幅過大(追高風險)跟跌幅過大都要扣分(照 DSA `momentum_chase_start_pct`/`momentum_downside_start_pct` 那組參數);如果 Step 0 有做,疊加 60 日漲跌幅趨勢分(base 55)與 MACD 加減分(bullish +6 / bearish -8)
- **reversal**:以「跌約 3% 附近」為理想反彈起點,離這個值越遠扣分越多,跌過深(<-8%)額外扣分,漲過多(>1%,代表已經在噴了不是低接時機)也扣分;如果 Step 0 有做,RSI 超賣(oversold)加分、超買(overbought)扣分
- **activity**:量比(volume/volumeMa20)以 2.0 倍為理想值,離理想值越遠扣分,過高（>5倍)額外扣分;換手率(volume/sharesOutstanding×100)以 4% 為理想值,同樣距離扣分+過高(>12%)額外扣分
- **stability**:base 78 分,當日漲跌幅絕對值越大扣越多分,PE 為負(代表虧損)額外扣分;如果 Step 0 有做,波動度過高(>45%)、最大回撤過深(<-12%)、ATR 過高(>6%)都要扣分
- **theme_heat**:直接讀該股所屬 sector 當天的 `IndustryHeatSnapshot.avgChangePercent`,以 base 50 分 + 漲跌幅 × 斜率 6.0,再依 `rank`(排名前 10 名內)給額外加分(`(10 - rank).clip(0) `,越前面加越多);若當天沒有該 sector 的 heat 資料(例如新股沒分類),給中性 50 分
- **topic_alignment**:目前沒有題材 Tag 系統,**固定給 50 分(中性)**,不用實作任何邏輯,直接寫死;等哪天要做題材比對系統時再回來改這個因子

### 1d. 加權合併

```typescript
const WEIGHTS = {
  value: 0.15,
  liquidity: 0.10,
  momentum: 0.20,
  reversal: 0.10,
  activity: 0.15,
  stability: 0.10,
  size: 0.10,
  theme_heat: 0.10,
  topic_alignment: 0, // 目前固定中性分，不參與加權（權重設0，等未來題材系統做好再調整）
};
```

這組權重是初始值,寫成 `const` 方便你之後手動調整,不用做成 config 檔案(除非你之後想要,那是額外工作,先不做)。加權後 `screenScore = Σ(factorScore × weight) / Σ(weight)`(注意 topic_alignment 權重是 0,分母要用「有效權重總和」而不是固定除以 1,避免你之後調權重時忘記要重新正規化)。

### 1e. 輸出

比照 `run-screener.ts` 的模式,不寫進資料庫,輸出成排名 JSON:

```
data/screen-score-results/{date}.json
```

內容包含:`date`、每檔股票的 `code/name/screenScore/九個因子分數明細/rank`,依 `screenScore` 由高到低排序。同時 console.log 印出前 20 名(代號/名稱/總分)方便肉眼檢查。

CLI 支援 `--date=YYYY-MM-DD`,不帶參數時用最新一個有 `DailyQuote` 資料的交易日。

## Step 2:單元驗證(執行完務必做,不是可選)

1. 跑一次,印出的前 20 名肉眼檢查是否合理(比如知名權值股不該分數異常低、明顯地雷股不該分數異常高)。
2. 抽查 2~3 檔股票,手動核對某個因子的計算過程(比如挑一檔 PE 很低的股票,確認 value 分數確實偏高)。
3. 確認全部值為 null 的邊界情況不會讓腳本崩潰(例如某檔新上市股票還沒有 60 日歷史)。

## 明確不做的事

- 不呼叫 LLM,不做 DSA 那種軟排名重排。
- 不修改 `run-screener.ts` 既有邏輯,兩個腳本並存。
- 不做 `topic_alignment` 的實際計算,固定中性分數。
- 不把結果寫進資料庫,先用 JSON 檔案輸出(跟 `run-screener.ts` 一致);如果之後真的需要歷史查詢或前端要讀取,再另外討論要不要建表。
- 不接進 `daily-pipeline.ts`(先獨立驗證這支腳本本身邏輯正確,穩定後再考慮是否要接進每日流程)。