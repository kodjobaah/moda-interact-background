import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: null as null | { closeResources: readonly (() => Promise<unknown>)[] },
  due: vi.fn(),
  loading: null as Promise<void> | null,
  workerClose: vi.fn(),
  repairStart: vi.fn(),
  repairClose: vi.fn(async () => {}),
  multipartStart: vi.fn(),
  multipartClose: vi.fn(async () => {}),
  queue: { add: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => mocks.logger,
}));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));
vi.mock("../../../src/services/meta-template-management/service.js", () => ({
  metaTemplateManagementService: { processDueRegistrations: mocks.due },
}));
vi.mock("../../../src/services/recovery-multipart/runtime.js", () => ({
  startMultipartRepair: mocks.multipartStart,
}));
vi.mock("../../../src/services/conversation-ai-delay/start-pending-turn-repair.js", () => ({
  startProductionPendingTurnRepair: mocks.repairStart,
}));
vi.mock("../../../src/runtime/readiness.js", () => ({
  startReadyWorkerProcess: vi.fn((options: { loadWorkerProcess: () => Promise<{
    closeResources: readonly (() => Promise<unknown>)[];
  }> }) => {
    const loading = options.loadWorkerProcess().then((loaded) => { mocks.load = loaded; });
    mocks.loading = loading;
    return loading;
  }),
}));
vi.mock("../../../src/runtime/observability.js", () => ({ closeWorkerObservability: vi.fn(async () => {}) }));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/observability/queue-performance.js", () => ({
  startQueuePerformanceTelemetry: () => async () => {},
}));
vi.mock("../../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: { start: vi.fn(async () => {}), close: vi.fn(async () => {}) },
}));
vi.mock("../../../src/runtime/background-runtime-lease.js", () => ({ backgroundRuntimeLeaseService: {} }));
vi.mock("../../../src/runtime/queue-concurrency-controller.js", () => ({
  startQueueConcurrencyController: vi.fn(async () => async () => {}),
}));
vi.mock("../../../src/services/recovery-conversation/start-human-command-dispatcher.js", () => ({
  startHumanCommandDispatcher: vi.fn(async () => async () => {}),
}));
vi.mock("../../../src/entrypoints/resources.js", () => ({
  closeWorkerResources: [async () => {}],
}));
vi.mock("../../../src/workers/whatsapp.worker.js", () => ({
  createWhatsappWorker: () => ({ close: mocks.workerClose }),
  whatsappQueue: mocks.queue,
}));

describe("ARCH-047 BG003 production messaging entrypoint", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("starts the due scheduler automatically, invokes the service and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.due.mockResolvedValue({ inspected: 1, processed: 1 });
    mocks.repairStart.mockReturnValue(mocks.repairClose);
    mocks.multipartStart.mockReturnValue(mocks.multipartClose);
    await import("../../../src/entrypoints/messaging.js");
    const loading = mocks.loading as Promise<void> | null;
    expect(loading).not.toBeNull();
    await loading;
    expect(mocks.load).not.toBeNull();
    expect(mocks.repairStart).toHaveBeenCalledExactlyOnceWith(mocks.queue);
    expect(mocks.multipartStart).toHaveBeenCalledExactlyOnceWith();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.due).toHaveBeenCalledExactlyOnceWith(25);
    const closers = mocks.load?.closeResources ?? [];
    for (const close of closers) await close();
    expect(mocks.repairClose).toHaveBeenCalledOnce();
    expect(mocks.multipartClose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.due).toHaveBeenCalledTimes(1);
  });
});
