import type { BackgroundRuntimeConfigSnapshot, BackgroundRuntimeConfigService } from "./background-runtime-config.js";
import type { BackgroundLeaseHandle, BackgroundRuntimeLeaseService } from "./background-runtime-lease.js";

export type DynamicLeasedSchedulerOptions = {
  config: BackgroundRuntimeConfigService;
  lease: BackgroundRuntimeLeaseService;
  leaseName: Parameters<BackgroundRuntimeLeaseService["tryAcquire"]>[0];
  intervalMs: number;
  runImmediately?: boolean;
  getIntervalMs?: (snapshot: BackgroundRuntimeConfigSnapshot) => number;
  run: (snapshot: BackgroundRuntimeConfigSnapshot, handle: BackgroundLeaseHandle) => Promise<void>;
  onError?: (error: unknown) => void;
};

export async function startDynamicLeasedScheduler(options: DynamicLeasedSchedulerOptions): Promise<() => Promise<void>> {
  options.config.current();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let resolveStop!: () => void;
  const stopWait = new Promise<void>((resolve) => { resolveStop = resolve; });
  const intervalFor = (snapshot: BackgroundRuntimeConfigSnapshot): number => Math.max(0, options.getIntervalMs?.(snapshot) ?? options.intervalMs);
  const schedule = (delay: number): void => {
    if (stopped || running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void cycle(); }, delay);
    timer.unref();
  };
  const cycle = async (): Promise<void> => {
    if (stopped) return;
    running = (async () => {
      await options.lease.runWithLease(options.leaseName, async (handle) => {
        const snapshot = await options.config.getFresh();
        await options.run(snapshot, handle);
      });
    })().catch((error) => options.onError?.(error)).finally(() => {
      running = undefined;
      if (stopped) resolveStop();
      else schedule(intervalFor(options.config.current()));
    });
    await running;
  };
  const unsubscribe = options.config.subscribe((snapshot) => {
    if (!running) schedule(intervalFor(snapshot));
  });
  if (options.runImmediately) void cycle();
  else schedule(intervalFor(options.config.current()));
  return async () => {
    if (stopped) return stopWait;
    stopped = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!running) resolveStop();
    return stopWait;
  };
}