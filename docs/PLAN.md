# 開發指令:盤中一次性快照篩選(intraday-snapshot)

## 背景與定位

這是一支**一次性手動執行**的腳本,不是常態輪詢、不接進 `daily-pipeline.ts`。用途:盤中(建議 12:00 左右,收盤前留有觀察時間)手動跑一次,快速看一下今天有哪些股票值得尾盤注意——本質上是「把 Layer 1(`calculate-breakout-strength.ts`)的判斷邏輯與六項強度評分,提前套用在盤中即時價格上」,不是一個新的獨立演算法。觸發層/評分層的計算函式與常數盡量與 `calculate-breakout-strength.ts` 共用(見下方「共用實作」),不重複實作同一套邏輯。

- 完全不呼叫 LLM。
- 新建獨立腳本 `check-intraday-breakout.ts`,不修改任何既有腳本。
- 資料源是社群逆向工程出來的 `mis.twse.com.tw` 即時報價系統,**非官方正式文件**,欄位可能無預警變動,腳本要對缺欄位/異常格式做防呆(見下方錯誤處理)。

## 資料源:MIS 即時報價

```
https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={批次代號}&json=1&delay=0
```

- `ex_ch` 格式:`tse_2330.tw|otc_6547.tw|...`,用 `|` 串接多檔。**上市用 `tse_` 前綴、上櫃用 `otc_` 前綴**——直接從資料庫 `Stock.market` 欄位判斷該用哪個前綴,不要像網路上的參考實作那樣「先猜 tse_、查不到再猜 otc_」,那樣會浪費一倍呼叫次數。
- 回傳 `{ msgArray: [...] }`,每個元素是縮寫欄位:`c`=代號、`n`=名稱、`z`=成交價、`o`=開盤、`h`=最高、`l`=最低、`y`=昨收、`v`=累計成交量(張)、`t`=最後成交時間、`d`=日期。
- **防呆**:`z`(成交價)可能是字串 `"-"` 代表尚無成交(例如今天完全沒交易的冷門股),這種要跳過不處理,不能直接 `parseFloat` 後當數字用。`v` 也可能缺失或為 `"-"`。

### 分批呼叫

- 每批最多 **120 檔**代號(避免網址過長被拒絕)。
- 批次之間 `sleep 1500ms`,避免短時間內大量請求觸發防爬蟲限流。
- 只查詢 `Stock.securityType = "stock"` 的代號(跟其他腳本一致,排除 ETF/權證/特別股)。
- 單一批次請求失敗(非 2xx、逾時)時:記錄失敗的代號清單、繼續下一批,**不要讓單一批次失敗中斷整個腳本**。腳本結束時印出總共有多少檔因批次失敗而缺資料。

## 篩選邏輯:比照 `calculate-breakout-strength.ts` 的觸發概念,但資料來源與量能換算不同

### 第一層:觸發條件(boolean)

1. **帶價**:即時成交價(`z`)> **昨日**(T-1)的 `bollingerUpper`。

   - 從資料庫查 T-1 的 `TechnicalIndicator.bollingerUpper`(當天還沒有今天的布林值,只能用昨天的當參考基準,這是刻意的設計,不是資料缺漏)。
   - T-1 布林值為 null 的股票直接跳過(不納入候選)。

2. **帶量(換算後)**:預估全天量 ≥ 今日 `volumeMa20` × 2.0。

   - 預估全天量計算方式:`estimatedFullDayVolume = 目前累計量(v) / elapsedRatio`
   - `elapsedRatio` = 從開盤(09:00)到查詢當下經過的時間,除以全天交易時間(09:00~13:30,共 4.5 小時)。**這個比例要用查詢當下的實際時間現算,不要寫死「12:00 = 67%」這種常數**,因為使用者可能不是剛好 12:00 執行。
   - **clip 到 [0.05, 1.0]**:算出原始 `elapsedRatio` 後,用 `Math.min(Math.max(elapsedRatio, 0.05), 1.0)` clip。下限 0.05 避免開盤剛開始幾分鐘時分母趨近 0 導致預估值爆炸;上限 1.0 對應「收盤後執行 = `v` 已經是完整全天量,不需要再放大」。
   - **警告拆成兩種情況,分別處理**(不是原本單一句「非盤中時段警告」):
     - 撞到下限(原始值 < 0.05,即開盤前執行):印出「⚠ 目前為開盤前,預估量能可能不準確」,`estimatedFullDayVolume` 用 clip 後的 0.05 計算(仍是不可靠的放大值,但至少不會除以趨近 0 爆炸)。
     - 撞到上限(原始值 > 1.0,即收盤後執行):**不印警告**。clip 後 `elapsedRatio = 1.0`,`estimatedFullDayVolume` 等於 `v` 本身,即完整全天成交量,數字是準確的,不該被當成「不準確」提示使用者。
   - `volumeMa20` 用**今日**的值(`TechnicalIndicator` 表裡如果今天已經有算過,理論上不會有,因為 pipeline 是收盤後跑;所以實際上會抓到 T-1 的 `volumeMa20`,這是預期行為,均量本身變動很慢,用前一天的沒問題,不需要额外處理)。

3. **MIS 資料日期與資料庫日期錯位偵測**(獨立於 elapsedRatio 警告,兩者描述不同問題,可能同時出現):

   - 從 MIS 回傳的任一筆資料取出 `d`(日期欄位,實作時先印出原始值確認格式再寫解析邏輯,可能是 `YYYYMMDD` 或 `YYYY/MM/DD`)。
   - 查資料庫目前最新一筆 `DailyQuote.date`。
   - **簡化為二分判斷**(專案目前沒有交易日曆表,無法正確判斷「隔一個交易日」以排除週末,例如週一執行、資料庫最新是上週五時字串相減不會剛好差 1 天,會誤判——因此不做「相差是否剛好一天」的判斷,只做「相不相同」):
     - MIS 日期 == 資料庫最新 `DailyQuote` 日期(即 MIS 資料還停在資料庫已有的那一天,代表 pipeline 尚未跑過,或現在是開盤前 MIS 顯示的是前一交易日殘值):印出「⚠ MIS 回傳資料日期({MIS日期})與資料庫最新 DailyQuote 日期相同,可能是開盤前或 pipeline 尚未執行,本次快照可能是重複查詢舊資料」,不中斷,繼續執行。
     - MIS 日期 != 資料庫最新 `DailyQuote` 日期:視為正常(MIS 資料比資料庫新),不印警告。

### 第二層:資格門檻(boolean,沿用 `calculate-breakout-strength.ts` 的門檻常數)

1. 市值下限:`Stock.sharesOutstanding × 即時成交價` ≥ 50 億(台幣)。`sharesOutstanding` 為 null 時不通過,計數 log。
2. 成交量下限(用預估全天量,不是即時量):`estimatedFullDayVolume` ≥ 1000 張。

### 第三層:強度評分(完整套用 `calculate-breakout-strength.ts` 的六項加權評分)

沿用收盤版的六項因子與 `WEIGHTS` 權重(`volumeStrength: 0.2`、`breakoutMargin: 0.15`、`firstBar: 0.2`、`base: 0.2`、`proximityToHigh: 0.15`、`relativeStrength: 0.1`),不另設一套盤中專用權重。四個依賴歷史窗的因子(`base`、`proximityToHigh`、`relativeStrength`、`firstBar` 的「連續天數」判斷)輸入本來就是 T-1(含)以前的資料,跟今天盤中價格無關,可直接重用收盤版的計算函式,不需要重寫邏輯:

- **`volumeStrength`**、**`breakoutMargin`**:用盤中即時數字算(即時價相對 T-1 `bollingerUpper` 的幅度、估算全天量相對 T-1 `volumeMa20` 的倍數),是六項裡唯一會隨查詢時間點變動的兩項。
- **`firstBar`**:「今日收盤 vs 今日上軌」改成「即時價 vs T-1 `bollingerUpper`」,其餘連續天數往回數的邏輯不變。
- **`base`**、**`proximityToHigh`**、**`relativeStrength`**:直接重用收盤版的計算函式與輸入(T-1 往前的歷史窗),同一天內查詢幾次數值都相同,這是預期行為,不是 bug。

**已知的權衡(使用者已確認接受)**:六項加權後,約 65% 的權重(`base` + `proximityToHigh` + `relativeStrength` + `firstBar`)來自同一天內不會變動的 T-1 歷史資料,只有約 35% 權重(`volumeStrength` + `breakoutMargin`)反映盤中當下狀況;而這 35% 與觸發層(第一層)判斷用的原始數字(突破幅度、量能倍數)本質上是同一組。因此盤中總分排名,昨天的位階/趨勢因子佔比較高,盤中波動的影響相對淡化——這是刻意選擇「跟收盤版評分邏輯一致、之後改一處兩邊同步」,以犧牲一些盤中敏感度為代價。

**共用實作**:把 `calculate-breakout-strength.ts` 裡的 `GATES`、`WEIGHTS`、`TRIGGER_VOLUME_RATIO` 三個常數,以及 `computeVolumeStrength`、`computeBreakoutMargin`、`computeFirstBar`、`computeBase`、`computeProximityToHigh`(含內部用的 `computeProximityScale`)、`computeMarketWideReturns`、`rankScore`、`clip` 這些純函式,抽到新檔案 `scripts/breakout-shared.ts`,兩支腳本都從這裡 import,不要各自複製一份。`calculate-breakout-strength.ts` 需要同步改成從 `breakout-shared.ts` import(而不是保留原本的內部定義),確保兩邊真的是同一份程式碼、不會日後各自改各自的分岔。`fetchHistoryWindow`(查 T-1 往前 N 筆 close+bollingerBandwidth)也一併抽出共用,因為兩支腳本都需要用同樣方式組出 `base`/`proximityToHigh` 的輸入。

## 輸出

不寫資料庫,但寫檔案留存快照:結果輸出至 `data/intraday-breakout-snapshots/{timestamp}.json`(檔名用完整時間戳記,格式 `YYYY-MM-DDTHH-mm-ss`,例如 `2026-08-24T12-03-17.json`,同一天可執行多次、互不覆蓋)。JSON 內容比照 `calculate-breakout-strength.ts` 的輸出慣例,包含查詢時間、`elapsedRatio`、門檻常數、權重(`WEIGHTS`)、統計數字(查詢總數/批次失敗數/觸發數/通過門檻數)、完整候選股列表(含即時價、漲跌%、六項分項分數、總分、排名、`degraded` 降級項目清單)。同時 console 輸出表格,依總分排序:

```
盤中快照篩選 —— 查詢時間: 2026-08-24 12:03:17 (今日經過時間比例: 68.5%)
⚠ 若非盤中時段執行，以下預估量能可能不準確

排名  代號   名稱      即時價   漲跌%   量比    總分    降級項目
1     2330   台積電    1100.0   +2.3%   2.4x    78.5    -
...

共查詢 1850 檔（因批次失敗缺漏 12 檔：略）
觸發帶價+帶量: 18 檔
通過資格門檻: 14 檔
```

CLI 直接執行、無參數(不支援 `--date`,因為這本質上是「現在」的快照,不是歷史查詢)。

## 驗證

1. 盤中實際執行一次,挑 2~3 檔候選股,對照看盤軟體確認即時價格跟成交量數字合理。
2. 手動測試 `elapsedRatio` 的警告邏輯:改一下系統時間或用假資料驗證開盤前(撞下限)會印出警告而不是 crash;收盤後(撞上限)則確認**不會**印警告、且 `estimatedFullDayVolume` 等於 MIS 回傳的 `v` 本身(對照看盤軟體今日總成交量吻合,不會被錯誤縮小)。
3. 確認批次失敗處理:模擬一批請求失敗(例如故意打錯網址測試),確認腳本會記錄並繼續跑完其他批次,不會整個中斷。
4. 確認上市/上櫃前綴判斷正確:各挑一檔上市、一檔上櫃股確認有查到資料。
5. 隔天開盤前執行一次(若條件允許),確認會印出「MIS 日期與資料庫最新日期相同」的警告,而不是靜默拿舊資料當成當日快照。

## 明確不做的事

- 不做常態輪詢、不排程、不接進 `daily-pipeline.ts`。
- ~~不套用 `calculate-breakout-strength.ts` 的完整評分~~(已改為套用,見上方「第三層:強度評分」)。
- 不寫資料庫(結果不落地成資料表,但會寫 JSON 快照檔留存,見上方「輸出」段落)。
- 不處理非交易日的特殊情況(使用者應自行判斷今天是否為交易日再執行;若誤在非交易日執行，MIS 系統通常會回傳前一交易日的最後成交資料，效果類似盤後查詢，不特別阻擋)。