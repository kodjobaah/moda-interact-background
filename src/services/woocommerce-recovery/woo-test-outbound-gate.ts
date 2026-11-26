/** Preserve the existing local-emulator-only outbound policy. */
export function wooTestOutboundEnabled(): boolean {
  if (process.env.NODE_ENV !== "test" || process.env.MODA_WOO_TEST_OUTBOUND !== "1") return false;
  try {
    const target = new URL(process.env.WHATSAPP_API_BASE_URL ?? "");
    return target.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]", "host.docker.internal"].includes(target.hostname);
  } catch {
    return false;
  }
}
