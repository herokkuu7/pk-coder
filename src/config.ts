import dotenv from 'dotenv';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import type { ProxyConfig } from './types';
import { sanitizeLogMeta } from './security';

dotenv.config();

export function intEnv(raw: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeProxyUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.startsWith('#')) return null;

  s = s.replace(/^["'`<(\[]+|["'`>)\]]+$/g, '').trim();

  if (/^(https?|socks[45]h?):\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(u.protocol) && u.hostname) {
        const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : '';
        const port = u.port ? `:${u.port}` : '';
        const path = (u.pathname === '/' || !u.pathname) ? '' : u.pathname;
        return `${u.protocol}//${auth}${u.hostname}${port}${path}${u.search}`;
      }
    } catch {}
  }

  // host:port:user:pass format
  const hpupMatch = s.match(/^([a-zA-Z0-9_.-]+):(\d+):([^:@\s]+):([^@\s]+)$/);
  if (hpupMatch && hpupMatch[1] && hpupMatch[2] && hpupMatch[3] && hpupMatch[4]) {
    const [, host, port, user, pass] = hpupMatch;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // user:pass@host:port format
  const uphMatch = s.match(/^([^:@\s]+):([^@\s]+)@([a-zA-Z0-9_.-]+):(\d+)$/);
  if (uphMatch && uphMatch[1] && uphMatch[2] && uphMatch[3] && uphMatch[4]) {
    const [, user, pass, host, port] = uphMatch;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // host:port format
  const hpMatch = s.match(/^([a-zA-Z0-9_.-]+):(\d+)$/);
  if (hpMatch && hpMatch[1] && hpMatch[2]) {
    return `http://${hpMatch[1]}:${hpMatch[2]}`;
  }

  return null;
}

export const config = {
  port: intEnv(process.env.PORT, 10000, 1, 65535),
  host: process.env.HOST || '0.0.0.0',
  defaultTimeoutMs: intEnv(process.env.DEFAULT_TIMEOUT_MS, 75000, 1000),
  maxConcurrentSolves: intEnv(process.env.MAX_CONCURRENT_SOLVES, 1, 1),
  maxQueueSize: intEnv(process.env.MAX_QUEUE_SIZE, 10, 1),
  maxSolvesBeforeRecycle: intEnv(process.env.MAX_SOLVES_BEFORE_RECYCLE, 50, 5),
  maxRssMb: intEnv(process.env.MAX_RSS_MB, 380, 1),
  headless: process.env.HEADLESS === 'true',
  defaultProxyUrl: process.env.PROXY_URL?.trim(),
  defaultProxyServer: process.env.PROXY_SERVER?.trim(),
  defaultProxyUsername: process.env.PROXY_USERNAME?.trim(),
  defaultProxyPassword: process.env.PROXY_PASSWORD?.trim(),
};

export function getContainerMemory() {
  if (process.platform !== 'linux') return;
  const read = (file: string) => {
    try { return readFileSync(`/sys/fs/cgroup/${file}`, 'utf8').trim(); }
    catch { return undefined; }
  };
  const miB = (value: string | undefined) => Number.isFinite(Number(value)) ? Math.round(Number(value) / 1024 ** 2) : undefined;
  const stat = read('memory.stat');
  const events = read('memory.events');
  return {
    usedMiB: miB(read('memory.current')),
    peakMiB: miB(read('memory.peak')),
    limitMiB: miB(read('memory.max')),
    anonymousMiB: miB(/^anon (\d+)$/m.exec(stat ?? '')?.[1]),
    fileMiB: miB(/^file (\d+)$/m.exec(stat ?? '')?.[1]),
    limitHits: Number(/^max (\d+)$/m.exec(events ?? '')?.[1]) || 0,
    oomKills: Number(/^oom_kill (\d+)$/m.exec(events ?? '')?.[1]) || 0,
  };
}

/**
 * Parses and normalizes proxy configurations from string or object formats.
 * Supports:
 *   - "http://user:pass@host:port"
 *   - "socks5://user:pass@host:port"
 *   - "host:port" (defaults to http)
 *   - { server: "http://host:port", username: "user", password: "pwd" }
 */
export function parseProxy(proxyInput?: string | ProxyConfig): ProxyConfig | undefined {
  if (proxyInput) {
    if (typeof proxyInput === 'string' && ['direct', 'none', 'off'].includes(proxyInput.trim().toLowerCase())) {
      return undefined;
    }

    if (typeof proxyInput === 'object' && proxyInput.server) {
      return {
        server: proxyInput.server.trim(),
        username: proxyInput.username?.trim(),
        password: proxyInput.password?.trim(),
      };
    }

    if (typeof proxyInput === 'string' && proxyInput.trim()) {
      let raw = proxyInput.trim();
      if (raw.includes(',')) {
        raw = (raw.split(',')[0] ?? '').trim();
      }
      const normalized = normalizeProxyUrl(raw);
      if (!normalized) return undefined;
      try {
        const url = new URL(normalized);
        const server = `${url.protocol}//${url.host}`;
        const username = url.username ? decodeURIComponent(url.username) : undefined;
        const password = url.password ? decodeURIComponent(url.password) : undefined;

        return { server, username, password };
      } catch {
        return undefined;
      }
    }
  }

  // Fallback to default environment proxy if configured
  if (config.defaultProxyUrl) {
    return parseProxy(config.defaultProxyUrl);
  }

  if (config.defaultProxyServer) {
    return {
      server: config.defaultProxyServer,
      username: config.defaultProxyUsername || undefined,
      password: config.defaultProxyPassword || undefined,
    };
  }

  return undefined;
}

export interface LogEntry {
  time: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  msg: string;
  [key: string]: unknown;
}

export const logRingBuffer: LogEntry[] = [];
export const requestLogContext = new AsyncLocalStorage<{ requestId: string }>();

function pushLog(entry: LogEntry): void {
  logRingBuffer.push(entry);
  if (logRingBuffer.length > 200) {
    logRingBuffer.shift();
  }
}

export function getLogs(limit = 100): LogEntry[] {
  return logRingBuffer.slice(-limit);
}

export function logInfo(msg: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const safeMeta = sanitizeLogMeta(meta);
  const entry: LogEntry = { time: ts, level: 'INFO', msg, ...safeMeta, ...requestLogContext.getStore() };
  pushLog(entry);
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function logWarn(msg: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const safeMeta = sanitizeLogMeta(meta);
  const entry: LogEntry = { time: ts, level: 'WARN', msg, ...safeMeta, ...requestLogContext.getStore() };
  pushLog(entry);
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function logError(msg: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const safeMeta = sanitizeLogMeta(meta);
  const entry: LogEntry = { time: ts, level: 'ERROR', msg, ...safeMeta, ...requestLogContext.getStore() };
  pushLog(entry);
  process.stderr.write(JSON.stringify(entry) + '\n');
}
