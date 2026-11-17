import { timingSafeEqual } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { Server } from 'node:http';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { logInfo } from './config';

export function isLeetCodeEgressHost(host: string): boolean {
  return host === 'leetcode.com' || host.endsWith('.leetcode.com') || host === 'challenges.cloudflare.com';
}

export type MobileDial = (host: string) => Promise<Duplex>;

interface OpenStream {
  socket: Duplex;
  ready: () => void;
  opened: boolean;
}

class MobileSession {
  private readonly streams = new Map<number, OpenStream>();
  private counter = 0;

  constructor(readonly websocket: WebSocket) {
    websocket.on('message', (data, binary) => this.receive(data, binary));
    websocket.once('close', () => {
      for (const stream of this.streams.values()) stream.socket.destroy(new Error('Android tunnel disconnected'));
    });
  }

  readonly dial: MobileDial = async host => {
    if (!isLeetCodeEgressHost(host) || this.websocket.readyState !== WebSocket.OPEN || this.streams.size >= 24) {
      throw new Error('Android tunnel unavailable for this connection');
    }
    const id = this.counter = (this.counter + 1) >>> 0;
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => stream.destroy(new Error('Android tunnel connection timed out')), 12_000);
      const endRemote = () => this.send({ t: 'close', id });
      const stream = new Duplex({
        read() {},
        write: (chunk: Buffer, _encoding, callback) => {
          if (this.websocket.readyState !== WebSocket.OPEN || this.websocket.bufferedAmount > 512 * 1024) {
            callback(new Error('Android tunnel cannot send data'));
            return;
          }
          const payload = Buffer.allocUnsafe(4 + chunk.length);
          payload.writeUInt32BE(id);
          chunk.copy(payload, 4);
          this.websocket.send(payload, callback);
        },
        final: callback => {
          endRemote();
          callback();
        },
        destroy: (error, callback) => {
          clearTimeout(timer);
          if (this.streams.delete(id)) endRemote();
          reject(error ?? new Error('Android tunnel stream closed'));
          callback(error);
        },
      });
      stream.on('error', () => {});
      const entry: OpenStream = {
        socket: stream,
        opened: false,
        ready: () => {
          entry.opened = true;
          clearTimeout(timer);
          resolve(stream);
        },
      };
      this.streams.set(id, entry);
      this.send({ t: 'open', id, host, port: 443 });
    });
  };

  private send(message: object): void {
    if (this.websocket.readyState === WebSocket.OPEN) this.websocket.send(JSON.stringify(message), () => {});
  }

  private receive(raw: RawData, binary: boolean): void {
    if (!Buffer.isBuffer(raw)) return;
    if (binary) {
      if (raw.length < 4) return;
      const stream = this.streams.get(raw.readUInt32BE(0))?.socket;
      if (!stream) return;
      if (stream.readableLength + raw.length > 512 * 1024) stream.destroy(new Error('Android tunnel receive buffer full'));
      else stream.push(raw.subarray(4));
      return;
    }
    let message: { t?: string; id?: number };
    try { message = JSON.parse(raw.toString()) ?? {}; }
    catch { return; }
    const stream = this.streams.get(message.id ?? -1);
    if (!stream) return;
    if (message.t === 'opened') stream.ready();
    else if (message.t === 'err') stream.socket.destroy(new Error('Android could not reach the HTTPS destination'));
    else if (message.t === 'close') {
      if (!stream.opened) {
        stream.socket.destroy(new Error('Android tunnel stream closed before opening'));
      } else {
        stream.socket.push(null);
        stream.socket.end();
      }
    }
  }
}

const wsServer = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 128 * 1024 });
let active: MobileSession | undefined;

function mobileToken(): string | undefined {
  const value = process.env.CPSOLVER_MOBILE_TOKEN?.trim();
  return value && /^[a-zA-Z0-9_-]{32,128}$/.test(value) ? value : undefined;
}

export function getMobileDial(): MobileDial | undefined {
  return active?.websocket.readyState === WebSocket.OPEN ? active.dial : undefined;
}

export function closeMobileTunnel(): void {
  active?.websocket.terminate();
  active = undefined;
}

export function attachMobileTunnel(server: Server): void {
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    const token = mobileToken();
    if (request.url !== '/mobile/leetcode/tunnel' || !token) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    wsServer.handleUpgrade(request, socket, head, websocket => {
      const authTimer = setTimeout(() => websocket.close(1008, 'Authentication timed out'), 6000);
      websocket.on('error', () => websocket.terminate());
      websocket.once('close', () => clearTimeout(authTimer));
      websocket.once('message', (raw, binary) => {
        clearTimeout(authTimer);
        let candidate = '';
        try {
          const message = JSON.parse(raw.toString());
          if (!binary && message?.t === 'auth' && typeof message.token === 'string') candidate = message.token;
        } catch {}
        const given = Buffer.from(candidate);
        const expected = Buffer.from(token);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
          websocket.close(1008, 'Invalid Android tunnel credential');
          return;
        }
        active?.websocket.terminate();
        const session = new MobileSession(websocket);
        active = session;
        let alive = true;
        websocket.on('pong', () => { alive = true; });
        const timer = setInterval(() => {
          if (!alive) websocket.terminate();
          else { alive = false; websocket.ping(); }
        }, 12_000);
        websocket.once('close', () => {
          clearInterval(timer);
          if (active === session) active = undefined;
        });
        websocket.send(JSON.stringify({ t: 'auth_ok' }));
        logInfo('Android LeetCode tunnel connected');
      });
    });
  });
}
