/**
 * Minimal promise concurrency limiter for the import queue.
 *
 * `run(task)` executes tasks FIFO, at most `maxConcurrent` at a time, and
 * resolves/rejects with the task's own outcome. A rejected task never jams
 * the queue — the next waiting task still starts.
 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(maxConcurrent: number): Limiter {
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`maxConcurrent must be >= 1, got ${maxConcurrent}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  const startNext = () => {
    if (active >= maxConcurrent) return;
    const start = waiting.shift();
    if (!start) return;
    active++;
    start();
  };

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            startNext();
          });
      });
      startNext();
    });
  };
}
