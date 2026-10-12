import { AsyncResource } from 'node:async_hooks';

export class QueueFullError extends Error {
  constructor(message = 'Solver concurrency queue is full. Try again shortly.') {
    super(message);
    this.name = 'QueueFullError';
  }
}

interface QueuedItem<T> {
  task: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  controller: AbortController;
  detachAbort: () => void;
}

export class ConcurrencyQueue {
  private activeCount = 0;
  private queue: QueuedItem<any>[] = [];
  private totalProcessed = 0;
  private totalRejected = 0;

  constructor(
    private readonly maxConcurrent: number = 1,
    private readonly maxQueueSize: number = 10,
  ) {}

  public get active(): number {
    return this.activeCount;
  }

  public get waiting(): number {
    return this.queue.length;
  }

  public get processed(): number {
    return this.totalProcessed;
  }

  public get rejected(): number {
    return this.totalRejected;
  }

  public get capacity(): { maxConcurrent: number; maxQueueSize: number } {
    return {
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize,
    };
  }

  public async run<T>(task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new Error('Task was aborted before entering queue');
    }

    if (this.activeCount >= this.maxConcurrent && this.queue.length >= this.maxQueueSize) {
      this.totalRejected++;
      throw new QueueFullError(
        `Solver queue full (active=${this.activeCount}/${this.maxConcurrent}, waiting=${this.queue.length}/${this.maxQueueSize})`
      );
    }

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const item: QueuedItem<T> = { task: AsyncResource.bind(task), resolve, reject, controller, detachAbort: () => {} };

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(item);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new Error('Task aborted while waiting in concurrency queue'));
            item.detachAbort();
          } else {
            const error = new Error('Task aborted during execution');
            controller.abort(error);
            reject(error);
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        item.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      this.queue.push(item);
      this.dequeue();
    });
  }

  private dequeue(): void {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.activeCount++;

    (async () => {
      let timeoutTimer: NodeJS.Timeout | null = null;
      try {
        timeoutTimer = setTimeout(() => {
          const error = new Error('Task execution timed out after 120s in concurrency queue');
          item.controller.abort(error);
          item.reject(error);
        }, 120_000);
        // Reject the caller on cancellation, but hold capacity until work has
        // stopped and completed its cleanup. A Promise.race freed the slot early.
        const result = await item.task(item.controller.signal);
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        item.detachAbort();
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.totalProcessed++;
        this.dequeue();
      }
    })();
  }
}
