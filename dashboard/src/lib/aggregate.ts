// Stat reducers over a list of Trigger.dev runs.

import type { TriggerRun } from './trigger';

export interface TaskStats {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  successRate: number; // 0–100
  avgDurationMs: number;
  totalCostUsd: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

const EMPTY: TaskStats = {
  total: 0,
  succeeded: 0,
  failed: 0,
  running: 0,
  successRate: 0,
  avgDurationMs: 0,
  totalCostUsd: 0,
  lastRunAt: null,
  lastRunStatus: null,
};

export function statsForTask(runs: TriggerRun[], taskId: string): TaskStats {
  const filtered = runs.filter((r) => r.taskIdentifier === taskId);
  if (filtered.length === 0) return EMPTY;
  return reduce(filtered);
}

export function statsAcrossAll(runs: TriggerRun[]): TaskStats {
  if (runs.length === 0) return EMPTY;
  return reduce(runs);
}

function reduce(runs: TriggerRun[]): TaskStats {
  const finished = runs.filter((r) => r.status === 'COMPLETED' || r.status === 'FAILED');
  const succeeded = runs.filter((r) => r.status === 'COMPLETED').length;
  const failed = runs.filter((r) => r.status === 'FAILED').length;
  const running = runs.filter((r) => r.status === 'EXECUTING' || r.status === 'QUEUED').length;
  const totalDur = runs.reduce((acc, r) => acc + (r.durationMs ?? 0), 0);
  const totalCostCents = runs.reduce((acc, r) => acc + (r.costInCents ?? 0) + (r.baseCostInCents ?? 0), 0);
  const sorted = [...runs].sort((a, b) =>
    (b.finishedAt ?? b.updatedAt ?? '').localeCompare(a.finishedAt ?? a.updatedAt ?? ''),
  );
  const last = sorted[0];

  return {
    total: runs.length,
    succeeded,
    failed,
    running,
    successRate: finished.length === 0 ? 0 : Math.round((succeeded / finished.length) * 100),
    avgDurationMs: runs.length === 0 ? 0 : Math.round(totalDur / runs.length),
    totalCostUsd: totalCostCents / 100,
    lastRunAt: last?.finishedAt ?? last?.updatedAt ?? null,
    lastRunStatus: last?.status ?? null,
  };
}

export function failingTaskIds(runs: TriggerRun[], taskIds: string[]): string[] {
  return taskIds.filter((id) => {
    const stats = statsForTask(runs, id);
    return stats.lastRunStatus === 'FAILED';
  });
}

export function formatDuration(ms: number): string {
  if (ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.round((now - then) / 1000);
  // Future timestamps (e.g. cron nextRun) come through as negative deltas.
  if (diffSec < 0) {
    const abs = Math.abs(diffSec);
    if (abs < 60) return `in ${abs}s`;
    if (abs < 3600) return `in ${Math.round(abs / 60)}m`;
    if (abs < 86400) return `in ${Math.round(abs / 3600)}h`;
    return `in ${Math.round(abs / 86400)}d`;
  }
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}
