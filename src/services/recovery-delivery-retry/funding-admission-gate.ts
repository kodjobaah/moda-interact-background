/** Avoid competing for the same Shop row from retry funding calls in this
 * process, BEFORE opening a Prisma transaction. This is not a distributed
 * lock, a cached billing decision, or permission to send. Each operation
 * still reads and validates durable state under the existing database locks.
 * No provider calls belong inside the callback.
 */
const pendingByShop = new Map<string, Promise<void>>();

export async function serializeRetryFunding<T>(
  shopId: string, operation: (queueWaitMs: number) => Promise<T>,
): Promise<T> {
  const queuedAt = performance.now();
  const previous = pendingByShop.get(shopId);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pendingByShop.set(shopId, current);
  try {
    if (previous) await previous;
    return await operation(Math.round(performance.now() - queuedAt));
  } finally {
    release();
    if (pendingByShop.get(shopId) === current) pendingByShop.delete(shopId);
  }
}
