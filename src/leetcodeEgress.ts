import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { logWarn } from './config';
import { isPrivateOrReservedIp } from './security';

export async function openLeetCodeEgress(): Promise<{ server: string; close: () => void }> {
  const sockets = new Set<Duplex>();
  const server = createServer((_request, response) => response.writeHead(403).end());
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', async (request, client, head) => {
    client.on('error', () => client.destroy());
    const host = /^([a-z0-9.-]+):443$/i.exec(request.url ?? '')?.[1]?.toLowerCase();
    if (!host || (host !== 'leetcode.com' && !host.endsWith('.leetcode.com') && host !== 'challenges.cloudflare.com')) {
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
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch (error) {
      logWarn('LeetCode HTTPS egress could not resolve host', { host, code: (error as NodeJS.ErrnoException).code });
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
