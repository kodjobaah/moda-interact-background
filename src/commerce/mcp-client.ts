import { observeCommerceTool } from "./observe-tool.js";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CommerceAssertionSchema,
  CommerceManifestSchema,
  CommerceToolResultSchema,
} from "@modainteract/moda-interact-shared/commerce";
import type {
  CommerceConversationGrant,
  CommerceTurnIdentity,
} from "@modainteract/moda-interact-shared/commerce";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

export class CommerceHostError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(`Commerce host: ${code}`);
  }
}
export type McpConfiguration = {
  endpoint: URL;
  keyId: string;
  privateKey: string;
  environment: string;
};
export function mcpConfiguration(): McpConfiguration {
  const endpoint = new URL(
    process.env.COMMERCE_MCP_URL ?? "http://invalid.invalid",
  );
  const keyId = process.env.COMMERCE_ASSERTION_KEY_ID;
  const privateKey = process.env.COMMERCE_ASSERTION_PRIVATE_KEY;
  if (
    !keyId ||
    !privateKey ||
    endpoint.pathname !== "/api/mcp" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["http:", "https:"].includes(endpoint.protocol)
  )
    throw new CommerceHostError("CONFIGURATION");
  return {
    endpoint,
    keyId,
    privateKey,
    environment: resolveDeploymentEnvironmentName(),
  };
}
export function signCommerceAssertion(
  config: McpConfiguration,
  turn: CommerceTurnIdentity,
  grant?: CommerceConversationGrant,
): string {
  const authority = CommerceAssertionSchema.parse(
    grant
      ? {
          ...turn,
          purpose: "execute",
          grantId: grant.id,
          releaseId: grant.releaseId,
        }
      : { ...turn, purpose: "resolve" },
  );
  const iat = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT", kid: config.keyId })}.${encode({ ...authority, iss: "moda-background", sub: "moda-messaging-worker", aud: "moda-commerce", environment: config.environment, iat, exp: iat + 120, jti: randomUUID() })}`;
  const key = createPrivateKey(config.privateKey);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw new CommerceHostError("CONFIGURATION");
  return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), key).toString("base64url")}`;
}

export class CommerceMcpClient {
  private client = new Client({ name: "moda-background", version: "1.0.0" });
  constructor(
    private config: McpConfiguration,
    private turn: CommerceTurnIdentity,
    private signal: AbortSignal,
    private grant?: CommerceConversationGrant,
  ) {}
  private options(signal = this.signal) {
    return { signal, timeout: 10_000 };
  }
  async connect() {
    const transport = new StreamableHTTPClientTransport(this.config.endpoint, {
      fetch: async (url, init) => {
        this.signal.throwIfAborted();
        if (
          String(url) !== this.config.endpoint.href ||
          (init?.method ?? "GET") !== "POST"
        )
          throw new CommerceHostError("INVALID_INPUT");
        if (
          typeof init?.body === "string" &&
          Buffer.byteLength(init.body) > 128 * 1024
        )
          throw new CommerceHostError("INVALID_INPUT");
        const headers = new Headers(init?.headers);
        headers.set(
          "Authorization",
          `Bearer ${signCommerceAssertion(this.config, this.turn, this.grant)}`,
        );
        const response = await fetch(url, {
          ...init,
          headers,
          redirect: "error",
          signal: AbortSignal.any([
            this.signal,
            AbortSignal.timeout(10_000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        if (response.status === 401 || response.status === 403)
          throw new CommerceHostError("DENIED");
        if (response.headers.has("mcp-session-id"))
          throw new CommerceHostError("INCOMPATIBLE_VERSION");
        if (!response.ok) throw new CommerceHostError("UNAVAILABLE", true);
        if (!response.body) return response;
        if (
          response.status !== 202 &&
          !response.headers.get("content-type")?.includes("application/json")
        )
          throw new CommerceHostError("INVALID_INPUT");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 256 * 1024) throw new CommerceHostError("INVALID_INPUT");
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        return new Response(Buffer.concat(chunks), {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    // SDK 1.30.0 declares sessionId as string | undefined rather than optional;
    // its runtime Transport implementation is compatible (covered over HTTP).
    await this.client.connect(transport as Transport, this.options());
  }
  async manifest() {
    const result = await this.client.readResource(
      { uri: "commerce://capabilities" },
      this.options(),
    );
    if (
      result.contents.length !== 1 ||
      result.contents[0]!.uri !== "commerce://capabilities" ||
      !("text" in result.contents[0]!)
    )
      throw new CommerceHostError("INCOMPATIBLE_VERSION");
    const parsed = CommerceManifestSchema.safeParse(
      JSON.parse(result.contents[0]!.text as string),
    );
    if (!parsed.success) throw new CommerceHostError("INCOMPATIBLE_VERSION");
    return parsed.data;
  }
  async prompt(name: string) {
    const result = await this.client.getPrompt(
      { name, arguments: {} },
      this.options(),
    );
    if (result.messages.some((m) => m.content.type !== "text"))
      throw new CommerceHostError("INVALID_INPUT");
    return {
      name,
      text: result.messages
        .map((m) => (m.content.type === "text" ? m.content.text : ""))
        .join("\n"),
    };
  }
  async tools(signal = this.signal) {
    const result = await this.client.listTools({}, this.options(signal));
    if (
      result.nextCursor ||
      result.tools.length > 32 ||
      result.tools.some((t) =>
        Object.keys(t).some(
          (k) => !["name", "description", "inputSchema"].includes(k),
        ),
      )
    )
      throw new CommerceHostError("INVALID_INPUT");
    return result.tools;
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal = this.signal,
  ) {
    return observeCommerceTool(async () => {
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        this.options(signal),
      );
      const value = CommerceToolResultSchema.parse(result.structuredContent);
      if ((value.status === "ERROR") !== Boolean(result.isError))
        throw new CommerceHostError("INVALID_INPUT");
      return value;
    });
  }
  async close() {
    await this.client.close();
  }
}
