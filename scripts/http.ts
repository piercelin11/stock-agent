// daily-pipeline.ts 會呼叫到的抓取步驟（fill-daily-quotes / fill-institutional-trading /
// fill-gap-valuation）共用的 HTTP 工具。純函式庫，無 Prisma/CLI。
//
// 這支 pipeline 每天靠 launchd 無人值守執行，原本的裸 fetch 只要遇到一次 TLS 連線中斷
// （ECONNRESET / terminated）或伺服器 5xx 就會整條 pipeline 掛掉。fetchJson 加上：
//   - 每次嘗試帶 AbortSignal.timeout，避免 socket 卡死永遠不返回
//   - 對「網路層拋錯」與「5xx / 429」自動退避重試，對其他 4xx 不重試（請求本身有問題）

interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number; // 總嘗試次數 = retries（預設 3）
  baseDelayMs?: number; // 退避基數，第 n 次重試等 baseDelayMs * 2^(n-1)（預設 2000）
}

const DEFAULT_HEADERS = { "User-Agent": "Mozilla/5.0" };
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2_000;

// 非重試錯誤：4xx（429 除外）代表請求本身有問題，重試沒有意義，直接往外拋
class NonRetriableHttpError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 抓一個回應 2xx JSON 的端點，失敗時自動退避重試。
 * 非交易日判斷（回應 stat / totalCount / 空陣列等）仍留在各呼叫端，這裡只負責「拿到 2xx 並 res.json()」。
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const {
    headers = DEFAULT_HEADERS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        if (!isRetriableStatus(res.status)) {
          throw new NonRetriableHttpError(`HTTP ${res.status} ${res.statusText} ${url}`);
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof NonRetriableHttpError) throw err;

      lastError = err;
      // 走到這代表：AbortSignal.timeout 觸發、網路層錯誤（TypeError: terminated / ECONNRESET 等），或可重試的 5xx/429
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`⚠ fetch 第 ${attempt} 次重試 ${url}：${reason}（${delay}ms 後）`);
        await sleep(delay);
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`fetch 重試 ${retries} 次仍失敗 ${url}：${reason}`, { cause: lastError });
}
