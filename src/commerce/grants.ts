import { assertPublishedManifest } from "./published-tools.js";
import { satisfies } from "semver";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  CommerceConversationGrantSchema,
  manifestMatchesGrant,
  canonicalJson,
  verifyResponseContract,
  isBuiltInTool,
} from "@modainteract/moda-interact-shared/commerce";
import type {
  CommerceManifest,
  CommerceTurnIdentity,
} from "@modainteract/moda-interact-shared/commerce";
import { runnerVersion } from "@modainteract/moda-interact-shared/commerce/runner";
import prisma from "../lib/db.js";
import { CommerceHostError } from "./mcp-client.js";

export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function wireGrant(
  row: NonNullable<
    Awaited<ReturnType<typeof prisma.commerceConversationGrant.findUnique>>
  >,
) {
  return CommerceConversationGrantSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  });
}
export async function readGrant(turn: CommerceTurnIdentity) {
  const row = await prisma.commerceConversationGrant.findUnique({
    where: { conversationId: turn.conversationId },
  });
  if (!row) return null;
  const grant = wireGrant(row);
  if (grant.grantedTools.some(isBuiltInTool)) throw new CommerceHostError("INCOMPATIBLE_VERSION");
  if (
    grant.shopId !== turn.shopId ||
    grant.initialInboundVersion > turn.inboundVersion ||
    grant.runnerVersion !== runnerVersion ||
    (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
  )
    throw new CommerceHostError("DENIED");
  return grant;
}
export async function validateRelease(manifest: CommerceManifest) {
  assertPublishedManifest(manifest);
  if (!satisfies(runnerVersion, manifest.runnerCompatibility))
    throw new CommerceHostError("INCOMPATIBLE_VERSION");
  if (
    !verifyResponseContract(
      manifest.responseContract,
      manifest.responseContractHash,
      digest,
    )
  )
    throw new CommerceHostError("INCOMPATIBLE_VERSION");
  const release = await prisma.commerceRelease.findUnique({
    where: { id: manifest.releaseId },
    select: {
      responseContract: true,
      responseContractHash: true,
      runnerCompatibility: true,
      contractVersion: true,
      capabilities: { select: { capabilityId: true, featureId: true, toolId: true, toolRevisionId: true,
        capability: { select: { key: true } },
        toolRevision: { select: { status: true, definitionVersion: true, definition: true } } } },
    },
  });
  if (
    !release ||
    release.contractVersion !== manifest.contractVersion ||
    release.runnerCompatibility !== manifest.runnerCompatibility ||
    release.responseContractHash !== manifest.responseContractHash ||
    canonicalJson(release.responseContract) !==
      canonicalJson(manifest.responseContract)
  )
    throw new CommerceHostError("INCOMPATIBLE_VERSION");
  for (const member of manifest.capabilities) {
    const stored = release.capabilities.find(candidate => candidate.capabilityId === member.capabilityId);
    const definition = stored?.toolRevision.definition;
    if (!stored || stored.featureId !== member.featureId || stored.capability.key !== member.key ||
        stored.toolId !== member.toolDescriptor.toolId || stored.toolRevisionId !== member.toolDescriptor.toolRevisionId ||
        stored.toolRevision.status !== "PUBLISHED" || stored.toolRevision.definitionVersion !== member.toolDescriptor.definitionVersion ||
        !definition || typeof definition !== "object" || Array.isArray(definition) ||
        canonicalJson({ toolId: stored.toolId, toolRevisionId: stored.toolRevisionId,
          name: definition.name, description: definition.description, inputSchema: definition.inputSchema,
          definitionVersion: definition.definitionVersion }) !== canonicalJson(member.toolDescriptor)) {
      throw new CommerceHostError("INCOMPATIBLE_VERSION");
    }
  }
}
export async function persistGrant(
  turn: CommerceTurnIdentity,
  manifest: CommerceManifest,
) {
  await validateRelease(manifest);
  try {
    return wireGrant(
      await prisma.commerceConversationGrant.create({
        data: {
          shopId: turn.shopId,
          conversationId: turn.conversationId,
          initialInboundVersion: turn.inboundVersion,
          releaseId: manifest.releaseId,
          selectedCapabilityKeys: manifest.selectedCapabilityKeys,
          grantedTools: manifest.grantedTools,
          runnerVersion,
        },
      }),
    );
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    )
      throw error;
    const winner = await readGrant(turn);
    if (!winner) throw new CommerceHostError("UNAVAILABLE", true);
    return winner;
  }
}
export { manifestMatchesGrant };
