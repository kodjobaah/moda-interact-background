export type BillingReconcile = () => Promise<unknown>;

export function startBillingReconciliationScheduler(
  reconcile: BillingReconcile,
  intervalMs = 60_000,
  onError: (error: unknown) => void = (error) => console.error("billing reconciliation failed", error),
): () => void {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const scheduleNext = (): void => {
    if (closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, intervalMs);
    timer.unref();
  };
  const run = async (): Promise<void> => {
    try {
      await reconcile();
    } catch (error) {
      onError(error);
    } finally {
      scheduleNext();
    }
  };

  scheduleNext();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}