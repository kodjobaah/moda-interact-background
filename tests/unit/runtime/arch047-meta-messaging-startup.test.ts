import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: null as null | { closeResources: readonly (() => Promise<unknown>)[] },
  due: vi.fn(),
  loading: null as Promise<void> | null,
  workerClose: vi.fn(),
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
vi.mock("../../../src/workers/whatsapp.worker.js", () => ({ createWhatsappWorker: () => ({ close: mocks.workerClose }) }));

describe("ARCH-047 BG003 production messaging entrypoint", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("starts the due scheduler automatically, invokes the service and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.due.mockResolvedValue({ inspected: 1, processed: 1 });
    await import("../../../src/entrypoints/messaging.js");
    const loading = mocks.loading as Promise<void> | null;
    expect(loading).not.toBeNull();
    await loading;
    expect(mocks.load).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.due).toHaveBeenCalledExactlyOnceWith(25);
    const closers = mocks.load?.closeResources ?? [];
    for (const close of closers) await close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.due).toHaveBeenCalledTimes(1);
  });
});
