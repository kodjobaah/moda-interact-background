import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  InboundWhatsAppAbuseAdmissionService,
} from "../../../src/services/inbound-whatsapp-abuse-admission.service.js";

const workerSource = readFileSync(
  new URL("../../../src/workers/whatsapp.worker.ts", import.meta.url),
  "utf8",
);

function phoneHash(phone: string): string {
  const normalized = phone.trim().startsWith("+")
    ? `+${phone.trim().replace(/\D/g, "")}`
    : phone.trim().replace(/\D/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

class RedisLikeAdmissionHarness {
  private nowMs = 0;
  private readonly sets = new Map<string, Map<string, number>>();

  eval = vi.fn(
    async (_script: string, keyCount: number, ...args: unknown[]) => {
      const keys = args.slice(0, keyCount) as string[];
      const member = String(args[keyCount]);
      const scopeArgs = args.slice(keyCount + 1).map(Number);
      const scopes = keys.map((key, index) => ({
        key,
        windowMs: scopeArgs[index * 2]!,
        limit: scopeArgs[index * 2 + 1]!,
      }));

      let seenAnywhere = false;
      for (const scope of scopes) {
        const members = this.sets.get(scope.key) ?? new Map();
        for (const [value, score] of members) {
          if (score <= this.nowMs - scope.windowMs) members.delete(value);
        }
        this.sets.set(scope.key, members);
        if (members.has(member)) seenAnywhere = true;
      }

      if (seenAnywhere) return 0;

      for (const [index, scope] of scopes.entries()) {
        const members = this.sets.get(scope.key)!;
        if (members.size >= scope.limit) return index + 1;
      }

      for (const scope of scopes) {
        const members = this.sets.get(scope.key)!;
        if (!members.has(member)) members.set(member, this.nowMs);
      }
      return 0;
    },
  );

  advanceTime(milliseconds: number): void {
    this.nowMs += milliseconds;
  }

  seed(key: string, count: number, prefix = "seed"): void {
    const members = this.sets.get(key) ?? new Map<string, number>();
    for (let index = 0; index < count; index += 1) {
      members.set(`${prefix}-${index}`, this.nowMs);
    }
    this.sets.set(key, members);
  }

  count(keyPart: string): number {
    const entry = [...this.sets.entries()].find(([key]) => key.includes(keyPart));
    return entry?.[1].size ?? 0;
  }

  score(keyPart: string, member: string): number | undefined {
    const entry = [...this.sets.entries()].find(([key]) => key.includes(keyPart));
    return entry?.[1].get(member);
  }

  snapshot(keys: string[]): Record<string, Array<[string, number]>> {
    return Object.fromEntries(
      keys.map((key) => [
        key,
        [...(this.sets.get(key) ?? new Map()).entries()],
      ]),
    );
  }

  has(key: string, member: string): boolean {
    return this.sets.get(key)?.has(member) ?? false;
  }
}

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function rawInput(index: number) {
  return {
    providerMessageId: `wamid-${index}`,
    customerPhone: "+447700900000",
  };
}

function turnInput(index: number, overrides: Record<string, unknown> = {}) {
  return {
    conversationId: `conversation-${index}`,
    observedVersion: index,
    shopId: "shop-1",
    customerPhone: "+447700900000",
    conversationType: "PRODUCT_SUPPORT" as const,
    hasReplyContext: false,
    checkoutRecoveryId: null,
    ...overrides,
  };
}

function settledScopeKeys(input: ReturnType<typeof turnInput>): string[] {
  const sender = phoneHash(String(input.customerPhone));
  return [
    `arch007:wa-abuse:v1:turn:sender:${sender}:60s`,
    `arch007:wa-abuse:v1:turn:sender:${sender}:600s`,
    `arch007:wa-abuse:v1:turn:conversation:${input.conversationId}:60s`,
    `arch007:wa-abuse:v1:turn:conversation:${input.conversationId}:600s`,
    `arch007:wa-abuse:v1:turn:shop:${input.shopId}:60s`,
    "arch007:wa-abuse:v1:turn:global:60s",
  ];
}

describe("InboundWhatsAppAbuseAdmissionService", () => {
  it("uses one atomic Redis operation and hashes sender keys", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(0) };
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());

    await expect(
      service.admitRaw({
        providerMessageId: "wamid-1",
        customerPhone: "+44 (7700) 900000",
      }),
    ).resolves.toEqual({ kind: "allowed" });

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const args = redis.eval.mock.calls[0] as unknown[];
    expect(args[1]).toBe(2);
    expect(args).toContain(
      `arch007:wa-abuse:v1:raw:sender:${phoneHash("+44 (7700) 900000")}:60s`,
    );
    expect(args.join(" ")).not.toContain("7700");
    expect(args.join(" ")).not.toContain("900000");
  });

  it("maps the atomic scope result to a bounded denial reason", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(3) };
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());

    await expect(
      service.admitSettledTurn({
        conversationId: "conversation-1",
        observedVersion: 7,
        shopId: "shop-1",
        customerPhone: "+447700900000",
        conversationType: "PRODUCT_SUPPORT",
        hasReplyContext: false,
        checkoutRecoveryId: null,
      }),
    ).resolves.toEqual({
      kind: "denied",
      stage: "settled-turn",
      reason: "TURN_CONVERSATION_SHORT",
    });
  });

  it("B011-06 fails closed when Redis cannot make a decision", async () => {
    const redis = { eval: vi.fn().mockRejectedValue(new Error("redis down")) };
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());

    await expect(
      service.admitRaw({
        providerMessageId: "wamid-1",
        customerPhone: "+447700900000",
      }),
    ).resolves.toEqual({
      kind: "denied",
      stage: "raw",
      reason: "LIMITER_UNAVAILABLE",
    });
  });

  it("B011-03 performs raw admission before routing or persistence", () => {
    expect(workerSource.indexOf("admitRaw")).toBeLessThan(
      workerSource.indexOf("recoveryRoutingService.resolveInboundMessage"),
    );
    expect(workerSource.indexOf("admitRaw")).toBeLessThan(
      workerSource.indexOf("conversationService.receiveMessage"),
    );
  });

  it("B011-05 returns from raw denial before downstream work", () => {
    const admissionBlock = workerSource.slice(
      workerSource.indexOf("const abuse = await inboundWhatsAppAbuseAdmissionService.admitRaw"),
      workerSource.indexOf("const route = await recoveryRoutingService.resolveInboundMessage"),
    );
    expect(admissionBlock).toMatch(/if \(abuse\.kind !== "allowed"\) return;/);
    expect(admissionBlock).not.toMatch(/receiveMessage|runCommerceAgent|sendPreparedText/);
  });

  it("uses discovery limits only without reply context", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(0) };
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());

    await service.admitSettledTurn({
      conversationId: "conversation-1",
      observedVersion: 1,
      shopId: "shop-1",
      customerPhone: "+447700900000",
      conversationType: "PRODUCT_DISCOVERY",
      hasReplyContext: false,
      checkoutRecoveryId: null,
    });

    const args = redis.eval.mock.calls[0] as unknown[];
    expect(args).toContain("4");
    expect(args).toContain("12");
  });

  it("B011-01 allows 60 raw sender members and denies the 61st", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    for (let index = 0; index < 60; index += 1) {
      await expect(service.admitRaw(rawInput(index))).resolves.toEqual({ kind: "allowed" });
    }
    await expect(service.admitRaw(rawInput(60))).resolves.toMatchObject({
      kind: "denied",
      reason: "RAW_SENDER",
    });
  });

  it("B011-02 replays a raw member without consuming or refreshing its slot", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    await service.admitRaw(rawInput(1));
    const before = redis.score("raw:sender", "wamid-1");
    redis.advanceTime(30_000);
    await service.admitRaw(rawInput(1));
    expect(redis.score("raw:sender", "wamid-1")).toBe(before);
    expect(redis.count("raw:sender")).toBe(1);
  });

  it("B011-04 denies at the raw global limit while a candidate sender is below its limit", async () => {
    const redis = new RedisLikeAdmissionHarness();
    redis.seed("arch007:wa-abuse:v1:raw:global:60s", 20_000);
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    await expect(service.admitRaw(rawInput(1))).resolves.toMatchObject({
      kind: "denied",
      reason: "RAW_GLOBAL",
    });
    expect(redis.count("raw:sender")).toBe(0);
  });

  it("B011-07 keeps raw phone data out of Redis keys and structured logs", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(0) };
    const logs = logger();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logs);
    await service.admitRaw({ providerMessageId: "wamid-private", customerPhone: "+447700900000" });
    expect(JSON.stringify(redis.eval.mock.calls)).not.toContain("447700900000");
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain("447700900000");
  });

  it("B011-08 independently enforces sender-short and conversation-short limits", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    for (let index = 0; index < 12; index += 1) {
      await expect(service.admitSettledTurn(turnInput(index))).resolves.toEqual({ kind: "allowed" });
    }
    await expect(service.admitSettledTurn(turnInput(12))).resolves.toMatchObject({
      kind: "denied",
      reason: "TURN_SENDER_SHORT",
    });

    const conversationRedis = new RedisLikeAdmissionHarness();
    const conversationService = new InboundWhatsAppAbuseAdmissionService(conversationRedis, logger());
    for (let index = 0; index < 12; index += 1) {
      await expect(conversationService.admitSettledTurn(turnInput(index, {
        conversationId: "conversation-shared",
        customerPhone: `+447700900${String(index).padStart(3, "0")}`,
      }))).resolves.toEqual({ kind: "allowed" });
    }
    await expect(conversationService.admitSettledTurn(turnInput(12, {
      conversationId: "conversation-shared",
      customerPhone: "+447700901012",
    }))).resolves.toMatchObject({
      kind: "denied",
      reason: "TURN_CONVERSATION_SHORT",
    });
  });

  it("B011-09 independently enforces sender-long and conversation-long limits", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    for (let batch = 0; batch < 5; batch += 1) {
      for (let index = 0; index < 12; index += 1) {
        await service.admitSettledTurn(turnInput(batch * 12 + index));
      }
      redis.advanceTime(60_001);
    }
    await expect(service.admitSettledTurn(turnInput(61))).resolves.toMatchObject({
      kind: "denied",
      reason: "TURN_SENDER_LONG",
    });

    const conversationRedis = new RedisLikeAdmissionHarness();
    const conversationService = new InboundWhatsAppAbuseAdmissionService(conversationRedis, logger());
    for (let batch = 0; batch < 5; batch += 1) {
      for (let index = 0; index < 12; index += 1) {
        await conversationService.admitSettledTurn(turnInput(batch * 12 + index, {
          conversationId: "conversation-long",
          customerPhone: `+447701${String(batch * 12 + index).padStart(4, "0")}`,
        }));
      }
      conversationRedis.advanceTime(60_001);
    }
    await expect(conversationService.admitSettledTurn(turnInput(61, {
      conversationId: "conversation-long",
      customerPhone: "+447799999999",
    }))).resolves.toMatchObject({
      kind: "denied",
      reason: "TURN_CONVERSATION_LONG",
    });
  });

  it("B011-10 independently enforces discovery sender and conversation limits", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    for (let index = 0; index < 4; index += 1) await service.admitSettledTurn(turnInput(index, { conversationType: "PRODUCT_DISCOVERY" }));
    await expect(service.admitSettledTurn(turnInput(4, { conversationType: "PRODUCT_DISCOVERY" }))).resolves.toMatchObject({ reason: "TURN_SENDER_SHORT" });
    redis.advanceTime(60_001);
    for (let batch = 0; batch < 2; batch += 1) {
      for (let index = 0; index < 4; index += 1) {
        await service.admitSettledTurn(turnInput(batch * 4 + index + 4, { conversationType: "PRODUCT_DISCOVERY" }));
      }
      redis.advanceTime(60_001);
    }
    await expect(service.admitSettledTurn(turnInput(12, { conversationType: "PRODUCT_DISCOVERY" }))).resolves.toMatchObject({ reason: "TURN_SENDER_LONG" });

    const conversationRedis = new RedisLikeAdmissionHarness();
    const conversationService = new InboundWhatsAppAbuseAdmissionService(conversationRedis, logger());
    for (let index = 0; index < 4; index += 1) {
      await conversationService.admitSettledTurn(turnInput(index, {
        conversationId: "discovery-conversation",
        customerPhone: `+447702900${String(index).padStart(3, "0")}`,
        conversationType: "PRODUCT_DISCOVERY",
      }));
    }
    await expect(conversationService.admitSettledTurn(turnInput(4, {
      conversationId: "discovery-conversation",
      customerPhone: "+447702901004",
      conversationType: "PRODUCT_DISCOVERY",
    }))).resolves.toMatchObject({ reason: "TURN_CONVERSATION_SHORT" });
    conversationRedis.advanceTime(60_001);
    for (let batch = 0; batch < 2; batch += 1) {
      for (let index = 0; index < 4; index += 1) {
        const member = batch * 4 + index + 4;
        await conversationService.admitSettledTurn(turnInput(member, {
          conversationId: "discovery-conversation",
          customerPhone: `+447703900${String(member).padStart(3, "0")}`,
          conversationType: "PRODUCT_DISCOVERY",
        }));
      }
      conversationRedis.advanceTime(60_001);
    }
    await expect(conversationService.admitSettledTurn(turnInput(12, {
      conversationId: "discovery-conversation",
      customerPhone: "+447703901012",
      conversationType: "PRODUCT_DISCOVERY",
    }))).resolves.toMatchObject({ reason: "TURN_CONVERSATION_LONG" });
  });

  it("B011-11 uses standard limits when discovery contains reply context", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    for (let index = 0; index < 5; index += 1) {
      await expect(service.admitSettledTurn(turnInput(index, { conversationType: "PRODUCT_DISCOVERY", hasReplyContext: true }))).resolves.toEqual({ kind: "allowed" });
    }
  });

  it("B011-12 enforces the shop settled-turn limit", async () => {
    const redis = new RedisLikeAdmissionHarness();
    redis.seed("arch007:wa-abuse:v1:turn:shop:shop-1:60s", 600);
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    await expect(service.admitSettledTurn(turnInput(1, { customerPhone: "+447700900001" }))).resolves.toMatchObject({ reason: "TURN_SHOP" });
  });

  it("B011-13 enforces the global settled-turn limit", async () => {
    const redis = new RedisLikeAdmissionHarness();
    redis.seed("arch007:wa-abuse:v1:turn:global:60s", 5_000);
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    await expect(service.admitSettledTurn(turnInput(1, { customerPhone: "+447700900001" }))).resolves.toMatchObject({ reason: "TURN_GLOBAL" });
  });

  it("B011-14 bounds one sender across multiple conversations", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    for (let index = 0; index < 12; index += 1) await service.admitSettledTurn(turnInput(index));
    await expect(service.admitSettledTurn(turnInput(12, { conversationId: "other-conversation" }))).resolves.toMatchObject({ reason: "TURN_SENDER_SHORT" });
  });

  it("B011-15 replays a settled member without refreshing scores", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    await service.admitSettledTurn(turnInput(1));
    const before = redis.score("turn:sender", "conversation-1:1");
    redis.advanceTime(30_000);
    await service.admitSettledTurn(turnInput(1));
    expect(redis.score("turn:sender", "conversation-1:1")).toBe(before);
  });

  it("B011-17 admits a new settled observedVersion after the short window expires", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    for (let index = 0; index < 12; index += 1) await service.admitSettledTurn(turnInput(index));
    await expect(service.admitSettledTurn(turnInput(12))).resolves.toMatchObject({
      kind: "denied",
      reason: "TURN_SENDER_SHORT",
    });
    redis.advanceTime(60_001);
    await expect(service.admitSettledTurn(turnInput(13, { conversationId: "conversation-new" }))).resolves.toEqual({ kind: "allowed" });
  });

  it("B011-19 serializes a final-slot race", async () => {
    const redis = new RedisLikeAdmissionHarness();
    redis.seed("arch007:wa-abuse:v1:raw:sender:" + phoneHash("+447700900000") + ":60s", 59);
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    const results = await Promise.all([service.admitRaw(rawInput(1)), service.admitRaw(rawInput(2))]);
    expect(results.filter((result) => result.kind === "allowed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "denied")).toHaveLength(1);
  });

  it("B011-20 mutates none of the scopes when one scope rejects", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    const input = turnInput(12, { customerPhone: "+447700900001" });
    const keys = settledScopeKeys(input);
    redis.seed(keys[2]!, 12);
    const before = redis.snapshot(keys);
    await expect(service.admitSettledTurn(input)).resolves.toMatchObject({
      kind: "denied",
      reason: "TURN_CONVERSATION_SHORT",
    });
    expect(redis.snapshot(keys)).toEqual(before);
    for (const key of keys) expect(redis.has(key, "conversation-12:12")).toBe(false);
  });

  it("B011-21a keeps immediate replay state-idempotent across all six scopes", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    const input = turnInput(1);
    const keys = settledScopeKeys(input);
    await service.admitSettledTurn(input);
    const before = redis.snapshot(keys);
    await service.admitSettledTurn(input);
    expect(redis.snapshot(keys)).toEqual(before);
  });

  it("B011-21b does not re-add a mixed-window replay to expired short scopes", async () => {
    const redis = new RedisLikeAdmissionHarness();
    const service = new InboundWhatsAppAbuseAdmissionService(redis, logger());
    const input = turnInput(1);
    const keys = settledScopeKeys(input);
    const member = "conversation-1:1";
    await service.admitSettledTurn(input);
    const before = redis.snapshot(keys);
    const senderLongScore = before[keys[1]!]!.find(([value]) => value === member)?.[1];
    const conversationLongScore = before[keys[3]!]!.find(([value]) => value === member)?.[1];
    redis.advanceTime(60_001);
    await expect(service.admitSettledTurn(input)).resolves.toEqual({ kind: "allowed" });
    expect(redis.has(keys[0]!, member)).toBe(false);
    expect(redis.has(keys[2]!, member)).toBe(false);
    expect(redis.has(keys[4]!, member)).toBe(false);
    expect(redis.has(keys[5]!, member)).toBe(false);
    expect(redis.score(keys[1]!, member)).toBe(senderLongScore);
    expect(redis.score(keys[3]!, member)).toBe(conversationLongScore);
  });
});
