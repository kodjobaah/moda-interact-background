/** One bounded provider/model operation. The signal is also passed to the
 * adapter to cancel outgoing read-only I/O. Timer cleanup is mandatory. */
export class RecoveryOfferTimeout extends Error {
  constructor() {
    super("recovery_offer_timeout");
    this.name = "RecoveryOfferTimeout";
  }
}

export async function withinOfferDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>, durationMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RecoveryOfferTimeout());
    }, durationMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
