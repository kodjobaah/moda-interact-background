import { describe, expect, it, vi } from "vitest";

import { BackgroundRuntimeConfigService, type BackgroundRuntimeConfigSnapshot } from "../../../src/runtime/background-runtime-config.js";
import { backgroundRuntimeConfig } from "../../helpers/background-runtime-config.js";

function config(
  version = 1,
  overrides: Partial<BackgroundRuntimeConfigSnapshot> = {},
): BackgroundRuntimeConfigSnapshot {
  return Object.freeze(backgroundRuntimeConfig({
    version, createdAt: new Date(1), updatedAt: new Date(version), ...overrides,
  }));
}

function database(row: BackgroundRuntimeConfigSnapshot | null) {
  return { backgroundRuntimeConfig: { findUnique: vi.fn().mockResolvedValue(row) } } as any;
}

describe("BackgroundRuntimeConfigService", () => {
  it("rejects a usage retry maximum below its base", async () => {
    const invalid = { ...config(), shopifyUsageRetryBaseSeconds: 61, shopifyUsageRetryMaxSeconds: 60 };
    await expect(new BackgroundRuntimeConfigService(database(invalid)).start()).rejects.toThrow(
      "usage retry max must be at least the base",
    );
  });
  it("requires startup before current can be read and publishes immutable dates", async () => {
    const row = config();
    const service = new BackgroundRuntimeConfigService(database(row));
    expect(() => service.current()).toThrow("Background runtime configuration has not started.");

    await service.start();
    const snapshot = service.current();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.createdAt)).toBe(true);
    expect(Object.isFrozen(snapshot.updatedAt)).toBe(true);
    expect(() => snapshot.createdAt.setTime(2)).toThrow("Immutable runtime configuration date.");
    expect(() => snapshot.updatedAt.setUTCFullYear(2020)).toThrow("Immutable runtime configuration date.");
    expect(row.createdAt.getTime()).toBe(1);
    expect(row.updatedAt.getTime()).toBe(1);
  });

  it("loads the singleton initially and rejects a missing row", async () => {
    const service = new BackgroundRuntimeConfigService(database(config()));
    await service.start();
    expect(service.current().version).toBe(1);
    await expect(new BackgroundRuntimeConfigService(database(null)).start()).rejects.toThrow("Background runtime configuration is missing.");
  });

  it("accepts newer versions and ignores equal or older versions", async () => {
    const db = database(config(1));
    const service = new BackgroundRuntimeConfigService(db);
    await service.start();
    db.backgroundRuntimeConfig.findUnique.mockResolvedValueOnce(config(2)).mockResolvedValueOnce(config(1));
    await service.getFresh();
    await service.getFresh();
    expect(service.current().version).toBe(2);
  });

  it.each([0, 1, 21, 90, 91, 180, 365, 2_147_483_647])(
    "accepts lifetime %i during startup and refresh",
    async (lifetimeDays) => {
      const startupService = new BackgroundRuntimeConfigService(database(config(1, {
        checkoutRecoveryLifetimeDays: lifetimeDays,
      })));
      await startupService.start();
      expect(startupService.current().checkoutRecoveryLifetimeDays).toBe(lifetimeDays);
      await startupService.close();

      const db = database(config(1));
      const refreshService = new BackgroundRuntimeConfigService(db);
      await refreshService.start();
      db.backgroundRuntimeConfig.findUnique.mockResolvedValueOnce(config(2, {
        checkoutRecoveryLifetimeDays: lifetimeDays,
      }));
      await refreshService.getFresh();
      expect(refreshService.current().checkoutRecoveryLifetimeDays).toBe(lifetimeDays);
      await refreshService.close();
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "21", null, {}])(
    "rejects malformed lifetime %s at startup",
    async (lifetimeDays) => {
      const service = new BackgroundRuntimeConfigService(database(config(1, {
        checkoutRecoveryLifetimeDays: lifetimeDays,
      } as any)));
      await expect(service.start()).rejects.toThrow(
        "Invalid background runtime configuration: invalid checkoutRecoveryLifetimeDays.",
      );
      await service.close();
    },
  );

  it("retains the last good lifetime when refresh receives an invalid value", async () => {
    const db = database(config(1, { checkoutRecoveryLifetimeDays: 180 }));
    const log = { warn: vi.fn() } as any;
    const service = new BackgroundRuntimeConfigService(db, log);
    await service.start();
    db.backgroundRuntimeConfig.findUnique.mockResolvedValueOnce(config(2, {
      checkoutRecoveryLifetimeDays: -1,
    }));

    await expect(service.getFresh()).resolves.toMatchObject({
      checkoutRecoveryLifetimeDays: 180,
      version: 1,
    });
    expect(log.warn).toHaveBeenCalledWith("background.runtime_config.refresh_failed", expect.objectContaining({
      error: expect.objectContaining({
        message: "Invalid background runtime configuration: invalid checkoutRecoveryLifetimeDays.",
      }),
    }));
    await service.close();
  });

  it("retains the last known good row and isolates listener failures", async () => {
    const db = database(config(1));
    const log = { warn: vi.fn() } as any;
    const service = new BackgroundRuntimeConfigService(db, log);
    const first = vi.fn().mockRejectedValue(new Error("listener"));
    const second = vi.fn();
    service.subscribe(first);
    service.subscribe(second);
    await service.start();
    db.backgroundRuntimeConfig.findUnique.mockRejectedValueOnce(new Error("temporary"));
    expect((await service.getFresh()).version).toBe(1);
    db.backgroundRuntimeConfig.findUnique.mockResolvedValueOnce(config(2));
    await service.getFresh();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});