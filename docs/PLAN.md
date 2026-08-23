# 開發指令:突破強度篩選腳本(breakout-strength)

## 背景與定位

這是 Layer 1「自動選股」的核心腳本:回答「今天市場的焦點在哪」。目標是篩出**帶量帶價第一根突破布林**的股票,並依訊號強度排名。

- 完全不呼叫 LLM、零新外部 API,所有輸入都來自現有資料庫(DailyQuote / TechnicalIndicator / Stock)。
- 新建獨立腳本 `calculate-breakout-strength.ts`,**不修改** `run-screener.ts`(既有條件式篩選保留)也**不修改** `calculate-screen-score.ts`(九因子腳本擱置,但可以從它複製 `rankScore` 函式與 60 日報酬的查詢邏輯來重用)。
- 比照既有腳本模式:匯出 `calculateBreakoutStrength(date: Date)` 函式、CLI 支援 `--date=YYYY-MM-DD`(預設最新交易日)、非交易日優雅跳過、`isMain` 判斷。

## 重要前提:資料庫歷史深度目前只有約 90 個日曆日

資料庫目前只回補了約 90 個日曆日(約 60 個交易日)的 DailyQuote,**之後會回補更長歷史**。因此所有需要回看歷史的計算(240 日高點、帶寬百分位等)必須寫成「**視窗上限 N 天,實際用現有資料,不足時降級**」的形式,並在輸出中記錄每檔股票實際用到的歷史天數(`historyDays`),讓使用者知道哪些分數是在資料不足下算的。**未來歷史補齊後,不需要改任何程式碼,同一支腳本自動用滿視窗。**

具體降級規則寫在各評分項裡,通則:有效歷史 ≥ 最低門檻就照算(用現有資料當視窗),低於最低門檻該項給中性 50 分並在該股票的輸出標記 `degraded: true`。

## 篩選結構:觸發 → 資格門檻 → 強度評分

### 第一層:觸發條件(boolean,兩個都要成立才進入候選)

1. **帶價**:今日收盤 > 今日 `bollingerUpper`
2. **帶量**:今日 `volume` / `volumeMa20` ≥ 2.0

`bollingerUpper` 或 `volumeMa20` 為 null(新股資料不足)的直接不進候選。

### 第二層:資格門檻(boolean,寫成檔案頂部的 const 方便調整)

1. **市值下限**:`sharesOutstanding × close` ≥ 50 億(台幣)。`sharesOutstanding` 為 null 時視為不通過並單獨計數 log(不是靜默丟掉)。
2. **成交量下限**:今日成交量 ≥ 1000 張(1,000,000 股)。

### 第三層:強度評分(對通過前兩層的股票,每項 0~100,加權合併)

所有評分公式都是**單調遞增**邏輯(越極端分數越高),不用鐘形曲線、不設追高懲罰——這條路徑的哲學跟九因子腳本相反,務必不要複製九因子裡 momentum/activity 的中庸式公式。

**權重(檔案頂部 const):**

```typescript
const WEIGHTS = {
  volumeStrength: 0.20,   // 量能倍數
  breakoutMargin: 0.15,   // 突破幅度
  firstBar: 0.20,         // 第一根判定
  base: 0.20,             // 位階（盤整品質）
  proximityToHigh: 0.15,  // 距高點位置
  relativeStrength: 0.10, // RS 相對強度
};
```

#### 3a. volumeStrength(量能倍數)

`ratio = volume / volumeMa20`。觸發保證 ratio ≥ 2。評分:2 倍 = 40 分,6 倍以上 = 100 分,中間線性;超過 6 倍不再加分(clip 在 100)但也不扣分。

#### 3b. breakoutMargin(突破幅度)

`margin = (close - bollingerUpper) / bollingerUpper × 100`(單位 %)。評分:0% = 40 分,3% 以上 = 100 分,線性,clip。

#### 3c. firstBar(第一根判定)

需要 T-1(前一交易日)的收盤價與布林上軌:

- 昨日收盤 ≤ 昨日 `bollingerUpper` → **100 分**(今天是第一根,含「回檔後第一根」——回檔期收盤會回到帶內,再突破時昨日自然在帶內)
- 已連續 2 天收盤在上軌之上(含今天)→ 50 分
- 連續 3 天以上 → 20 分

實作:往回逐日檢查收盤 vs 當日上軌,數出「含今天在內連續收在上軌上方的天數」。昨日指標缺資料時本項 50 分 + `degraded`。

#### 3d. base(位階/盤整品質)——**全部只用 T-1 以前的資料,突破棒本身不參與**

這是本腳本最重要的實作細節:今天的大波動棒會撐大今天的帶寬,若用 T 日資料測壓縮,越漂亮的突破位階分數反而越低。因此:

- **壓縮深度**:取 T-1 的 `bollingerBandwidth`,計算它在「該股票自己 T-1 往前最多 240 個交易日的 bandwidth 分布」中的百分位 `p`(0~100,越低代表壓縮越深)。`depthScore = 100 - p`。
- **壓縮時長**:從 T-1 往回數,連續多少個交易日 bandwidth 低於「自己該歷史視窗的第 25 百分位」。`durationScore = min(天數 / 40, 1) × 100`(壓縮 40 天以上滿分)。
- `base = depthScore × 0.6 + durationScore × 0.4`
- **降級規則**:有效歷史(有 bandwidth 值的天數)< 40 天時,本項 50 分 + `degraded: true`。目前資料庫約 60 個交易日,大多會用 ~59 天的視窗算,可接受;歷史補齊後自動變成 240 日視窗。

#### 3e. proximityToHigh(距高點位置)

兩個時間尺度,各算 `r = 今日收盤 / 視窗內最高收盤價`(視窗含今天,今天創新高則 r ≥ 1):

- 短:60 個交易日視窗
- 長:240 個交易日視窗(**目前歷史不足時用現有全部歷史,並標記 `degraded`;不足 60 個交易日時本項整體 50 分**)

單一尺度評分:`r ≥ 1 → 100 分`;`r < 1` 時 `clip((r - 0.7) / 0.3 × 100, 0, 100)`(距高點 30% 以上 = 0 分,線性)。

`proximityToHigh = 短尺度 × 0.5 + 長尺度 × 0.5`。歷史不足導致長短視窗實際上相同時照算,不要特判。

#### 3f. relativeStrength(RS 相對強度)

- 對**全市場所有普通股**(不只候選股)計算 60 日報酬率:`(今日收盤 - 60 個交易日前收盤) / 60 個交易日前收盤 × 100`。查詢邏輯可直接重用 `calculate-screen-score.ts` 裡抓 61 筆取最舊的做法。
- 用 `rankScore`(從九因子腳本複製過來)做全市場橫向百分位,報酬越高百分位越高,百分位就是分數。
- 歷史不足 60 個交易日的股票:有多少算多少(例如只有 40 天就算 40 日報酬),但 `historyDays` 要如實記錄;完全算不出來(只有 1 天資料)給 50 分 + `degraded`。
- **注意:RS 排名的母體是全市場,必須在觸發/門檻過濾之前先對全市場算好**,再查候選股的百分位——不能只拿候選股互相排名,那會失去「跟市場比」的意義。

### 合併

`totalScore = Σ(score × weight)`(權重總和已是 1,不需再正規化)。依 totalScore 由高到低排序,rank 從 1 起。

## 輸出

比照 `run-screener.ts`:不寫資料庫,輸出 JSON 到 `data/breakout-strength-results/{date}.json`:

```jsonc
{
  "date": "2026-08-18",
  "gates": { "minMarketCap": 5000000000, "minVolumeShares": 1000000 },
  "weights": { /* WEIGHTS 原樣 */ },
  "stats": {
    "totalStocks": 1947,        // 當日全市場普通股數
    "triggered": 23,            // 通過觸發條件
    "passedGates": 15           // 通過資格門檻（= results 長度）
  },
  "results": [
    {
      "code": "2330", "name": "台積電",
      "close": 1100, "changePercent": 4.2,
      "volumeRatio": 3.1,
      "scores": { "volumeStrength": 56.5, "breakoutMargin": 73.3, "firstBar": 100, "base": 81.2, "proximityToHigh": 100, "relativeStrength": 88.4 },
      "totalScore": 83.1,
      "rank": 1,
      "historyDays": 59,
      "degraded": ["proximityToHigh240"]   // 哪些子項降級過，空陣列代表全部足量
    }
  ]
}
```

console 印出全部候選(通常量不多)的表格:rank / 代號 / 名稱 / 收盤 / 漲跌幅 / 量比 / totalScore / degraded 註記。

## 驗證(執行完必做)

1. 跑最新交易日,肉眼檢查候選名單:每一檔都應該是當天確實帶量突破的股票(可抽 2 檔對照看盤軟體確認當天真的突破布林上軌且量 ≥ 2 倍均量)。
2. 抽 1 檔手動核對 firstBar:確認它昨天收盤真的在上軌之下。
3. 確認 stats 三個數字合理遞減(totalStocks > triggered > passedGates)。
4. 同一天重跑兩次,輸出完全一致(純確定性,無隨機)。
5. 挑一檔 `sharesOutstanding` 為 null 的股票確認它被門檻擋下且有計數 log,而不是造成 crash。

## 明確不做的事

- 不呼叫 LLM、不抓籌碼/新聞/任何新 API。
- 不修改 `run-screener.ts`、`calculate-screen-score.ts`、`daily-pipeline.ts`(先獨立跑,穩定後再討論是否接進 pipeline)。
- 不寫資料庫、不建新表。
- 不做「連續大漲 N%」之類的追高型動能項。
- 不做回檔擺動點偵測(回檔後第一根已由 firstBar 的「昨日在帶內」邏輯自然涵蓋)。