import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface VirtualDisplay {
  process: ChildProcess;
  name: string;
}

export async function startVirtualDisplay(): Promise<VirtualDisplay> {
  const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
  });
  const readiness = child.stdio[3] as Readable;
  let timer: NodeJS.Timeout | undefined;

  try {
    const name = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Xvfb did not report a ready display within 10 seconds')), 10_000);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        reject(new Error(`Xvfb exited before the display was ready (${signal ?? code})`));
      });
      readiness.once('error', reject);
      readiness.once('end', () => reject(new Error('Xvfb closed its display readiness pipe')));
      readiness.setEncoding('utf8');
      let output = '';
      readiness.on('data', (chunk: string) => {
        output += chunk;
        const ready = /^(\d+)\n/.exec(output);
        if (ready) resolve(`:${ready[1]}`);
      });
    });
    return { process: child, name };
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
