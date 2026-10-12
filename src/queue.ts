export class QueueFullError extends Error {
  constructor(message = 'Solver concurrency queue is full. Try again shortly.') {
    super(message);
    this.name = 'QueueFullError';
  }
}

interface QueuedItem<T> {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
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

  public async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new Error('Task was aborted before entering queue');
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.totalRejected++;
      throw new QueueFullError(
        `Solver queue full (active=${this.activeCount}/${this.maxConcurrent}, waiting=${this.queue.length}/${this.maxQueueSize})`
      );
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueuedItem<T> = { task, resolve, reject };

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(item);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new Error('Task aborted while waiting in concurrency queue'));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
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
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            reject(new Error('Task execution timed out after 95s in concurrency queue'));
          }, 95_000);
        });

        const result = await Promise.race([item.task(), timeoutPromise]);
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.totalProcessed++;
        this.dequeue();
      }
    })();
  }
}
