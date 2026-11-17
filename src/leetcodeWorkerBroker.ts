import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { QueueFullError } from './queue';
import { solverStats } from './solver';
import type { SolveResult } from './types';

interface Job {
  id: string;
  deadline: number;
  claimedBy?: string;
  finish: (token?: string, state?: 'TIMED_OUT' | 'CANCELLED') => void;
}

const LEASE_MS = 25_000;

class LeetCodeWorkerBroker {
  private worker?: { token: string; seenAt: number };
  private readonly jobs = new Map<string, Job>();

  get available(): boolean {
    return this.worker !== undefined && Date.now() - this.worker.seenAt < LEASE_MS;
  }

  register(options?: { replace?: boolean }): string | undefined {
    const hasInFlightJob = [...this.jobs.values()].some(
      (job) => Boolean(job.claimedBy) && job.deadline > Date.now(),
    );
    if (this.available && hasInFlightJob && !options?.replace) return;
    const token = randomBytes(32).toString('base64url');
    this.worker = { token, seenAt: Date.now() };
    for (const job of this.jobs.values()) job.claimedBy = undefined;
    return token;
  }

  authenticate(token: string): boolean {
    if (!this.available || !this.worker || token.length !== this.worker.token.length) return false;
    const supplied = Buffer.from(token);
    const expected = Buffer.from(this.worker.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    this.worker.seenAt = Date.now();
    return true;
  }

  claim(token: string): { id: string; deadline: number } | undefined {
    if ([...this.jobs.values()].some(job => job.claimedBy === token)) return;
    for (const job of this.jobs.values()) {
      if (job.claimedBy || job.deadline <= Date.now()) continue;
      job.claimedBy = token;
      return { id: job.id, deadline: job.deadline };
    }
  }

  complete(workerToken: string, id: string, token: unknown): boolean {
    const job = this.jobs.get(id);
    if (!job || job.claimedBy !== workerToken || job.deadline <= Date.now()) return false;
    const valid = typeof token === 'string' && token.length > 100 && token.length <= 2048 && !token.includes('.DUMMY.TOKEN.');
    job.finish(valid ? token : undefined);
    return true;
  }

  async solve(timeout: number, signal: AbortSignal): Promise<SolveResult> {
    if (this.jobs.size >= config.maxQueueSize) throw new QueueFullError('Private LeetCode worker queue is full');
    const startedAt = Date.now();
    const id = randomUUID();
    return new Promise(resolve => {
      let settled = false;
      const onAbort = () => finish(undefined, 'CANCELLED');
      const timer = setTimeout(() => finish(undefined, 'TIMED_OUT'), timeout);
      const finish: Job['finish'] = (token, state) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.jobs.delete(id);
        const durationMs = Date.now() - startedAt;
        if (token) {
          solverStats?.recordSuccess?.(durationMs);
        } else {
          solverStats?.recordFailure?.();
        }
        resolve({
          ok: Boolean(token),
          state: token ? 'VERIFICATION_COMPLETED' : (state ?? 'VERIFICATION_FAILED'),
          token,
          error: token ? undefined : state === 'TIMED_OUT'
            ? 'Private LeetCode worker timed out'
            : 'Private LeetCode worker did not return a login verification token',
          modeUsed: 'navigate',
          proxyUsed: 'private-browser-worker',
          durationMs,
        });
      };
      this.jobs.set(id, { id, deadline: startedAt + timeout, finish });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}

export const leetCodeWorkerBroker = new LeetCodeWorkerBroker();
