import { Prisma, type PrismaClient } from "@prisma/client";

/** Exercise actual PostgreSQL commits/rollbacks while deterministically
 * simulating Prisma's reported P2028 at the transaction boundary. Never
 * inject a failure into a provider call or a provider admission transaction. */
export function withOneRecoveryTransactionFault(
  db: PrismaClient,
  fault: "rollback" | "lost-ack",
) {
  const error = new Prisma.PrismaClientKnownRequestError(
    "Transaction API error: Transaction not found.",
    {
      code: "P2028",
      clientVersion: Prisma.prismaVersion.client,
    },
  );
  let calls = 0;
  let injected = false;
  type Options = {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  };
  const database = new Proxy(db, {
    get(target, key) {
      if (key === "$transaction")
        return async <T>(
          work: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: Options,
        ): Promise<T> => {
          calls++;
          if (injected) return target.$transaction(work, options);
          // Do not mask a real failing transaction with the injected fault.
          if (fault === "rollback")
            return target.$transaction(async (tx) => {
              await work(tx);
              injected = true;
              throw error;
            }, options);
          await target.$transaction(work, options);
          injected = true;
          throw error;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, calls: () => calls, injected: () => injected };
}
