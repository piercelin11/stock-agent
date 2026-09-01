"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDailyPipelineStatus,
  runDailyPipeline,
  type DailyPipelineStatus,
} from "../../lib/actions/pipeline";
import { FieldLabel } from "../ui/Card";

// 首頁「資料狀態」卡的「立即更新資料」按鈕。
// spawn daily-pipeline.ts 當背景子進程 → setInterval 輪詢粗粒度狀態（存活時間 + log 尾）。
// 切走頁面只停輪詢、不中斷子進程；切回來若還 running 就接管。跑完自動 reload 刷新覆蓋率。

const POLL_MS = 3000;

export function PipelineRunner() {
  const [status, setStatus] = useState<DailyPipelineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, forceTick] = useState(0); // 讓「已 N 秒」每輪重繪
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const s = await getDailyPipelineStatus();
      setStatus(s);
      forceTick((n) => n + 1);
      if (s && s.status !== "running") {
        stopPolling();
        setBusy(false);
        // 跑完刷新頁面：app/page.tsx 是 force-dynamic，reload 會重抓 getDbHealth() 的新覆蓋率 / 燈號。
        if (s.status === "done") window.location.reload();
      }
    }, POLL_MS);
  }, [stopPolling]);

  // 掛載時：若已有 running 的執行（別的分頁觸發、或重整前按的）→ 接管輪詢。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getDailyPipelineStatus();
      if (cancelled) return;
      setStatus(s);
      if (s?.status === "running") {
        setBusy(true);
        startPolling();
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [startPolling, stopPolling]);

  async function onRun() {
    setErr(null);
    setBusy(true);
    const r = await runDailyPipeline();
    if (!r.started) {
      setErr(r.reason ?? "無法啟動");
      setBusy(false);
      // 撿回目前狀態（可能是別處正在跑）
      setStatus(await getDailyPipelineStatus());
      return;
    }
    startPolling();
  }

  const running = status?.status === "running";
  const elapsed = status
    ? Math.max(0, Math.round((Date.now() - new Date(status.startedAt).getTime()) / 1000))
    : 0;

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onRun}
          disabled={busy || running}
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "更新中…" : "立即更新資料"}
        </button>
        {running && (
          <FieldLabel>已 {elapsed} 秒（可離開此頁，回來會接上進度）</FieldLabel>
        )}
        {!running && status?.status === "done" && (
          <FieldLabel className="text-success">
            上次更新完成（{status.finishedAt?.slice(11, 19) ?? "—"}）
          </FieldLabel>
        )}
        {!running && status?.status === "error" && (
          <FieldLabel className="text-destructive">
            上次執行失敗（exit {status.exitCode ?? "?"}）
          </FieldLabel>
        )}
      </div>

      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}

      {status && status.status === "error" && (
        <p className="mt-2 text-xs text-muted-foreground/70">log：{status.logPath}</p>
      )}

      {status && status.logTail.length > 0 && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-background p-2 text-xs text-muted-foreground">
          {status.logTail.join("\n")}
        </pre>
      )}
    </div>
  );
}
