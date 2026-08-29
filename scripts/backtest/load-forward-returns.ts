import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ForwardReturnLookup } from "../lib/backtest-stats";

// 讀 data/backtest-cache/forward-returns.jsonl 建成 ForwardReturnLookup。
// 可被 CLI / Server Action / 測試共用（這支可以讀檔，backtest-stats.ts 不行）。

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_PATH = join(
  __dirname,
  "..",
  "..",
  "data",
  "backtest-cache",
  "forward-returns.jsonl",
);

interface Entry {
  ret: Record<number, number | null>;
  benchmarkRet: Record<number, number | null>;
}

export function loadForwardReturns(cachePath: string = DEFAULT_CACHE_PATH): ForwardReturnLookup {
  const map = new Map<string, Entry>();

  if (existsSync(cachePath)) {
    const content = readFileSync(cachePath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const date = row.date;
      const code = row.code;
      if (typeof date !== "string" || typeof code !== "string") continue;

      const ret: Record<number, number | null> = {};
      const benchmarkRet: Record<number, number | null> = {};
      for (const key of Object.keys(row)) {
        const retMatch = /^ret(\d+)$/.exec(key);
        if (retMatch) {
          const h = Number(retMatch[1]);
          const v = row[key];
          ret[h] = typeof v === "number" ? v : null;
          continue;
        }
        const benchMatch = /^benchmarkRet(\d+)$/.exec(key);
        if (benchMatch) {
          const h = Number(benchMatch[1]);
          const v = row[key];
          benchmarkRet[h] = typeof v === "number" ? v : null;
        }
      }
      map.set(`${date}|${code}`, { ret, benchmarkRet });
    }
  }

  return {
    get(date: string, code: string) {
      return map.get(`${date}|${code}`);
    },
  };
}
