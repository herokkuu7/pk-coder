import { lookup } from 'node:dns/promises';
import { createServer, request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { logInfo, logWarn } from './config';
import { isPrivateOrReservedIp } from './security';
import type { ProxyConfig } from './types';
import { isLeetCodeEgressHost, type MobileDial } from './mobileTunnel';

let recordedProbe = false;

export function probeLeetCodeConnectivity() {
  if (recordedProbe) return;
  recordedProbe = true;
  void fetch('https://leetcode.com/accounts/login/', { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    .then(response => {
      logInfo('LeetCode direct HTTPS probe completed', {
        status: response.status,
        cloudflareChallenge: response.headers.get('cf-mitigated') === 'challenge',
      });
      return response.body?.cancel();
    })
    .catch(error => logWarn('LeetCode direct HTTPS probe failed', { error: String(error) }));
}

function connectViaProxy(proxy: ProxyConfig, host: string): Promise<Socket> {
  const address = new URL(proxy.server);
  const send = address.protocol === 'https:' ? requestHttps : requestHttp;
  return new Promise<Socket>((resolve, reject) => {
    const headers: Record<string, string> = { Host: `${host}:443` };
    if (proxy.username || proxy.password) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`).toString('base64')}`;
    }
    const request = send(address, { method: 'CONNECT', path: `${host}:443`, headers });
    request.once('error', reject);
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`LeetCode proxy rejected CONNECT with HTTP ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.setTimeout(12_000, () => request.destroy(new Error('LeetCode proxy CONNECT timed out')));
    request.end();
  });
}

export async function openLeetCodeEgress(proxy?: ProxyConfig, mobileDial?: MobileDial): Promise<{ server: string; close: () => void }> {
  const sockets = new Set<Duplex>();
  const server = createServer((_request, response) => response.writeHead(403).end());
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', async (request, client, head) => {
    client.on('error', () => client.destroy());
    const host = /^([a-z0-9.-]+):443$/i.exec(request.url ?? '')?.[1]?.toLowerCase();
    if (!host || !isLeetCodeEgressHost(host)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    try {
      const addresses = await lookup(host, { all: true, verbatim: false });
      if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      if (client.destroyed) return;

      const establish = (upstream: Duplex) => {
        if (host === 'leetcode.com') logInfo('LeetCode browser HTTPS connection established', { upstreamProxy: Boolean(proxy), mobileTunnel: Boolean(mobileDial) });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      };

      if (mobileDial || proxy) {
        const upstream = mobileDial ? await mobileDial(host) : await connectViaProxy(proxy!, host);
        if (client.destroyed) { upstream.destroy(); return; }
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        upstream.on('error', () => client.destroy());
        client.once('close', () => upstream.destroy());
        establish(upstream);
        return;
      }

      const upstream = connect({ host: addresses[0]!.address, port: 443 });
      let established = false;
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      client.once('close', () => upstream.destroy());
      upstream.once('error', error => {
        logWarn('LeetCode HTTPS egress connection failed', { host, code: (error as NodeJS.ErrnoException).code });
        if (established) client.destroy();
        else client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
      upstream.setTimeout(12_000, () => {
        client.destroy();
        upstream.destroy();
      });
      upstream.once('connect', () => {
        established = true;
        upstream.setTimeout(0);
        establish(upstream);
      });
    } catch (error) {
      logWarn('LeetCode HTTPS egress failed', { host, error: String(error) });
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
