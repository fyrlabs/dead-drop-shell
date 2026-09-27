import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { isJobId } from './protocol.js';

export type JobState = 'running' | 'completed' | 'unknown';

export interface JobRecord<Result> {
  jobId: string;
  /** Controller identity that submitted the job. A job id never changes hands. */
  identity: string;
  sessionId: string;
  state: JobState;
  startedAt: number;
  finishedAt?: number;
  /** Present once `completed`. The command text itself is never stored. */
  result?: Result;
}

/**
 * Durable job states, one file per job id.
 *
 * dead-drop delivers at least once, so the same job can arrive twice. A
 * completed job answers from here instead of running again, and a job that was
 * `running` when the server stopped is reported as `unknown` from then on:
 * it may have run, partly run, or not run, and nothing here can tell which.
 */
export class JobLedger<Result> {
  constructor(
    private readonly directory: string,
    private readonly retentionMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates the directory and marks jobs interrupted by a previous run `unknown`. */
  async open(): Promise<{ recovered: string[] }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const recovered: string[] = [];
    for (const record of await this.all()) {
      if (record.state !== 'running') continue;
      await this.put({ ...record, state: 'unknown', finishedAt: this.now() });
      recovered.push(record.jobId);
    }
    await this.prune();
    return { recovered };
  }

  async get(jobId: string): Promise<JobRecord<Result> | undefined> {
    if (!isJobId(jobId)) return undefined;
    try {
      return JSON.parse(await readFile(this.path(jobId), 'utf8')) as JobRecord<Result>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Written to a temporary file, flushed, then renamed, so a crash never leaves half a record. */
  async put(record: JobRecord<Result>): Promise<void> {
    if (!isJobId(record.jobId)) throw new Error(`invalid job id ${record.jobId}`);
    const target = this.path(record.jobId);
    const temporary = `${target}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }

  /** Drops finished records older than the retention window. Running ones are never dropped. */
  async prune(): Promise<number> {
    const cutoff = this.now() - this.retentionMs;
    let removed = 0;
    for (const record of await this.all()) {
      if (record.state === 'running') continue;
      if ((record.finishedAt ?? record.startedAt) > cutoff) continue;
      await rm(this.path(record.jobId), { force: true });
      removed += 1;
    }
    return removed;
  }

  private async all(): Promise<Array<JobRecord<Result>>> {
    const records: Array<JobRecord<Result>> = [];
    for (const name of await readdir(this.directory)) {
      if (name.endsWith('.tmp')) {
        // A write interrupted before its rename. The record it replaced is intact.
        await rm(join(this.directory, name), { force: true });
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const record = await this.get(name.slice(0, -'.json'.length));
      if (record) records.push(record);
    }
    return records;
  }

  private path(jobId: string): string {
    return join(this.directory, `${jobId}.json`);
  }
}
