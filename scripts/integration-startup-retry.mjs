/**
 * A bounded retry for the one disposable-PostgreSQL startup timeout observed
 * during ARCH-046-BG004 validation. Container lifecycle, migration and teardown
 * remain owned by @modainteract/moda-interact-shared/testing/node.
 *
 * A test failure (non-zero Vitest exit code) is a returned result, not a
 * startup exception; it must never cause the suite to be run again.
 */
export function isDisposablePostgresReadinessTimeout(error) {
  return error instanceof Error &&
    error.message.startsWith("Unable to start ephemeral PostgreSQL (") &&
    error.message.includes("PostgreSQL readiness timed out after ");
}

const defaultDelay = () => new Promise((resolve) => setTimeout(resolve, 2_000));

/**
 * Retry exactly once, only when Shared's PostgreSQL startup readiness timed
 * out. On a second timeout, preserve both underlying errors for diagnosis.
 * Every caught exception is logged with bounded metadata, never raw URLs or
 * database credentials.
 *
 * @template T
 * @param {() => Promise<T>} run
 * @param {{ warn: (event: string, data: object) => void, error: (event: string, data: object) => void }} logger
 * @param {() => Promise<void>} [delay]
 * @returns {Promise<T>}
 */
export async function runWithPostgresStartupRetry(run, logger, delay = defaultDelay) {
  let firstError;
  try {
    return await run();
  } catch (error) {
    if (!isDisposablePostgresReadinessTimeout(error)) {
      logger.error("background.integration.infrastructure.failed", {
        stage: "first-attempt", errorKind: "unexpected", errorName: safeErrorName(error),
      });
      throw error;
    }
    firstError = error;
    logger.warn("background.integration.postgres_startup.retry", {
      attempt: 1, maxAttempts: 2, errorKind: "postgres-readiness-timeout",
    });
  }

  // Never use a retry for a failed Vitest run: Shared returns that as an exit
  // result. The retry applies only before test execution has begun.
  await delay();
  try {
    return await run();
  } catch (error) {
    const repeated = isDisposablePostgresReadinessTimeout(error);
    logger.error("background.integration.infrastructure.failed", {
      stage: "second-attempt",
      errorKind: repeated ? "postgres-readiness-timeout" : "unexpected",
      errorName: safeErrorName(error),
    });
    if (repeated) {
      throw new AggregateError(
        [firstError, error], "Disposable PostgreSQL readiness failed on both attempts",
        { cause: error },
      );
    }
    throw error;
  }
}

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : undefined;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)
    ? name : "UnknownError";
}
