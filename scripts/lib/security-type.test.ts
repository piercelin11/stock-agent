// pnpm tsx --test scripts/lib/security-type.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toSecurityType } from "./security-type";

test("4 碼數字一律是 stock，名稱含購/售不影響（2026-09-01 修正的誤殺 bug）", () => {
  assert.equal(toSecurityType("2945", "三商家購"), "stock");
  assert.equal(toSecurityType("3085", "新零售"), "stock");
  assert.equal(toSecurityType("2330", "台積電"), "stock");
});

test("權證：6 碼數字（名稱有無購/售皆是）", () => {
  assert.equal(toSecurityType("031234", "元大台積電購01"), "warrant");
  assert.equal(toSecurityType("712345", "凱基鴻海售02"), "warrant");
  assert.equal(toSecurityType("089999", "怪名字"), "warrant");
});

test("權證：非 6 碼數字靠名稱購/售 fallback 攔下（put 權證尾碼字母）", () => {
  assert.equal(toSecurityType("03456P", "元大台積電售01"), "warrant");
});

test("ETF：00 開頭", () => {
  assert.equal(toSecurityType("0050", "元大台灣50"), "etf");
  assert.equal(toSecurityType("00679B", "元大美債20年"), "etf");
  assert.equal(toSecurityType("00400A", "主動式ETF"), "etf");
});

test("特別股：4 碼 + 1 碼英文", () => {
  assert.equal(toSecurityType("1312A", "國喬特"), "preferred");
  assert.equal(toSecurityType("2887E", "台新戊特二"), "preferred");
});

test("可轉債：5 碼數字", () => {
  assert.equal(toSecurityType("15131", "中興電一"), "bond");
});

test("其餘歸 other", () => {
  assert.equal(toSecurityType("ABC", "怪代號"), "other");
  // 註：TAIEX 剛好命中「4 碼 + 1 英文」樣式會被歸 preferred（原始函式即如此），
  // 但它不會流經這個函式——backfill-index-quotes.ts 建檔時直接指定 securityType: index，
  // 且 TWSE/TPEx 行情 API 回應裡沒有這個代號。
  assert.equal(toSecurityType("TAIEX", "發行量加權股價指數"), "preferred");
});
