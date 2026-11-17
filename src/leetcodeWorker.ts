import dotenv from 'dotenv';
import { setTimeout as sleep } from 'node:timers/promises';

const loginUrl = 'https://leetcode.com/accounts/login/';

interface WorkerJob {
  id: string;
  deadline: number;
}

async function main() {
  dotenv.config();
  const workerUrl = process.env.CPSOLVER_WORKER_URL?.trim();
  const apiToken = process.env.CPSOLVER_API_TOKEN?.trim();
  if (!workerUrl || !apiToken) throw new Error('Configure CPSOLVER_WORKER_URL and CPSOLVER_API_TOKEN');
  const endpoint = new URL(workerUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('Set CPSOLVER_WORKER_URL to the HTTPS Render URL and configure CPSOLVER_API_TOKEN');
  }

  process.env.HEADLESS ??= 'true';
  process.env.CPSOLVER_FULL_CHROMIUM = 'true';
  const { solveTurnstile } = await import('./solver');
  const { BrowserManager } = await import('./browser');
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());

  const request = (path: string, token: string, body?: object) => fetch(new URL(`/workers/leetcode/${path}`, endpoint), {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });

  const runJob = async (job: WorkerJob, workerToken: string) => {
    const remaining = job.deadline - Date.now() - 3000;
    const result = remaining >= 1000
      ? await solveTurnstile({ siteurl: loginUrl, proxy: 'direct', mode: 'navigate', timeout: remaining }, shutdown.signal).catch(() => undefined)
      : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await request(`${job.id}/result`, workerToken, { token: result?.ok ? result.token : null });
        if (response.status < 500) {
          console.log(`LeetCode job ${job.id} result HTTP ${response.status}, form token ${Boolean(result?.ok && result.token)}`);
          return;
        }
      } catch {
        // Retry a transient result upload once.
      }
    }
    console.warn(`Could not upload LeetCode job ${job.id}`);
  };

  let workerToken: string | undefined;
  let working: Promise<void> | undefined;
  try {
    while (!shutdown.signal.aborted) {
      try {
        if (!workerToken) {
          const response = await request('register', apiToken, {});
          if (response.status === 201) {
            const registered = await response.json() as { token?: unknown };
            if (typeof registered.token === 'string') {
              workerToken = registered.token;
              console.log('Private LeetCode browser worker connected to Render');
            }
          } else if (response.status === 401) {
            throw new Error('Render rejected the worker registration credential');
          }
        }
        const currentToken = workerToken;
        if (currentToken) {
          const response = await request(working ? 'next?busy=1' : 'next', currentToken);
          if (response.status === 401) workerToken = undefined;
          if (response.status === 200 && !working) {
            const job = await response.json() as WorkerJob;
            if (/^[a-f0-9-]{36}$/.test(job.id) && Number.isFinite(job.deadline)) {
              working = runJob(job, currentToken).finally(() => { working = undefined; });
            }
          }
        }
      } catch (error) {
        console.warn(error instanceof Error ? error.message : 'Worker connection failed');
      }
      await sleep(3500, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  } finally {
    await working;
    await BrowserManager.getInstance().close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Worker failed to start');
  process.exitCode = 1;
});
