import { vi } from "vitest";
import { WhatsAppService } from "../../../src/services/whatsapp.service.js";
import type { SendTemplateInput, SendTextInput } from "../../../src/integration/whatsapp/types.js";
import { Arch040Aimock } from "./arch040-aimock.fixture.js";
import { Arch040WhatsAppEmulator } from "./arch040-whatsapp-emulator.fixture.js";

/**
 * Background-owned integration harness. Uses the same pinned Aimock container
 * and @whatsapp-cloudapi/emulator package as system-test, but does not import
 * files or dependencies from the system-test repository.
 *
 * All provider traffic must terminate at this disposable loopback emulator.
 */
export async function startArch040BackgroundMocks() {
  const whatsapp = new Arch040WhatsAppEmulator();
  await whatsapp.start();
  const values = { ...whatsapp.environment, WHATSAPP_BUSINESS_ACCOUNT_ID: "arch040-test-business-account" };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  type Fault = "timeout" | "provider-rejected";
  let nextFault: Fault | null = null;
  let hold: { entered: () => void; released: Promise<void> } | null = null;
  const requests: Array<{ type: string }> = [];
  const expectedEndpoint = `${whatsapp.apiBaseUrl}/${whatsapp.phoneNumberId}/messages`;
  const protectedFetch: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url !== expectedEndpoint || init?.method !== "POST") {
      throw new Error("ARCH-040 mock boundary refused an external WhatsApp request");
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) as { type?: string } : {};
    requests.push({ type: body.type ?? "unknown" });
    const pendingHold = hold;
    if (pendingHold) {
      hold = null;
      pendingHold.entered();
      await pendingHold.released;
    }
    const fault = nextFault;
    nextFault = null;
    if (fault === "timeout") throw new Error("mock WhatsApp transport timeout (provider outcome unknown)");
    if (fault === "provider-rejected") {
      return new Response(JSON.stringify({ error: { message: "verified provider rejection" } }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    return fetch(input, init);
  };
  const realProvider = new WhatsAppService(protectedFetch);
  const provider = {
    sendWhatsAppText: vi.fn((input: SendTextInput) => realProvider.sendWhatsAppText(input)),
    sendWhatsAppTemplate: vi.fn((input: SendTemplateInput) => realProvider.sendWhatsAppTemplate(input)),
    getProviderAccountId: () => "arch040-test-business-account",
  };

  let aimock: Arch040Aimock | null = null;
  return {
    provider, whatsapp, requests,
    failNextHttp(fault: Fault) { nextFault = fault; },
    holdNextHttp() {
      if (hold) throw new Error("WhatsApp HTTP request is already held");
      let onEntered!: () => void;
      let onRelease!: () => void;
      const entered = new Promise<void>((resolve) => { onEntered = resolve; });
      const released = new Promise<void>((resolve) => { onRelease = resolve; });
      hold = { entered: onEntered, released };
      return { entered, release: onRelease };
    },
    async startAimock() {
      if (aimock) return aimock;
      const instance = new Arch040Aimock();
      await instance.start();
      aimock = instance;
      return instance;
    },
    async close() {
      try {
        if (aimock) await aimock.stop();
      } finally {
        try {
          await whatsapp.cleanup();
        } finally {
          for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      }
    },
  };
}
