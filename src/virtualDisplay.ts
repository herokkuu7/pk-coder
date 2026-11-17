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
  let onChildError: ((err: Error) => void) | undefined;
  let onChildExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let onReadinessError: ((err: Error) => void) | undefined;
  let onReadinessEnd: (() => void) | undefined;
  let onReadinessData: ((chunk: string) => void) | undefined;

  try {
    const name = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Xvfb did not report a ready display within 10 seconds')), 10_000);
      onChildError = (err) => reject(err);
      onChildExit = (code, signal) => reject(new Error(`Xvfb exited before the display was ready (${signal ?? code})`));
      onReadinessError = (err) => reject(err);
      onReadinessEnd = () => reject(new Error('Xvfb closed its display readiness pipe'));
      let output = '';
      onReadinessData = (chunk: string) => {
        output += chunk;
        const ready = /^(\d+)\n/.exec(output);
        if (ready) resolve(`:${ready[1]}`);
      };

      child.once('error', onChildError);
      child.once('exit', onChildExit);
      readiness.once('error', onReadinessError);
      readiness.once('end', onReadinessEnd);
      readiness.setEncoding('utf8');
      readiness.on('data', onReadinessData);
    });
    return { process: child, name };
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
    if (onChildError) child.off('error', onChildError);
    if (onChildExit) child.off('exit', onChildExit);
    if (onReadinessError) readiness.off('error', onReadinessError);
    if (onReadinessEnd) readiness.off('end', onReadinessEnd);
    if (onReadinessData) readiness.off('data', onReadinessData);
    readiness.destroy();
  }
}
