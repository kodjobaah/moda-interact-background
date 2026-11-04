import type { PrismaClient } from "@prisma/client";

export type Arch056Barrier = {
  promise: Promise<void>;
  release: () => void;
};

export function createArch056Barrier(): Arch056Barrier {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function withArch056Timeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function waitForArch056LockWait(
  prisma: PrismaClient,
  backendPid: number,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ wait_event_type: string | null }>>`
      SELECT "wait_event_type"
      FROM pg_stat_activity
      WHERE pid = ${backendPid}`;
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} did not enter a PostgreSQL lock wait`);
}

export type Arch056TransactionHooks = {
  beforeParentLock?: (tx: any) => Promise<void>;
  afterPendingUpdate?: () => Promise<void>;
  beforeMessageInsert?: () => Promise<void>;
};

export function interceptArch056Transaction(
  tx: any,
  hooks: Arch056TransactionHooks,
): any {
  let parentLockObserved = false;
  let pendingUpdateObserved = false;
  const conversation = new Proxy(tx.conversation, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "update" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        if (!pendingUpdateObserved) {
          pendingUpdateObserved = true;
          await hooks.afterPendingUpdate?.();
        }
        return result;
      };
    },
  });
  const conversationMessage = new Proxy(tx.conversationMessage, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "create" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        await hooks.beforeMessageInsert?.();
        return value.apply(target, args);
      };
    },
  });

  return new Proxy(tx, {
    get(target, key) {
      if (key === "conversation") return conversation;
      if (key === "conversationMessage") return conversationMessage;
      const value = Reflect.get(target, key, target);
      if (key !== "$queryRaw" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        if (!parentLockObserved) {
          parentLockObserved = true;
          await hooks.beforeParentLock?.(target);
        }
        return value.apply(target, args);
      };
    },
  });
}

export function patchArch056Transaction(
  prisma: PrismaClient,
  hooksForTransaction: (index: number) => Arch056TransactionHooks,
): () => void {
  const client = prisma as PrismaClient & {
    $transaction: PrismaClient["$transaction"];
  };
  const original = client.$transaction.bind(prisma);
  let index = 0;
  client.$transaction = ((callback: any, options?: any) => {
    const transactionIndex = index++;
    return original(
      (tx: any) => callback(interceptArch056Transaction(
        tx,
        hooksForTransaction(transactionIndex),
      )),
      { ...options, timeout: options?.timeout ?? 30_000 },
    );
  }) as PrismaClient["$transaction"];
  return () => {
    client.$transaction = original as PrismaClient["$transaction"];
  };
}
