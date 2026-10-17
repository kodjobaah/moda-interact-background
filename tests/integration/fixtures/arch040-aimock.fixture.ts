import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IMAGE = "ghcr.io/copilotkit/aimock:1.45.1";
const CONTAINER_PORT = 4010;
const FIXTURE_FILE = "arch040-background-002.json";

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate Aimock port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/** Launch the same pinned/strict Aimock container as system-test, but mount the
 * fixture owned by Background. Only Docker (already required for disposable
 * PostgreSQL/Redis), not another npm installation or repository, is needed.
 */
export class Arch040Aimock {
  private containerName: string | null = null;
  private baseUrl: string | null = null;

  snapshot(): { openRouterBaseUrl: string | null } {
    return { openRouterBaseUrl: this.baseUrl ? `${this.baseUrl}/api/v1` : null };
  }

  async start(): Promise<void> {
    if (this.containerName) throw new Error("ARCH-040 Aimock already started");
    const port = await unusedLoopbackPort();
    const name = `moda-arch040-background-${randomUUID()}`;
    const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "aimock");
    this.containerName = name;
    try {
      await execFileAsync("docker", [
        "run", "--detach", "--rm", "--name", name,
        "--publish", `127.0.0.1:${port}:${CONTAINER_PORT}`,
        "--volume", `${fixtureDirectory}:/fixtures:ro`,
        IMAGE, "-p", String(CONTAINER_PORT), "-f", `/fixtures/${FIXTURE_FILE}`,
        "-h", "0.0.0.0", "--strict",
      ], { timeout: 45_000, maxBuffer: 8 * 1024 });
      this.baseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${this.baseUrl}/ready`, { signal: AbortSignal.timeout(1_000) });
          if (response.ok) return;
        } catch { /* container may still be starting */ }
        await delay(100);
      }
      throw new Error(`ARCH-040 Aimock ${IMAGE} did not become ready`);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async journalSummary(): Promise<{
    requestCount: number; matchedCount: number; models: string[]; toolNames: string[];
  }> {
    if (!this.baseUrl) throw new Error("ARCH-040 Aimock is not running");
    const response = await fetch(`${this.baseUrl}/__aimock/journal?path=/api/v1/chat/completions`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`ARCH-040 Aimock journal returned ${response.status}`);
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new Error("ARCH-040 Aimock journal is not an array");
    type JournalEntry = {
      path?: string;
      body?: { model?: string; tools?: Array<{ function?: { name?: string } }> };
      response?: { status?: number; fixture?: unknown };
    };
    const chats = (value as JournalEntry[]).filter((entry) => entry.path?.includes("/api/v1/chat/completions"));
    return {
      requestCount: chats.length,
      matchedCount: chats.filter((entry) => entry.response?.status === 200 && entry.response.fixture).length,
      models: [...new Set(chats.map((entry) => entry.body?.model).filter((model): model is string => typeof model === "string"))],
      toolNames: [...new Set(chats.flatMap((entry) => (entry.body?.tools ?? []).map((tool) => tool.function?.name))
        .filter((name): name is string => typeof name === "string"))],
    };
  }

  async stop(): Promise<void> {
    const name = this.containerName;
    this.containerName = null;
    this.baseUrl = null;
    if (!name) return;
    await execFileAsync("docker", ["rm", "--force", name], { timeout: 15_000, maxBuffer: 8 * 1024 })
      .catch(() => {});
  }
}
