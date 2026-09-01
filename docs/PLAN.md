# PLAN 1：daily-pipeline 穩定性

三份計劃的第一份（PLAN 2 = 資料層統一 + 掃描腳本改造；PLAN 3 = 盤中自動掃描 + watchlist 改接）。
本份與其他兩份無耦合，是純止血：讓 launchd 冷進程執行 daily-pipeline 不再整條掛掉。
**不動前端、不動掃描邏輯、不動 schema。**

**分支**：`feat/pipeline-stability`。merge 時機等使用者發話。

**需求來源**：使用者回報 `com.piercelin.dailypipeline.plist` 由 launchd 觸發時「常常」失敗
（非電腦休眠、非網路問題——當時電腦開著使用中、網路正常）。log 佐證（`logs/daily_pipeline_stderr.log`，
2026-09-01 17:00 觸發）：

```
⚠ fetch 第 1 次重試 ...tpex_mainboard_daily_close_quotes：The operation was aborted due to timeout
⚠ fetch 第 2 次重試 ...tpex_mainboard_daily_close_quotes：terminated
[補齊今日報價] 處理日期 2026-09-01 失敗: fetch 重試 3 次仍失敗 ...：terminated
  [cause]: SocketError: other side closed (UND_ERR_SOCKET)
```

同一次冷執行 TWSE（`www.twse.com.tw`）已成功寫 1384 筆，接著換 `www.tpex.org.tw`（這個進程從沒碰過的
host）第一次 DNS+TLS 握手就 timeout / 被 RST。UI 按鈕 / 終端手動跑幾乎不遇到，因為那些是「溫進程」
（Next dev server 或逛過網站後的終端），對政府端點有既存的 keep-alive 連線池、DNS 已快取；launchd 是
全新冷進程，連線池空的。而 `fillTodayTpex` 失敗會 `throw PipelineStepError` → 整條 pipeline 停 →
TWSE 已寫的報價之後的籌碼 / 估值 / 融資融券 / 技術指標 / 大盤濾網 / 產業熱度全部不跑。

---

## 0. 邊界

**動：**

- `scripts/pipeline/calculate-technical-indicators.ts`：**僅確認 + commit**——使用者 2026-08-31 已在本機修過
  「`mode: "latest"` 誤跑成 full」（8-31 log 顯示 `寫入 TechnicalIndicator 筆數: 3063199`、耗時 1139 秒；
  使用者今日手動跑 1~2 分鐘完成，修復已生效但未 commit，`git status` 目前 clean）。本份負責把它進版控。
- `scripts/pipeline/daily-pipeline.ts`：TPEx 報價步從關鍵路徑（throw）改非關鍵路徑（try/catch + warn +
  `warningCount++`）；TWSE 步維持關鍵路徑。TWSE↔TPEx 之間插一段 `sleep`。
- `scripts/pipeline/fill-daily-quotes.ts`：`fetchTpexQuotes` 真正呼叫前加「冷連線預熱」fetch；
  `fetchJson` 呼叫加 `{ retries: 5, baseDelayMs: 3000 }`。
- `scripts/pipeline/fill-institutional-trading.ts`、`fill-gap-valuation.ts`、`fill-margin-trading.ts`：
  對外 `fetchJson` 呼叫統一加 `{ retries: 5, baseDelayMs: 3000 }`。
- `~/Library/LaunchAgents/com.piercelin.dailypipeline.plist`：`StartCalendarInterval` 從單一 17:00
  改成陣列 17:00 / 17:30 / 18:00（補跑）。
- `scripts/pipeline/daily-pipeline.ts`：加「當日成功標記檔」——跑完無致命錯誤時寫
  `data/daily-pipeline-runs/{YYYY-MM-DD}.ok`，`main()` 開頭若當日 `.ok` 已存在則印訊息並 `return`
  （讓 17:30 / 18:00 補跑在 17:00 已成功時秒退，不重跑 20 分鐘）。

**不動：**

- `scripts/lib/http.ts`：預設值（`DEFAULT_RETRIES = 3` / `DEFAULT_BASE_DELAY_MS = 2000` /
  `DEFAULT_TIMEOUT_MS = 30_000`）不改。只在呼叫端傳 options 覆蓋。理由：backfill 等手動腳本沒必要
  一律變激進，且 30s timeout 對冷握手本來就夠（問題是握手直接被 RST，不是慢）。
- `scripts/backfill/*`：不接 `fetchJson` options（現況本來就多數沒接 http.ts），本份不碰。
- 前端任何檔、`lib/*`、`components/*`、`prisma/schema.prisma`、掃描腳本：完全不動。

---

## 1. 技術指標修復進版控（收尾既有工作）

- `git diff` 確認 `calculate-technical-indicators.ts` 的本機改動內容（`mode: "latest"` 分支：
  每支只撈最近 ~250 筆、只 upsert 最新一天）。若 `git status` 真的 clean（改動可能已被使用者
  自己 commit 到別的地方 / 或還在 working tree）——先 `git log --oneline -5 -- scripts/pipeline/calculate-technical-indicators.ts`
  查最後一次動它是哪個 commit。
- 若改動在 working tree → 本份分支一併 commit（訊息獨立成一個 commit，不跟 pipeline 改動混）。
- 若已 commit 過 → 本節無動作，只在 PROGRESS 記「已確認 latest 模式正常」。
- **驗證**：`pnpm tsx scripts/pipeline/calculate-technical-indicators.ts 2330`（單股，全歷史 full 應仍可跑）
  + 讀 `daily-pipeline.ts` 第 4 步確認呼叫的是 `calculateTechnicalIndicators(undefined, { mode: "latest" })`。

---

## 2. TPEx 報價步改非致命（`daily-pipeline.ts`）

**現況**（第 44~57 行附近）：

```ts
try {
  const twseResult = await fillOneDayTwse(todayStr);
  const tpexResult = await fillTodayTpex(todayStr);
  quotesWritten = twseResult.processed + tpexResult.processed;
  quotesDerivativesSkipped = twseResult.skippedDerivatives + tpexResult.skippedDerivatives;
  twseHasData = !twseResult.isNonTradingDay;
  tpexHasData = !tpexResult.isStaleDate && !tpexResult.isNonTradingDay;
  if (tpexResult.isStaleDate) warningCount++;
} catch (err) {
  throw new PipelineStepError("補齊今日報價", `處理日期 ${todayStr} 失敗`, err);
}
```

**改為**：拆成兩個獨立 try/catch。

```ts
// 1a. TWSE 報價（關鍵路徑：失敗 throw）
try {
  const twseResult = await fillOneDayTwse(todayStr);
  quotesWritten += twseResult.processed;
  quotesDerivativesSkipped += twseResult.skippedDerivatives;
  twseHasData = !twseResult.isNonTradingDay;
} catch (err) {
  throw new PipelineStepError("補齊今日 TWSE 報價", `處理日期 ${todayStr} 失敗`, err);
}

// 1b. 冷進程連續打兩個政府 host 之間喘口氣（見 §3）
await sleep(TPEX_COLD_GAP_MS); // 4000

// 1c. TPEx 報價（非關鍵路徑：失敗只 warn，tpexHasData 留 false）
//     TPEx OpenAPI 本來就只給「最新一天」，隔天 pipeline 會再抓；缺的那天可用 backfill-daily-quotes.ts 補。
//     比照第 3.5 步融資融券的既有寫法。
try {
  const tpexResult = await fillTodayTpex(todayStr);
  quotesWritten += tpexResult.processed;
  quotesDerivativesSkipped += tpexResult.skippedDerivatives;
  tpexHasData = !tpexResult.isStaleDate && !tpexResult.isNonTradingDay;
  if (tpexResult.isStaleDate) warningCount++;
} catch (err) {
  console.warn(
    `[TPEx 報價] 抓取失敗（不中斷 pipeline）: ${err instanceof Error ? err.message : String(err)}`,
  );
  warningCount++;
  // tpexHasData 維持初始 false
}
```

**關鍵防呆**：`twseHasData` / `tpexHasData` 宣告時初始化為 `false`（現在是在 try 內才賦值）。
第 60 行的「TWSE 與 TPEx 皆無當日資料 → 判非交易日提前結束」邏輯不變——TPEx catch 裡**不重新 throw**，
`tpexHasData` 留 `false`，若 TWSE 也 `false`（真非交易日）仍會正常走提前結束；若 TWSE 有資料（`true`）
則 TPEx 掛掉只是 `warningCount++`，pipeline 續跑。

`quotesWritten` / `quotesDerivativesSkipped` 從 `=` 改 `+=`（分兩段累加）。

---

## 3. TPEx 冷連線預熱 + host 間 sleep

### 3.1 `daily-pipeline.ts`

- 檔頭加 `const TPEX_COLD_GAP_MS = 4000;` 常數 + 一個本地 `sleep` helper（`daily-pipeline.ts` 目前沒有，
  加 `function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }`）。
- §2 的 1b 已用。

### 3.2 `fill-daily-quotes.ts`

`fetchTpexQuotes()` 內、真正 `fetchJson(TPEX_QUOTES_URL)` 之前：

```ts
// 冷進程對 www.tpex.org.tw 第一次 DNS+TLS 握手常被 RST（launchd 事故 2026-09-01）。
// 先用一個「便宜、允許失敗」的請求把 DNS 解析 + TLS session 建起來，真正的 API 呼叫走溫連線。
async function warmUpTpex(): Promise<void> {
  try {
    await fetch("https://www.tpex.org.tw/", {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* 預熱失敗無所謂，下面的正式呼叫自己有 retry */
  }
}
```

- `fetchTpexQuotes()` 開頭 `await warmUpTpex();`。
- **只對 TPEx 做**——TWSE 在 pipeline 裡永遠先跑、且是關鍵路徑，它自己那次呼叫就是「預熱」；
  TPEx 是「冷進程碰的第二個 host」才需要。

---

## 4. 抓取步驟加重試（四支 pipeline 抓取腳本）

對「打政府端點」的 `fetchJson` 呼叫統一傳 `{ retries: 5, baseDelayMs: 3000 }`
（總嘗試 5 次，間隔 3s → 6s → 12s → 24s；冷握手的 `other side closed` 通常隔幾秒再試就過）。

| 檔案 | 呼叫點 | 端點 |
|---|---|---|
| `fill-daily-quotes.ts` | `fetchTwseQuotes` 的 `fetchJson<MiIndexResponse>` | `MI_INDEX` |
| `fill-daily-quotes.ts` | `fetchTpexQuotes` 的 `fetchJson<TpexRow[]>` | `tpex_mainboard_daily_close_quotes` |
| `fill-institutional-trading.ts` | TWSE `T86` + TPEx `tpex_3insti_daily_trading` 的 `fetchJson` | 二處 |
| `fill-gap-valuation.ts` | TWSE `BWIBBU_d` + TPEx `peQryDate` 的 `fetchJson` | 二處 |
| `fill-margin-trading.ts` | TWSE `MI_MARGN` + TPEx `margin/balance` 的 `fetchJson` | 二處 |

實作：`grep -n "fetchJson" scripts/pipeline/fill-*.ts` 逐一補第二參數。不改 `http.ts` 本體。

---

## 5. 當日成功標記檔（`daily-pipeline.ts`）

避免 17:30 / 18:00 補跑在 17:00 已成功時又跑滿 20 分鐘。

- `main()` 開頭：
  ```ts
  const OK_MARK = join(process.cwd(), "data", "daily-pipeline-runs", `${todayStr}.ok`);
  if (existsSync(OK_MARK)) {
    console.log(`${todayStr} 今日 pipeline 已成功執行過（${OK_MARK}），跳過。`);
    return;
  }
  ```
  （`todayStr` 目前在 `main()` 中段才宣告——把它上移到開頭。）
- `main()` 正常結束前（「每日主流程結束」那段 log 之後、`return` 之前）：
  ```ts
  mkdirSync(dirname(OK_MARK), { recursive: true });
  writeFileSync(OK_MARK, new Date().toISOString());
  ```
- **提前結束（非交易日）也寫 `.ok`**——非交易日的補跑同樣該秒退（第 60 行那段 return 前補寫）。
- **致命錯誤不寫 `.ok`**——`main().catch()` 分支不碰標記檔，補跑才有意義。
- `data/daily-pipeline-runs/` 已 gitignored（現有 `progress.json` / `*.log` 都在裡面），`.ok` 一併忽略，
  無需改 `.gitignore`。
- **不做自動清理**——每天一個小檔（~30 bytes），累積無感；要清手動 `rm data/daily-pipeline-runs/*.ok`。

---

## 6. LaunchAgent 補跑時段

`~/Library/LaunchAgents/com.piercelin.dailypipeline.plist`：

```xml
<key>StartCalendarInterval</key>
<array>
  <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
  <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>30</integer></dict>
  <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
</array>
```

其餘（`ProgramArguments` 的 node 絕對路徑、`WorkingDirectory`、log 導向）不動。

**部署步驟**（本份最後一個任務項，會先讓使用者看 plist diff 再執行）：

```bash
which node   # 先確認 plist 裡的 node 路徑仍有效（使用者若換過 nvm 版本要同步改）
launchctl unload ~/Library/LaunchAgents/com.piercelin.dailypipeline.plist
launchctl load  ~/Library/LaunchAgents/com.piercelin.dailypipeline.plist
launchctl list | grep piercelin.dailypipeline   # 確認登錄
```

pipeline 全 upsert、且有 `.ok` 標記把關，補跑 idempotent、無害。

---

## 7. 收尾

- `pnpm exec tsc --noEmit` 乾淨（本份只動 `scripts/pipeline/*`，不碰 app）。
- **手動全流程驗證**：`rm -f data/daily-pipeline-runs/$(date +%F).ok`（若當日已有）→
  `pnpm tsx scripts/pipeline/daily-pipeline.ts`：
  - 正常跑完、寫出 `data/daily-pipeline-runs/{今日}.ok`。
  - 再跑一次 → 秒退「今日 pipeline 已成功執行過」。
- **launchd 冷觸發驗證**：`launchctl kickstart -k gui/$(id -u)/com.piercelin.dailypipeline`（先 `rm` 當日 `.ok`），
  看 `logs/daily_pipeline_stdout.log` / `stderr.log`：TPEx 這次應該過（預熱 + 5 retry）；即便沒過，
  應看到 `[TPEx 報價] 抓取失敗（不中斷 pipeline）` 且後續步驟（籌碼/估值/技術指標/大盤濾網/產業熱度）
  仍有跑、pipeline 以非致命方式結束並寫 `.ok`。
- 更新 `docs/PROGRESS.md`：新增「daily-pipeline 穩定性強化」段——記 launchd 冷連線事故、TPEx 改非關鍵
  路徑的理由（同第 3.5 步融資融券哲學）、預熱 + retry:5 + 補跑時段 + `.ok` 標記、實測數字。
- 更新 `CLAUDE.md`：
  - 「`daily-pipeline.ts` 八步」描述——把 TPEx 報價從關鍵路徑改述為「TWSE 報價關鍵、TPEx 報價非關鍵
    （失敗只 warn，隔天再抓 / backfill 補）」。
  - `daily_pipeline.plist` 段——「每天 17:00 觸發」改「17:00 / 17:30 / 18:00 三次（補跑，靠 `{date}.ok`
    標記避免重跑），**已部署到 launchd**」（順手修正舊述「尚未部署」）。
  - `scripts/lib/http.ts` 段——補「pipeline 四支抓取腳本對政府端點傳 `retries:5, baseDelayMs:3000`；
    `fill-daily-quotes.ts` 另對 `www.tpex.org.tw` 做冷連線預熱」。
- 更新 `README.md`：若「使用方式 / 目前功能」有提到 daily-pipeline 排程時間或穩定性，同步。
- `docs/ROADMAP.md`：本項不在 ROADMAP 清單上（維運強化），無打勾動作。
- `git rm` 無（本份不刪檔）。

---

## 8. 給後續 PLAN 的備註（不在本份執行）

- **PLAN 2**：資料層統一（`lib/data-context.ts` + `lib/latest-scan.ts`）+ 掃描腳本改造
  （watchlist 成員豁免 gate → 解 6226 PR / 醞釀籌碼空白；JSON 加 `watchlistQuotes`）。
- **PLAN 3**：盤中自動掃描（`scripts/pipeline/intraday-scan.ts` + `com.piercelin.intradayscan.plist`，
  每 30 分、Hour 9–13 × Minute 0/30）+ screening 頁自動刷新 + watchlist 頁改讀 JSON、移除進頁 MIS。
