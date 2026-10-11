export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export type SolverMode = 'harness' | 'navigate';

export interface SolveRequest {
  siteurl: string;
  sitekey?: string;
  action?: string;
  cdata?: string;
  proxy?: string | ProxyConfig;
  timeout?: number;
  mode?: SolverMode;
  userAgent?: string;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }> | Record<string, string>;
}

export interface SolveResult {
  ok: boolean;
  token?: string;
  cookies?: Record<string, string>;
  cfClearance?: string;
  durationMs: number;
  error?: string;
  modeUsed?: SolverMode;
  proxyUsed?: string;
}

export interface SolverStats {
  totalSolves: number;
  successfulSolves: number;
  failedSolves: number;
  activeSolves: number;
  queueLength: number;
  avgDurationMs: number;
  browserRestarts: number;
  lastSolvedAt?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  uptimeSeconds: number;
  memory: {
    rssMb: number;
    heapTotalMb: number;
    heapUsedMb: number;
  };
  queue: {
    active: number;
    waiting: number;
    maxConcurrent: number;
    maxQueueSize: number;
  };
  browser: {
    isAlive: boolean;
    solvesSinceRestart: number;
  };
  proxyPool?: {
    total: number;
    activeIndex: number;
    activeProxy: string | null;
  };
}
