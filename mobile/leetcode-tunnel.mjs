import { lookup } from 'node:dns/promises';
import { connect, isIP } from 'node:net';

const token = process.env.CPSOLVER_MOBILE_TOKEN?.trim();
const endpoint = new URL(process.env.CPSOLVER_MOBILE_URL || 'wss://pk-coder.onrender.com/mobile/leetcode/tunnel');
const loopback = endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname);
if ((!loopback && endpoint.protocol !== 'wss:') || endpoint.username || endpoint.password || endpoint.search) {
  throw new Error('Configure a TLS WebSocket URL without credentials or query parameters');
}
if (!token || !/^[a-zA-Z0-9_-]{32,128}$/.test(token) || typeof WebSocket !== 'function') {
  throw new Error('Node.js 22+ and a CPSOLVER_MOBILE_TOKEN are required');
}

const allowed = /^(?:(?:[a-z0-9-]+\.)*leetcode\.com|challenges\.cloudflare\.com)$/;

function publicAddress(address) {
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0|db8):/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
    !(a === 192 && b === 0 && (c === 0 || c === 2)) && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113);
}

let retryMs = 2000;

function dialRender() {
  const ws = new WebSocket(endpoint);
  ws.binaryType = 'arraybuffer';
  const streams = new Map();
  const opening = new Set();
  let authenticated = false;
  const authDeadline = setTimeout(() => ws.close(), 12_000);
  const send = message => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };

  ws.addEventListener('open', () => send({ t: 'auth', token }));
  ws.addEventListener('message', async ({ data }) => {
    if (data instanceof ArrayBuffer) {
      if (!authenticated) return;
      const payload = Buffer.from(data);
      if (payload.length < 4) return;
      const socket = streams.get(payload.readUInt32BE(0));
      if (!socket) return;
      if (socket.writableLength > 512 * 1024) socket.destroy();
      else socket.write(payload.subarray(4));
      return;
    }
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message?.t === 'auth_ok') {
      clearTimeout(authDeadline);
      authenticated = true;
      retryMs = 2000;
      console.log('Android tunnel connected to CPSolver');
      return;
    }
    if (!authenticated) return;
    const id = message?.id;
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) return;
    if (message.t === 'close') {
      opening.delete(id);
      const s = streams.get(id);
      if (s) {
        if (s.connecting) s.destroy();
        else s.end();
      }
      return;
    }
    if (message.t !== 'open') return;

    const host = String(message.host ?? '').toLowerCase();
    if (!allowed.test(host) || message.port !== 443 || streams.size + opening.size >= 24 || streams.has(id) || opening.has(id)) {
      send({ t: 'err', id });
      return;
    }
    opening.add(id);
    try {
      const addresses = await lookup(host, { all: true });
      if (!opening.delete(id) || ws.readyState !== WebSocket.OPEN) return;
      if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Nonpublic destination');
      const destination = addresses.find(({ family }) => family === 4) ?? addresses[0];
      const socket = connect({ host: destination.address, family: destination.family, port: 443 });
      let established = false;
      streams.set(id, socket);
      socket.setTimeout(12_000, () => socket.destroy());
      socket.once('connect', () => {
        socket.setTimeout(0);
        established = true;
        send({ t: 'opened', id });
      });
      socket.on('data', chunk => {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 512 * 1024) {
          socket.destroy();
          return;
        }
        const frame = Buffer.allocUnsafe(4 + chunk.length);
        frame.writeUInt32BE(id);
        chunk.copy(frame, 4);
        ws.send(frame);
      });
      socket.on('error', () => {});
      socket.once('close', () => {
        streams.delete(id);
        send({ t: established ? 'close' : 'err', id });
      });
    } catch {
      opening.delete(id);
      send({ t: 'err', id });
    }
  });
  ws.addEventListener('close', ({ code, reason }) => {
    clearTimeout(authDeadline);
    opening.clear();
    for (const socket of streams.values()) socket.destroy();
    if (code === 1008 && reason === 'Invalid Android tunnel credential') {
      console.error('Render rejected CPSOLVER_MOBILE_TOKEN. Check that the two values match.');
      process.exitCode = 1;
      return;
    }
    console.log('Android tunnel disconnected. Reconnecting.');
    setTimeout(dialRender, retryMs);
    retryMs = Math.min(30_000, Math.round(retryMs * 1.5));
  });
  ws.addEventListener('error', () => {});
}

dialRender();
