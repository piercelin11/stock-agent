// 純型別工具（無執行期程式碼）。回測引擎與選股腳本共用。

/**
 * 遞迴地把 T 的每個欄位變成可選。物件欄位再往下遞迴，非物件（number / string /
 * 陣列 / function）維持原型別。給 `resolveXxxConfig(override?)` 用：呼叫端只需
 * 提供想覆蓋的欄位。
 */
export type DeepPartial<T> = T extends (infer U)[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
