import type {
  Prisma,
  PrismaClient,
  RecoveryBasketRoutingTurn,
} from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { sourceFailureFields } from "../../commerce/production-model.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import {
  readPreparedWrapper,
  digest,
  stableJson,
} from "../conversation-wrappers/projection.js";
import { renderPreparedWrapper } from "../conversation-wrappers/render.js";
import { customerWindow } from "../recovery-conversation/recovery-follow-up-policy.service.js";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";
import { lockWhatsAppStopRecipient } from "../whatsapp-contact-opt-out/recipient-stop-serialization.js";
import { canonicalWhatsAppSender } from "../whatsapp-contact-opt-out/phone.js";
import { lockRecoverySenderRecipient } from "./recipient-lock.js";
import {
  lockInboundProviderIdentity,
  recipientDigits,
} from "./inbound-authority.js";
import type { DispatchSenderSnapshot } from "./dispatch-sender.js";
import { whatsAppService } from "../whatsapp.service.js";

export type PreparedRoutingPrompt = Readonly<{
  definitionId: string;
  localeId: string;
  languageTag: string;
  sourceHash: string;
  contentHash: string;
  slotEditVersion: number;
  preparedHash: string;
  body: string;
}>;

/** Router publication is an independent application selector, never chooseSlot.
 * No merchant, customer, checkout, media or conditional bindings can reach it. */
export async function readRoutingPrompt(
  database: Pick<PrismaClient, "whatsAppConversationWrapperActiveSlot">,
  input: { languageTag: string; responseBody: string },
): Promise<PreparedRoutingPrompt | null> {
  const slot = await database.whatsAppConversationWrapperActiveSlot.findUnique({
    where: { audience: "ROUTER" },
    include: { definition: { include: { locales: true } } },
  });
  if (
    !slot ||
    slot.audience !== "ROUTER" ||
    slot.definitionId !== slot.definition.id
  )
    return null;
  const definition = slot.definition;
  if (
    definition.kind !== "MODA_CONVERSATION_WRAPPER" ||
    definition.audience !== "ROUTER" ||
    definition.status !== "PUBLISHED" ||
    !definition.publishedAt ||
    definition.retiredAt !== null ||
    definition.sourceLanguageTag !== "en" ||
    definition.astSchemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(definition.sourceHash)
  )
    return null;
  // Caller supplies the desired locale explicitly. There is no hidden locale or
  // SHARED/AI/HUMAN fallback when that reviewed router locale is unavailable.
  const matches = definition.locales.filter(
    (locale) => locale.languageTag === input.languageTag,
  );
  if (matches.length !== 1) return null;
  const locale = matches[0]!;
  if (
    locale.providerLanguageCode !== null ||
    locale.status !==
      (input.languageTag === "en" ? "SOURCE_SAVED" : "REVIEWED") ||
    (input.languageTag !== "en" &&
      (!locale.reviewedAt || !locale.reviewedByAdminId))
  )
    return null;
  const result = readPreparedWrapper(locale.localeAst, locale.contentHash);
  if (result.kind !== "ok") return null;
  const prepared = result.prepared;
  if (
    prepared.conditionals.length ||
    Object.hasOwn(prepared, "productImage") ||
    Object.hasOwn(prepared, "compositeProfile") ||
    [...prepared.header, ...prepared.body, ...prepared.footer].some(
      (token) => token.kind === "variable",
    )
  )
    return null;
  const rendered = renderPreparedWrapper({
    prepared,
    responseBody: input.responseBody,
    // These empty renderer-only identities confer no business owner and perform
    // no tenant lookup. Neutral prepared tokens cannot dereference them.
    context: {
      conversationId: "",
      shopId: "",
      conversationLanguageTag: null,
      merchantLanguageTag: null,
      variables: {},
      checkoutAvailable: false,
    },
  });
  if (rendered.kind !== "rendered") return null;
  const evidence = {
    definitionId: definition.id,
    localeId: locale.id,
    languageTag: locale.languageTag,
    sourceHash: definition.sourceHash,
    contentHash: locale.contentHash!,
    slotEditVersion: slot.editVersion,
  };
  return {
    ...evidence,
    body: rendered.body,
    preparedHash: digest(stableJson({ ...evidence, body: rendered.body })),
  };
}

export type RoutingTemplateEvidence = Omit<PreparedRoutingPrompt, "body">;

/** SQL-only exact published ROUTER revision fence, reusable at final association. */
export async function assertCurrentRoutingTemplate(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  prompt: RoutingTemplateEvidence,
): Promise<boolean> {
  const [template] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT d.id
      FROM whatsapp."WhatsAppConversationWrapperActiveSlot" s
      JOIN whatsapp."WhatsAppTemplateDefinition" d ON d.id=s."definitionId"
      JOIN whatsapp."WhatsAppTemplateLocale" l ON l."definitionId"=d.id
      WHERE s.audience='ROUTER' AND s."editVersion"=$1 AND d.id=$2 AND d."sourceHash"=$3
        AND d.kind='MODA_CONVERSATION_WRAPPER' AND d.audience='ROUTER' AND d.status='PUBLISHED'
        AND d."retiredAt" IS NULL AND l.id=$4 AND l."contentHash"=$5 AND l."languageTag"=$6
        AND l."providerLanguageCode" IS NULL
        AND ((l."languageTag"='en' AND l.status='SOURCE_SAVED') OR
             (l.status='REVIEWED' AND l."reviewedAt" IS NOT NULL AND l."reviewedByAdminId" IS NOT NULL))
      FOR SHARE OF s,d,l`,
    prompt.slotEditVersion,
    prompt.definitionId,
    prompt.sourceHash,
    prompt.localeId,
    prompt.contentHash,
    prompt.languageTag,
  );
  return !!template;
}

export type RoutingPromptOutcome =
  | { kind: "sent"; providerMessageId: string }
  | { kind: "replay"; state: string; providerMessageId: string | null }
  | { kind: "held"; reason: string }
  | { kind: "unknown" };

type PromptDependencies = {
  provider?: Pick<typeof whatsAppService, "sendWhatsAppText">;
  noContact?: typeof hasLocalNoContact;
  logger?: Pick<StructuredLogger, "warn">;
};

export type RoutingPromptInput = {
  turnId: string;
  prompt: PreparedRoutingPrompt;
  senderSnapshot: DispatchSenderSnapshot;
  deadlineMs: number;
  moderationHash: string;
  /** SQL-only final check against the exact frozen policy/model/prompt revisions. */
  configurationCurrent: (tx: Prisma.TransactionClient) => Promise<boolean>;
  workToken?: string;
  now?: Date;
};

/** Admit once in PostgreSQL, then send outside the transaction. A crash after
 * admission and every ambiguous send is deliberately non-resendable. */
export async function sendRoutingPrompt(
  database: PrismaClient,
  input: RoutingPromptInput,
  dependencies: PromptDependencies = {},
): Promise<RoutingPromptOutcome> {
  const now = input.now ?? new Date();
  if (
    !Number.isSafeInteger(input.deadlineMs) ||
    input.deadlineMs <= 0 ||
    !/^[a-f0-9]{64}$/.test(input.moderationHash) ||
    !validPreparedEvidence(input.prompt)
  )
    return { kind: "held", reason: "invalid-prompt-evidence" };
  const admitted = await database.$transaction(async (tx) => {
    await lockInboundProviderIdentity(tx, input.turnId);
    // Read immutable pointer metadata without row locks first. Allocation and
    // release own the canonical recipient lock before route-close triggers can
    // touch pending turns; taking the turn row first would invert that order.
    const pointer = await tx.recoveryBasketRoutingTurn.findUnique({
      where: { inboundProviderMessageId: input.turnId },
      select: { threadId: true },
    });
    if (!pointer) return { kind: "held" as const, reason: "missing-turn" };
    const [identity] = await tx.$queryRawUnsafe<
      Array<{
        canonicalRecipient: string;
        providerPhoneNumberId: string;
        providerAccountId: string;
      }>
    >(
      `SELECT t."canonicalRecipient",t."providerPhoneNumberId",s."providerAccountId"
      FROM whatsapp."RecoverySenderThread" t
      JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=t."providerPhoneNumberId"
      WHERE t.id=$1 AND t."closedAt" IS NULL AND s."verifiedAt"<=$2`,
      pointer.threadId,
      now,
    );
    if (!identity)
      return { kind: "held" as const, reason: "sender-owner-changed" };
    await lockRecoverySenderRecipient(tx, identity.canonicalRecipient);
    const [turn] = await tx.$queryRawUnsafe<RecoveryBasketRoutingTurn[]>(
      `SELECT * FROM whatsapp."RecoveryBasketRoutingTurn"
      WHERE "inboundProviderMessageId"=$1 FOR UPDATE`,
      input.turnId,
    );
    if (!turn || turn.threadId !== pointer.threadId)
      return { kind: "held" as const, reason: "turn-owner-changed" };
    if (turn.promptAdmittedAt || turn.state !== "RECEIVED") {
      return {
        kind: "replay" as const,
        state: turn.state,
        providerMessageId: turn.promptProviderMessageId,
      };
    }
    if (
      turn.workToken !== (input.workToken ?? null) ||
      (turn.workLeaseUntil && turn.workLeaseUntil <= now)
    )
      return { kind: "held" as const, reason: "work-lease-changed" };
    if (turn.expiresAt <= now || !customerWindow(turn.occurredAt, now).open)
      return { kind: "held" as const, reason: "expired-window" };
    const event = turn.inputJson as Record<string, unknown> | null;
    const [thread] = await tx.$queryRawUnsafe<Array<typeof identity>>(
      `SELECT t."canonicalRecipient",t."providerPhoneNumberId",s."providerAccountId"
      FROM whatsapp."RecoverySenderThread" t JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=t."providerPhoneNumberId"
      WHERE t.id=$1 AND t."closedAt" IS NULL AND s."verifiedAt"<=$2 FOR SHARE OF t,s`,
      turn.threadId,
      now,
    );
    if (
      !thread ||
      thread.canonicalRecipient !== identity.canonicalRecipient ||
      thread.providerPhoneNumberId !== identity.providerPhoneNumberId ||
      thread.providerAccountId !== identity.providerAccountId ||
      !event ||
      event.providerMessageId !== input.turnId ||
      event.providerAccountId !== thread.providerAccountId ||
      event.providerPhoneNumberId !== thread.providerPhoneNumberId ||
      typeof event.customerPhone !== "string" ||
      recipientDigits(event.customerPhone) !== thread.canonicalRecipient ||
      input.senderSnapshot.providerAccountId !== thread.providerAccountId
    )
      return { kind: "held" as const, reason: "sender-owner-changed" };
    const canonical = canonicalWhatsAppSender(thread.canonicalRecipient);
    if (!canonical)
      return { kind: "held" as const, reason: "recipient-invalid" };
    await lockWhatsAppStopRecipient(tx, canonical);
    const [credential] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM public."PlatformConfiguration"
      WHERE id=$1 AND key='messaging.sender' AND environment=$2 AND version=$3 FOR SHARE`,
      input.senderSnapshot.rowId,
      input.senderSnapshot.environment,
      input.senderSnapshot.version,
    );
    if (!credential || !(await input.configurationCurrent(tx)))
      return { kind: "held" as const, reason: "configuration-changed" };
    const templateCurrent = await assertCurrentRoutingTemplate(
      tx,
      input.prompt,
    );
    if (
      !templateCurrent ||
      turn.moderationJson === null ||
      digest(canonicalJson(turn.moderationJson)) !== input.moderationHash
    )
      return {
        kind: "held" as const,
        reason: "template-or-moderation-changed",
      };
    const decision = turn.routingDecision as Record<string, unknown> | null;
    const expectedTemplate = {
      definitionId: input.prompt.definitionId,
      localeId: input.prompt.localeId,
      languageTag: input.prompt.languageTag,
      sourceHash: input.prompt.sourceHash,
      contentHash: input.prompt.contentHash,
      slotEditVersion: input.prompt.slotEditVersion,
      preparedHash: input.prompt.preparedHash,
    };
    if (
      !decision ||
      decision.role !== "CLARIFY" ||
      turn.candidatesJson === null ||
      turn.configurationSnapshot === null ||
      canonicalJson(decision.template ?? null) !==
        canonicalJson(expectedTemplate)
    )
      return { kind: "held" as const, reason: "template-evidence-mismatch" };
    let shopId: string | undefined;
    if (turn.routeId) {
      const [route] = await tx.$queryRawUnsafe<Array<{ shopId: string }>>(
        `SELECT "shopId" FROM whatsapp."RecoverySenderRoute"
        WHERE id=$1 AND "threadId"=$2 AND "closedAt" IS NULL FOR SHARE`,
        turn.routeId,
        turn.threadId,
      );
      if (!route) return { kind: "held" as const, reason: "route-changed" };
      shopId = route.shopId;
    }
    if (
      await (dependencies.noContact ?? hasLocalNoContact)(tx, {
        recipient: thread.canonicalRecipient,
        ...(shopId ? { shopId } : {}),
      })
    )
      return { kind: "held" as const, reason: "no-contact" };
    await tx.recoveryBasketRoutingTurn.update({
      where: { inboundProviderMessageId: input.turnId },
      data: {
        state: "PROMPT_ADMITTED",
        promptText: input.prompt.body,
        promptScopeRouteId: turn.routeId,
        promptAdmittedAt: now,
        nextRepairAt: null,
      },
    });
    return {
      kind: "admitted" as const,
      recipient: thread.canonicalRecipient,
      sender: {
        providerAccountId: thread.providerAccountId,
        providerPhoneNumberId: thread.providerPhoneNumberId,
      },
    };
  });
  if (admitted.kind !== "admitted") return admitted;
  try {
    const result = await (
      dependencies.provider ?? whatsAppService
    ).sendWhatsAppText(
      {
        to: admitted.recipient,
        text: input.prompt.body,
        expectedSender: admitted.sender,
        replyToProviderMessageId: input.turnId,
      },
      AbortSignal.timeout(input.deadlineMs),
    );
    if (!result.providerMessageId?.trim())
      throw new Error("ROUTER_PROVIDER_RECEIPT_MISSING");
    const settlement = await database.recoveryBasketRoutingTurn.updateMany({
      where: {
        inboundProviderMessageId: input.turnId,
        state: "PROMPT_ADMITTED",
        promptProviderMessageId: null,
        promptAdmittedAt: now,
      },
      data: {
        promptProviderMessageId: result.providerMessageId,
        promptSentAt: new Date(),
      },
    });
    if (settlement.count !== 1) return { kind: "unknown" };
    return { kind: "sent", providerMessageId: result.providerMessageId };
  } catch (error) {
    // Preserve the original provider/SDK or settlement error with redaction.
    // Logging never changes the durable no-resend outcome.
    try {
      (
        dependencies.logger ??
        createLogger({
          serviceName: "moda-messaging-worker",
          environment: resolveDeploymentEnvironmentName(),
        })
      ).warn("recovery.routing.prompt_dispatch_unknown", {
        routingTurnId: input.turnId,
        stage: "provider_or_receipt_settlement",
        ...sourceFailureFields(
          error,
          "whatsapp",
          "ROUTER_PROMPT_DISPATCH_UNKNOWN",
          [input.prompt.body],
          "sdk_exception",
        ),
        operation: "routing.prompt.dispatch",
      });
    } catch {
      /* Diagnostic sink failure must not retry an uncertain dispatch. */
    }
    // Includes failure persisting a successful receipt. The durable permit is
    // never erased, even when a network timeout makes the result unknowable.
    await database.recoveryBasketRoutingTurn.updateMany({
      where: {
        inboundProviderMessageId: input.turnId,
        state: "PROMPT_ADMITTED",
        promptProviderMessageId: null,
      },
      data: { state: "PROMPT_UNKNOWN", nextRepairAt: null },
    });
    return { kind: "unknown" };
  }
}

function validPreparedEvidence(prompt: PreparedRoutingPrompt): boolean {
  const { preparedHash, body, ...evidence } = prompt;
  return (
    !!body.trim() &&
    body.length <= 4096 &&
    /^[a-f0-9]{64}$/.test(prompt.sourceHash) &&
    /^[a-f0-9]{64}$/.test(prompt.contentHash) &&
    preparedHash === digest(stableJson({ ...evidence, body }))
  );
}
