// Trigger.dev REST API client. Server-only. Never import into client code.
// Auth: either a project secret key (tr_prod_* / tr_dev_*) or a PAT.

const API = 'https://api.trigger.dev';

export interface TriggerRun {
  id: string;
  status: 'QUEUED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | string;
  taskIdentifier: string;
  version: string;
  createdAt: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  costInCents?: number;
  baseCostInCents?: number;
  isTest?: boolean;
  isCompleted?: boolean;
  isFailed?: boolean;
  isSuccess?: boolean;
}

export interface TriggerRunDetail extends TriggerRun {
  payload?: unknown;
  output?: unknown;
  error?: {
    name?: string;
    message?: string;
    stackTrace?: string;
  };
  attemptCount?: number;
}

export interface TriggerSchedule {
  id: string;
  type: string;
  task: string;
  generator: { type: string; expression?: string; description?: string };
  timezone: string;
  active: boolean;
  nextRun?: string;
}

export class TriggerClient {
  constructor(private secret: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${this.secret}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Trigger.dev ${path} → ${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`);
    }
    return res.json() as Promise<T>;
  }

  /** List recent runs (paged once for now — perPage up to 50). */
  async listRuns(perPage = 50): Promise<TriggerRun[]> {
    const data = await this.get<{ data: TriggerRun[] }>(`/api/v1/runs?perPage=${perPage}`);
    return data.data ?? [];
  }

  /** Fetch full detail of a single run (includes payload, output, error). */
  async getRun(runId: string): Promise<TriggerRunDetail> {
    return this.get<TriggerRunDetail>(`/api/v3/runs/${runId}`);
  }

  /** List all schedules for the project. */
  async listSchedules(): Promise<TriggerSchedule[]> {
    const data = await this.get<{ data: TriggerSchedule[] }>(`/api/v1/schedules?perPage=50`);
    return data.data ?? [];
  }
}
