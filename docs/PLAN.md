請評估並更新 ROADMAP.md 第 3 節「歷史回測系統」，依照以下已與人類確認過的設計方向調整，不要自己重新發明架構，但可以在細節上提出你的專業判斷與疑慮。

## 背景與動機

原規劃用 Prisma model（ParamVersion / BacktestRun / BacktestCandidate）把回測結果存進資料庫。經討論後認為：現階段目的是「反覆調整加權參數、快速看訊號有沒有預測力」，不是長期累積多人協作的正式紀錄。把這種高頻率、用完即丟、還在實驗階段的資料放進 DB schema，會增加 migration/index 維護成本，卻沒有對應的效益。因此決定：**回測階段不使用資料庫，改用檔案系統（JSON/JSONL）存放結果**。DB 化留到「參數收斂、要長期自動化監控」的更後期階段再評估，不在這次規劃範圍內。

## 核心設計方向

### 1. 回測的本質是 signal evaluation，不是交易策略模擬

對時間範圍內每個交易日 d，用當時的 config 跑選股純函式（`calculateAccumulationScore` / `calculateBreakoutStrength`）得到候選名單，然後用 d 之後 N 個交易日（5/10/20 日）的實際報酬回頭驗證這批訊號準不準。不涉及進出場規則、停損停利模擬（維持 ROADMAP 原本 3.4 備註「優先度低，之後再評估」的判斷）。

### 2. 訓練期 / 驗證期固定範圍，不隨參數調整而更換

- 一開始選定一段時間範圍，切成訓練期（in-sample，較長，例如扣掉最近 2-3 個月的部分）與驗證期（out-of-sample，較短，例如最近 2-3 個月）。
- 在訓練期反覆調參數、比較命中率變化，這階段「同一範圍、換參數」重複跑。
- 找到候選參數組合後，拿到沒動過的驗證期跑一次做最終確認。
- 驗證期結果不可以拿來回頭再調參數，UI 要有視覺警示提醒這件事（沿用 ROADMAP 原本 3.6 的精神）。
- 之後要擴充 rolling window / walk-forward optimization 可以晚一點再做，初期先固定一組切分即可。

### 3. 資料分層架構：把「抓資料」跟「合成分數」拆開，讓調參數的重跑幾乎即時

這是這次規劃的核心，請仔細評估每一層的可行性與工程細節：

**Layer 0（基準跑，慢，只在換時間範圍時需要重跑）**
對回測範圍內每個交易日，跑一次「抓原始資料」的邏輯，把**全市場**（不是只有通過門檻的候選股）每檔股票當天所需的原始輸入，存成 JSONL（例如 `data/backtest-runs/{run-id}/raw-factors.jsonl`，一行一筆）。

存什麼內容需要你依照兩支選股腳本的實際計算邏輯評估，但方向是：
- accumulation：`computeTrustRawMetrics` / `computeOtherInstitutionRatio` / `computeQuietVolumeRatio` / `computeBase`（來自 breakout-shared.ts）等純函式已算好的分項分數或原始值，加上候選池門檻判斷所需的原始數值（`volumeMa20`、是否站上布林上軌等）。
- breakout：七項分項分數（`candleShape` / `volumeStrength` / `breakoutMargin` / `firstBar` / `base` / `proximityToHigh` / `relativeStrength`），加上觸發層判斷所需的原始數值（`close`、`bollingerUpper`、`volume`、`volumeMa20`、`sharesOutstanding`）。

**關鍵原因**：breakout 的 `GATES` / `TRIGGER_VOLUME_RATIO` 是門檻層參數，決定哪些股票會進候選池，跟 `WEIGHTS` 這種純加權組合層參數不同性質。如果 Layer 0 只存「當時通過門檻的股票」，之後調門檻參數就無法還原「原本沒過、換門檻後應該要過」的股票，必須重新查 DB。所以 Layer 0 必須存全市場資料，不能只存候選池。accumulation 是否有一樣的問題（例如 `MIN_AVG_VOLUME_SHARES` 或站上布林上軌的排除規則）也要一併確認並比照處理。

**Layer 1（輕量重算：套用門檻參數篩出候選池）**
在記憶體中對 Layer 0 的全市場資料重新套用 `GATES` / `TRIGGER_VOLUME_RATIO`（breakout）或候選池門檻常數（accumulation），不碰 DB。

**Layer 2（更輕量：套用權重參數做加權組合、排名）**
對候選池套用 `WEIGHTS` / `CHIP_WEIGHTS` / `TECH_WEIGHTS` / `READINESS_FLOOR` 等純加權組合，排名、算總分，不碰 DB。

**Layer 3（統計評估）**
對 Layer 2 輸出的候選名單，抓事後報酬（5/10/20 日）、跟 benchmark 比較、算命中率/平均報酬/勝率/賺賠比，並按時間分段看穩定性、按分數分層（前10名 vs 前30名 vs 全部候選）驗證分數高低是否真的對應報酬高低。

目的：使用者調整 Layer 1/2 的參數時，UI 應該能在幾秒內重新算出結果並更新圖表，不需要每次都重新查資料庫；只有換整個時間範圍時才需要重跑 Layer 0。

### 4. 輸出檔案結構（請你依此為基礎細化，不必完全照抄路徑命名）

```
data/backtest-runs/{run-id}/
  config.json          # 這次基準跑的時間範圍、策略
  raw-factors.jsonl     # Layer 0 輸出：全市場、每個交易日的分項分數與原始值
  returns.jsonl          # 每檔股票每天的未來 N 日報酬與 benchmark（可併入 raw-factors 或分開，請評估）
```

「重新計算」（調 Layer 1/2 參數）的結果不必然要落地成檔案，可以先在記憶體/前端 state 暫存，使用者主動要保留比較時才手動存成一份 named 結果（對應原本 ParamVersion 的「具名版本」概念，但用檔案而非 DB row 實現）。

### 5. UI 分成兩種操作，成本不同

- 「執行基準跑」：選策略 + 時間範圍（訓練期/驗證期）→ 觸發 Layer 0，這步驟慢，需要進度條/背景執行（沿用原 ROADMAP 3.3「背景任務執行」的构想，只是輸出改成檔案而非寫 DB）。
- 「調整參數」：滑桿/輸入框改 Layer 1/2 的參數 → 幾秒內重新計算並更新結果儀表板（命中率、報酬分布、訓練 vs 驗證並排），這步驟應該做到接近即時。
- 版本比較頁維持原 ROADMAP 構想，但比較的對象是「不同參數的重新計算結果」，不一定要求都已落地存檔。

## 請你做的事

1. 重寫 ROADMAP.md 第 3 節（3.1 ~ 3.7），反映上述設計；3.2「回測資料表」整節應該從「新增 Prisma model」改為「檔案輸出格式設計」，說明 Layer 0-3 各自的檔案內容與職責。
2. 檢查 accumulation 的候選池門檻邏輯（`buildCandidatePool` 裡的「站上布林上軌排除」與 `MIN_AVG_VOLUME_SHARES` 門檻）是否跟 breakout 一樣有「Layer 0 需存全市場」的問題，並在 ROADMAP 中明確寫出你的判斷。
3. 針對「Layer 0 該存分項分數還是原始輸入資料」這個取捨（存分項分數重算快但不夠彈性去驗證分項函式本身的改動；存原始輸入更彈性但重算變慢）給出你的建議並說明理由，寫進 ROADMAP。
4. 評估這個檔案化方案是否會讓「效果評估模組」（3.4）、「統計匯總模組」（3.5）的實作方式需要跟著調整（例如原本設計是在 Prisma 查詢層做統計，現在要在讀 JSONL 之後用程式碼算），並更新對應章節。
5. 如果你認為某些部分維持 DB 化其實更合理（例如某個子功能特別不適合用檔案處理），請明確提出來討論，不要默默照抄我的方案，我要的是你的專業判斷。
6. 更新後的 3.7 回測 UI 章節，需要反映「基準跑（慢）」與「調參數重算（快）」這兩種操作在 UI 上的區別，以及對應的使用者體驗預期。

完成後，用 diff 或條列方式跟我說明你對第 1、2、3、5 點的判斷與理由，讓我確認後再真的寫入 ROADMAP.md。