export type BillingReconcile = () => Promise<unknown>;
export type BillingReconciliationErrorReporter = (error: unknown) => void;

export function startBillingReconciliationScheduler(
  reconcile: BillingReconcile,
  intervalMs = 60_000,
  onError: BillingReconciliationErrorReporter = () => undefined,
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