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

  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      this.totalRejected++;
      throw new QueueFullError(
        `Solver queue full (active=${this.activeCount}/${this.maxConcurrent}, waiting=${this.queue.length}/${this.maxQueueSize})`
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
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
      try {
        const result = await item.task();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      } finally {
        this.activeCount--;
        this.totalProcessed++;
        this.dequeue();
      }
    })();
  }
}
