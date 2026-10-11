import dotenv from 'dotenv';
import type { ProxyConfig } from './types';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '10000', 10),
  host: process.env.HOST || '0.0.0.0',
  defaultTimeoutMs: parseInt(process.env.DEFAULT_TIMEOUT_MS || '65000', 10),
  maxConcurrentSolves: Math.max(1, parseInt(process.env.MAX_CONCURRENT_SOLVES || '1', 10)),
  maxQueueSize: Math.max(1, parseInt(process.env.MAX_QUEUE_SIZE || '10', 10)),
  maxSolvesBeforeRecycle: Math.max(5, parseInt(process.env.MAX_SOLVES_BEFORE_RECYCLE || '50', 10)),
  maxRssMb: parseInt(process.env.MAX_RSS_MB || '380', 10),
  headless: process.env.HEADLESS !== 'false',
  defaultProxyUrl: process.env.PROXY_URL?.trim(),
  defaultProxyServer: process.env.PROXY_SERVER?.trim(),
  defaultProxyUsername: process.env.PROXY_USERNAME?.trim(),
  defaultProxyPassword: process.env.PROXY_PASSWORD?.trim(),
};

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
      try {
        const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
        const url = new URL(hasScheme ? raw : `http://${raw}`);
        const server = `${url.protocol}//${url.host}`;
        const username = url.username ? decodeURIComponent(url.username) : undefined;
        const password = url.password ? decodeURIComponent(url.password) : undefined;

        return { server, username, password };
      } catch {
        return { server: raw };
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
  const entry: LogEntry = { time: ts, level: 'INFO', msg, ...meta };
  pushLog(entry);
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function logWarn(msg: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const entry: LogEntry = { time: ts, level: 'WARN', msg, ...meta };
  pushLog(entry);
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function logError(msg: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const entry: LogEntry = { time: ts, level: 'ERROR', msg, ...meta };
  pushLog(entry);
  process.stderr.write(JSON.stringify(entry) + '\n');
}
