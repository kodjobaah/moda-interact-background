import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

type EmulatorRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getServer(): Server;
};

type OutboundMessage = {
  statusCode: number;
  body: {
    type?: string;
    to?: string;
    text?: { body?: string };
    template?: {
      name?: string;
      language?: { code?: string };
      components?: Array<{
        type?: string;
        sub_type?: string;
        index?: string;
        parameters?: Array<{ type?: string; text?: string }>;
      }>;
    };
  };
};

/**
 * Background-local adapter to @whatsapp-cloudapi/emulator@5.0.1, the same
 * emulator version used by moda-interact-system-test. No checkout imports or
 * runtime dependency on system-test are permitted.
 */
export class Arch040WhatsAppEmulator {
  readonly phoneNumberId = "15550123456";
  readonly messages: OutboundMessage[] = [];
  private readonly host = "127.0.0.1";
  private readonly apiVersion = "v25.0";
  private callbackServer: Server | null = null;
  private emulator: EmulatorRuntime | null = null;
  private port: number | null = null;
  private observer: ((request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void) | null = null;

  get baseUrl(): string {
    if (this.port === null) throw new Error("ARCH-040 WhatsApp emulator is not running");
    return `http://${this.host}:${this.port}`;
  }

  get apiBaseUrl(): string {
    return `${this.baseUrl}/${this.apiVersion}`;
  }

  get environment(): Record<string, string> {
    return {
      WHATSAPP_API_BASE_URL: this.apiBaseUrl,
      WHATSAPP_PHONE_NUMBER_ID: this.phoneNumberId,
      WHATSAPP_ACCESS_TOKEN: "arch040-test-access-token",
    };
  }

  async start(): Promise<void> {
    if (this.emulator) throw new Error("ARCH-040 WhatsApp emulator already started");
    this.callbackServer = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/webhook") {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.callbackServer!.once("error", reject);
        this.callbackServer!.listen(0, this.host, resolve);
      });
      const callbackAddress = this.callbackServer.address();
      if (!callbackAddress || typeof callbackAddress === "string") throw new Error("Webhook callback did not bind");

      const { WhatsAppEmulator } = await import("@whatsapp-cloudapi/emulator");
      this.emulator = new WhatsAppEmulator({
        businessPhoneNumberId: this.phoneNumberId,
        host: this.host,
        port: 0,
        webhook: {
          url: `http://${this.host}:${callbackAddress.port}/webhook`,
          verifyToken: "arch040-test-verify-token",
          appSecret: "arch040-test-app-secret",
          timeout: 2_000,
          duplicates: 0,
        },
        log: { level: "quiet" },
      });
      await this.emulator.start();
      // The emulator's start() can resolve before its underlying HTTP server
      // finishes listening. Mirror the bounded readiness check used by the
      // system-test WhatsApp fixture instead of assuming address() is ready.
      const address = await this.waitForBoundAddress();
      this.port = address.port;
      this.observeOutboundRequests();
      const response = await fetch(`${this.baseUrl}/debug/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`WhatsApp emulator health returned ${response.status}`);
    } catch (error) {
      await this.cleanup().catch(() => {});
      throw error;
    }
  }

  private async waitForBoundAddress(): Promise<{ port: number }> {
    const timeoutMs = 5_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const address = this.emulator?.getServer().address();
      if (address && typeof address !== "string") return address;
      await delay(10);
    }
    throw new Error(`WhatsApp emulator did not expose a bound port within ${timeoutMs}ms`);
  }

  private observeOutboundRequests(): void {
    const server = this.emulator!.getServer();
    const expectedPath = `/${this.apiVersion}/${this.phoneNumberId}/messages`;
    this.observer = (request, response) => {
      if (request.method !== "POST" || request.url?.split("?")[0] !== expectedPath) return;
      const chunks: Buffer[] = [];
      let body: OutboundMessage["body"] | null = null;
      let bodyReady = false;
      let responseFinished = false;
      const record = () => {
        if (!bodyReady || !responseFinished || !body) return;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          this.messages.push({ statusCode: response.statusCode, body });
        }
        body = null;
      };
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.once("end", () => {
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OutboundMessage["body"]; }
        catch { body = null; }
        bodyReady = true;
        record();
      });
      response.once("finish", () => { responseFinished = true; record(); });
    };
    server.on("request", this.observer);
  }

  async waitForMessageCount(count: number): Promise<OutboundMessage[]> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (this.messages.length >= count) return this.messages.slice();
      await delay(25);
    }
    throw new Error(`Expected ${count} WhatsApp messages; received ${this.messages.length}`);
  }

  async assertNoAdditionalMessages({ count = this.messages.length, quietMs = 750 }: {
    count?: number; quietMs?: number;
  } = {}): Promise<void> {
    await delay(quietMs);
    if (this.messages.length !== count) {
      throw new Error(`Expected ${count} WhatsApp messages; received ${this.messages.length}`);
    }
  }

  async cleanup(): Promise<void> {
    const emulator = this.emulator;
    this.emulator = null;
    this.port = null;
    try {
      if (emulator) {
        const server = emulator.getServer();
        if (this.observer) server.off("request", this.observer);
        // The emulator's stop() calls Server.close(), which raises
        // ERR_SERVER_NOT_RUNNING if startup failed before listen completed.
        if (server.listening) await emulator.stop();
      }
    } finally {
      this.observer = null;
      const callback = this.callbackServer;
      this.callbackServer = null;
      if (callback) await new Promise<void>((resolve, reject) => {
        callback.close((error) => error ? reject(error) : resolve());
      });
    }
  }
}
