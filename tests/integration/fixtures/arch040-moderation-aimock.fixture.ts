import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LLMock } from "@copilotkit/aimock";
import { openAiModerateText } from "../../../src/services/conversation-moderation/moderation-client.js";
import type { ModerationOperation } from "../../../src/services/conversation-moderation/moderation-operation.js";

type ModerationRequest = {
  path: string;
  input: unknown;
  model: unknown;
  status: number;
  forwardedToAimock: boolean;
};
type HttpFault = { status: number; body: unknown };

/**
 * BG006 uses B002's pinned Aimock implementation for actual moderation HTTP
 * responses. Aimock v1.45.1 deliberately journals moderation requests with
 * `body: null` and does not apply its generic one-shot error control to the
 * dedicated moderation handler. This narrow loopback HTTP relay observes the
 * *real SDK request bytes* and supplies one-shot HTTP fault responses only.
 * All ordinary moderation requests are forwarded unmodified to Aimock.
 */
export async function startArch040ModerationAimock(options: { blockedTexts?: string[] } = {}) {
  const mock = new LLMock({ port: 0 });
  for (const text of ["moderation-fixture-block", ...(options.blockedTexts ?? [])]) {
    mock.onModerate(text, {
      flagged: true,
      categories: { harassment: true },
      category_scores: { harassment: 0.99 },
    });
  }
  mock.onModerate(/.*/, {
    flagged: false,
    categories: { harassment: false },
    category_scores: { harassment: 0.01 },
  });
  await mock.start();

  const upstream = new URL(mock.url);
  if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)) {
    await mock.stop();
    throw new Error("ARCH-040 moderation Aimock must bind loopback");
  }

  const requests: ModerationRequest[] = [];
  let nextFault: HttpFault | null = null;
  const relay = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url !== "/v1/moderations" || req.method !== "POST") {
      send(404, { error: { message: "Unknown BG006 mock route" } });
      return;
    }
    try {
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += part.length;
        if (bytes > 64 * 1024) {
          send(413, { error: { message: "BG006 test request too large" } });
          return;
        }
        parts.push(part);
      }
      const raw = Buffer.concat(parts).toString("utf8");
      const body = JSON.parse(raw) as { input?: unknown; model?: unknown };
      const fault = nextFault;
      nextFault = null;
      if (fault) {
        requests.push({ path: req.url, input: body.input, model: body.model,
          status: fault.status, forwardedToAimock: false });
        send(fault.status, fault.body);
        return;
      }
      // This is a real HTTP request into the SAME Aimock instance that owns
      // onModerate() fixtures; no Vitest function replaces the SDK/provider.
      const response = await fetch(`${mock.url}/v1/moderations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
        signal: AbortSignal.timeout(8_000),
      });
      const responseBody = await response.text();
      requests.push({ path: req.url, input: body.input, model: body.model,
        status: response.status, forwardedToAimock: true });
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json",
      });
      res.end(responseBody);
    } catch {
      send(502, { error: { message: "BG006 test relay unavailable", type: "test_relay_error" } });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", () => {
        relay.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await mock.stop();
    throw error;
  }
  const address = relay.address() as AddressInfo | null;
  if (!address) {
    relay.close();
    await mock.stop();
    throw new Error("ARCH-040 moderation HTTP relay failed to bind");
  }

  // The real SDK receives one purpose-scoped configuration snapshot, not
  // global OPENAI_BASE_URL / OPENAI_API_KEY mutations. The endpoint is the
  // full /moderations URL, matching the ARCH-043 database contract.
  const endpoint = `http://127.0.0.1:${address.port}/v1/moderations`;
  const operation: ModerationOperation = {
    moderation: { key: "omini.moderation", version: 1,
      value: { baseUrl: endpoint, modelId: "omni-moderation-latest" } },
    providerVersion: 1, openAiApiKey: "arch040-local-aimock-only",
  };
  const closeRelay = async () => {
    relay.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      relay.close((error) => error ? reject(error) : resolve());
    });
  };
  return {
    moderate: openAiModerateText,
    readOperation: async (): Promise<ModerationOperation> => operation,
    modelId: operation.moderation.value.modelId,
    journal() {
      // Verify that ordinary requests actually crossed Aimock's moderation
      // HTTP boundary. The request fields are taken from relay-observed SDK
      // bytes, not synthesized from expected test input.
      const forwarded = requests.filter((item) => item.forwardedToAimock);
      const handled = mock.getRequests().filter((item) =>
        item.service === "moderation" || item.path.startsWith("/v1/moderations"));
      if (handled.length !== forwarded.length) {
        throw new Error("ARCH-040 moderation Aimock HTTP forwarding evidence mismatch");
      }
      return requests.map(({ path, input, model, status }) => ({ path, input, model, status }));
    },
    async failNextWith(status: number, body: unknown) {
      if (!Number.isInteger(status) || status < 200 || status > 599 || nextFault) {
        throw new Error("Invalid or overlapping ARCH-040 moderation HTTP fault");
      }
      nextFault = { status, body };
    },
    async close() {
      try { await closeRelay(); }
      finally {
        await mock.stop();
      }
    },
  };
}
