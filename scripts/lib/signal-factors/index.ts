// 統一因子庫（ROADMAP 4.5.3 / 4.5.4）—— run-signal-scan.ts 與 lib/actions/dashboard.ts 的單一 import 點。
//
// 4.5.4 目錄化：原「signal-factors.ts 薄 re-export 層 + breakout-shared.ts / accumulation-shared.ts
// 本體」整併成這個目錄。舊三支（calculate-breakout-strength / calculate-accumulation-score /
// check-intraday-breakout）已退役移除，兩個 shared 檔已刪。
//
// 子檔分工：
//   util.ts          —— clip / rankScore（原本兩份重複，合併）
//   breakout.ts      —— 原 breakout-shared.ts：GATES/WEIGHTS 常數、BreakoutConfig 三件組、
//                       7 項 breakout 評分函式、撈 DB helper（fetchBreakoutRawInputs 等）
//   accumulation.ts  —— 原 accumulation-shared.ts：視窗常數、AccumulationConfig 三件組、
//                       籌碼/技術評分函式、fetchAccumulationRawInputs
//   institutional.ts —— computeInstitutionalFlow / computeMarginSurgePercentile（三大法人流向 + margin-chasing）
//   staging.ts       —— consecutiveAboveBand（階段判定）/ computeBreakoutMarginMonotone（§2.5）
//   config.ts        —— SignalScanConfig / DEFAULT_SIGNAL_CONFIG / resolveSignalConfig（三處偏離舊 breakout 預設）

export * from "./util";
export * from "./breakout";
export * from "./accumulation";
export * from "./institutional";
export * from "./staging";
export * from "./config";
