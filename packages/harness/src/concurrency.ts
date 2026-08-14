/**
 * A small hand-rolled concurrency limiter — build1-spec.md §4 asks for concurrency limits,
 * and this is the entire feature in about fifteen lines, not worth a dependency for.
 */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];

  function next(): void {
    if (active >= concurrency || queue.length === 0) {
      return;
    }
    active++;
    const release = queue.shift();
    release?.();
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      next();
    });
    try {
      return await fn();
    } finally {
      active--;
      next();
    }
  };
}
