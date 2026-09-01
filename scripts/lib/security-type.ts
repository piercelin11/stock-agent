import { SecurityType } from "../../generated/prisma/client";

// 台股證券代號 → SecurityType 分類（fill-daily-quotes / fill-institutional-trading /
// fill-margin-trading 共用的單一出處，2026-09-01 前三支腳本各持一份複製）。
//
// 判斷順序是刻意的：「4 碼數字 → stock」必須排在「名稱含購/售 → warrant」之前——
// 權證代號一律 6 碼（上市 0 開頭、上櫃 7 開頭；put 為 5 碼數字 + 尾碼字母），
// 不存在 4 碼數字的權證；但存在名稱帶「購」「售」的一般股票（2945 三商家購、3085 新零售），
// 名稱判斷排前面會把它們誤殺成 warrant（2026-09-01 修正的 bug）。
// 名稱判斷仍保留當 6 碼規則之外的 fallback（非 4 碼、名稱帶購/售的衍生品）。
export function toSecurityType(code: string, name: string): SecurityType {
  if (code.startsWith("00")) return SecurityType.etf;
  if (/^\d{4}$/.test(code)) return SecurityType.stock;
  if (/^.{4}[A-Za-z]$/.test(code)) return SecurityType.preferred;
  if (/^\d{6}$/.test(code) || name.includes("購") || name.includes("售")) return SecurityType.warrant;
  if (/^\d{5}$/.test(code)) return SecurityType.bond;
  return SecurityType.other;
}
