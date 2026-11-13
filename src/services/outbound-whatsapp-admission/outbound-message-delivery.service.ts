import { freezeCommonText } from "../conversation-delivery-plan.js";
import { selectedCommonLayout } from "../recovery-multipart/composition.js";
import { commonLayoutVariables,renderCommonLayoutBoundaries,commonLayoutBody,type RecoveryLayoutReceipt } from "../recovery-multipart/common-layout.js";
import { prepareFrozenCommonReply } from "../recovery-multipart/preparation.js";
import { readCommonLayoutReceipt } from "../recovery-multipart/common-layout.js";
import { freezeBrandMedia, readPersistedConversationPlan, messageBrandReceipt, asMessageDeliveryReceipt } from "../conversation-delivery-plan.js";
import { createHash } from "node:crypto";
import { prepareRecoveryBrandPlan, frozenBrandPlanCurrent, resolveConversationLogo, type ConversationLogoResolver } from "../conversation-brand-media.js";
import { prepareRecoveryReplyBody } from "../conversation-wrappers/recovery-shop-header.js";
import { PrismaConversationWrapperReadRepository } from "../conversation-wrappers/repository.js";
import type { WrapperReadPort } from "../conversation-wrappers/contracts.js";
import { Prisma } from "@prisma/client";
import { ConversationMediaDeliveryPlanSchema, type ConversationMediaDeliveryPlan } from "@modainteract/moda-interact-shared/commerce/presentation";
import { sameConversationPlan, validConversationPlan, matchesConversationReceipt, type ConversationDeliveryReceipt } from "../conversation-delivery-plan.js";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import type { CommerceConversationProductContext } from "@modainteract/moda-interact-shared/commerce";
import { MessageStatus } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type { PrismaClient } from "@prisma/client";

import prisma from "../../lib/db.js";
import type { SendTemplateInput } from "../../integration/whatsapp/types.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { ShopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import { whatsAppService } from "../whatsapp.service.js";
import { AiTurnOwnershipService } from "../recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../recovery-conversation/outbound-send-fence.service.js";
import { recoveryRuntimeEligibility } from "../recovery-conversation/recovery-runtime-eligibility.service.js";
import { moderationAssessmentService, type ModerationAssessmentService } from "../conversation-moderation/moderation-assessment.service.js";
import { moderationConfig } from "../conversation-moderation/moderation-policy.js";
import { prepareAutomatedTemplateInput } from "../conversation-moderation/automated-template-input.js";
import type { InitialOutreachAdmissionScope, OutboundAdmissionResult } from "./outbound-whatsapp-admission.types.js";
import { initialOutreachDiagnostic, OutboundProviderFailureService } from "./outbound-provider-failure.service.js";
import { suppressionReason } from "./outbound-delivery-errors.js";
import { GeneralOutboundSendFenceService } from "./general-outbound-send-fence.service.js";
import {
  recoveryStoredConsentService, type StoredRecoveryConsentReader,
} from "../recovery-conversation/recovery-stored-consent.service.js";
import type { DispatchInput, RecoveryMarketingPermit } from "../recovery-conversation/outbound-send-fence.service.js";
import { WooInitialSendFenceService, type WooInitialFinalPermitInput } from "../woocommerce-recovery/woo-initial-send-fence.service.js";

const deliveryLogger = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
const templateSuppression = (reason: string) =>
  reason === "TEMPLATE_REGISTRATION_UNAVAILABLE" ||
  reason === "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" ||
  reason === "TEMPLATE_PROVIDER_STATUS_STALE";

export const TERMINAL_MESSAGE =
  "I am unable to continue this conversation right now. Please try again later.";

type DeliveryDatabase = Pick<
  PrismaClient,
  "$transaction" | "$queryRawUnsafe" | "conversation" | "conversationMessage" | "usageEvent"
>;

type AdmittedOutbound = Extract<
  OutboundAdmissionResult,
  { kind: "admitted" }
>;

type PreparedTemplateInput = Omit<SendTemplateInput, "to"> & {
  to: string;
  expectedControlRevision?: number;
  initialOutreach?: InitialOutreachAdmissionScope;
  recoveryCreditSourceKey?: string;
};

export class OutboundPreparationRetryError extends Error {
  constructor(readonly assessmentId: string, readonly retryAt: Date) {
    super("Initial template moderation requires retry");
    this.name = "OutboundPreparationRetryError";
  }
}

export class OutboundMessageDeliveryService {
  constructor(
    private readonly database: DeliveryDatabase = prisma,
    private readonly provider = whatsAppService,
    private readonly executionEligibility: Pick<
      ShopExecutionEligibilityService,
      "evaluate"
    > = shopExecutionEligibilityService,
    private readonly ownership = new AiTurnOwnershipService(),
    private readonly recoveryFence = new OutboundSendFenceService(undefined, recoveryRuntimeEligibility),
    private readonly moderation: ModerationAssessmentService = moderationAssessmentService,
    private readonly providerFailure = new OutboundProviderFailureService(database),
    private readonly generalFence = new GeneralOutboundSendFenceService(database),
    private readonly recoveryConsent: StoredRecoveryConsentReader = recoveryStoredConsentService,
    private readonly wooInitialFence: Pick<WooInitialSendFenceService, "admitFinalSend"> = new WooInitialSendFenceService(database),
    private readonly recoveryFooterContext: Pick<WrapperReadPort, "loadContext"> & Partial<Pick<WrapperReadPort,"loadSlots">> = new PrismaConversationWrapperReadRepository(),
    private readonly logoResolver: ConversationLogoResolver = resolveConversationLogo,
    private readonly multipart?: Pick<import("../recovery-multipart/engine.js").RecoveryMultipartDeliveryEngine,"freeze"|"continue">,
  ) {}

  /** Resolve outside moderation/admission transactions; never append after the permit. */
  private async prepareRecoveryFreeformBody(admission: Pick<AdmittedOutbound, "shopId" | "conversationId" | "executionScope">, body: string): Promise<{body: string; recoveryShopHeader?: RecoveryLayoutReceipt} | null> {
    const owner = await this.ownership.readTurnOwnership(admission.conversationId);
    if (!owner) return admission.executionScope === "recovery" ? null : {body};
    if (owner.shopId !== admission.shopId || owner.mode !== "AI") return null;
    const context = await this.recoveryFooterContext.loadContext(admission.conversationId);
    if (!context || context === "TENANT_MISMATCH" || context.shopId !== admission.shopId || context.conversationId !== admission.conversationId) return null;
    const slots=await this.recoveryFooterContext.loadSlots?.();
    const selected=slots&&context.checkoutAvailable&&context.recoveryShopHeader?selectedCommonLayout(slots,context):null;
    if(context.checkoutAvailable&&context.recoveryShopHeader&&slots?.some(slot=>slot.audience==="SHARED")&&!selected)return null;
    if(selected){
      const variables=commonLayoutVariables(context.shopId,context.recoveryShopHeader!.websiteUrl,context.recoveryShopHeader!.name,context.variables['checkout.url']??'');
      const boundaries=variables?renderCommonLayoutBoundaries(selected.reference,variables,body,context.shopId,admission.conversationId):null;
      if(!variables||!boundaries)return null;
      const common={schemaVersion:2 as const,kind:'RECOVERY_COMMON_LAYOUT' as const,shopId:context.shopId,commonRef:selected.reference,variables,boundaries};return {body:commonLayoutBody(common),recoveryShopHeader:common};
    }
    const prepared = prepareRecoveryReplyBody({body, source: "AI", context});
    return prepared.kind === "ready" ? prepared : null;
  }

  /** Capture once before new notice formatting/media; never recapture a revised owner for an image. */
  private async noticeIdentity(shopId: string, conversationId: string, expectedRevision?: number): Promise<{revision: number; inboundVersion: number} | null> {
    const owner = await this.ownership.readTurnOwnership(conversationId);
    if (!owner || owner.shopId !== shopId || owner.mode !== "AI" || (expectedRevision !== undefined && owner.revision !== expectedRevision)) return null;
    const conversation = await this.database.conversation.findUnique({where: {id: conversationId}, select: {inboundVersion: true}});
    return conversation && Number.isSafeInteger(conversation.inboundVersion) ? {revision: owner.revision, inboundVersion: conversation.inboundVersion} : null;
  }

  /** A persisted plan or assessed complete body is frozen even before the provider permit. */
  private async frozenPending(admission: Pick<AdmittedOutbound, "shopId" | "conversationId" | "messageId">): Promise<{body: string; plan?: ConversationMediaDeliveryPlan; receipt?: ConversationDeliveryReceipt; header?: RecoveryLayoutReceipt; policy?: import("../conversation-brand-media.js").BrandMediaPolicyRef} | "INVALID" | null> {
    if (typeof this.database.$queryRawUnsafe !== "function") return null;
    const rows = await this.database.$queryRawUnsafe<Array<{content: string; outboundPresentation: unknown; contentSha256: string | null}>>(`
      SELECT m."content",m."outboundPresentation",a."contentSha256"
      FROM "whatsapp"."ConversationMessage" m
      LEFT JOIN "whatsapp"."ConversationModerationAssessment" a ON a."conversationMessageId"=m."id" AND a."inputKind"='TEXT'
      JOIN "whatsapp"."Conversation" c ON c."id"=m."conversationId"
      LEFT JOIN "commerce"."CheckoutRecovery" r ON r."id"=c."checkoutRecoveryId"
      WHERE m."id"=$1 AND m."conversationId"=$2 AND m."direction"='OUTBOUND'
        AND m."senderType" IN ('AGENT','AUTOMATION') AND COALESCE(r."shopId",c."shopId")=$3`,
      admission.messageId, admission.conversationId, admission.shopId);
    const row = rows?.[0]; if (!row) return null;
    if (row.outboundPresentation != null) {
      const parsed = readPersistedConversationPlan(row.outboundPresentation);
      if (!parsed || parsed.plan.body !== row.content) return "INVALID";
      const persisted=parsed.brand??parsed.common;
      const receipt = persisted ? asMessageDeliveryReceipt(persisted.receipt) : null;
      if (persisted && (!receipt || receipt.shopId !== admission.shopId || receipt.conversationId !== admission.conversationId || receipt.messageId !== admission.messageId)) return "INVALID";
      return {body: row.content, plan: parsed.plan, ...(receipt ? {receipt} : {}), ...(persisted ? {header:persisted.recoveryShopHeader,...(parsed.brand?{policy:parsed.brand.policyRef}:{})} : {})};
    }
    const hash = createHash("sha256").update(row.content, "utf8").digest("hex");
    return rows.some(value => value.contentSha256 === hash) ? {body: row.content} : null;
  }

  async getProviderAccountId(): Promise<string> {
    return this.provider.getProviderAccountId();
  }

  async sendPreparedText(input: AdmittedOutbound & {
    to: string; text: string; previewUrl?: boolean; replyToProviderMessageId?: string; prepareRecoveryFooter?: true; recoveryShopHeader?: RecoveryLayoutReceipt;
    expectedControlRevision?: number; expectedInboundVersion?: number; productContextUpdate?: CommerceConversationProductContext;
  }): Promise<OutboundAdmissionResult> {
    return this.sendPreparedConversation({...input});
  }

  async sendPreparedConversation({
    commonLayout, multipartPlan,
    brandMediaPolicy,
    messageId,
    shopId,
    conversationId,
    terminal,
    executionScope = "general",
    to,
    text,
    previewUrl,
    replyToProviderMessageId,
    expectedControlRevision,
    expectedInboundVersion,
    productContextUpdate,
    deliveryPlan,
    presentationReceipt,
    prepareRecoveryFooter,
    recoveryShopHeader,
  }: AdmittedOutbound & {
    to: string;
    text: string;
    prepareRecoveryFooter?: true; recoveryShopHeader?: RecoveryLayoutReceipt;
    previewUrl?: boolean;
    replyToProviderMessageId?: string;
    expectedControlRevision?: number;
    expectedInboundVersion?: number;
    productContextUpdate?: CommerceConversationProductContext;
    commonLayout?: import("../recovery-multipart/common-layout.js").CommonLayoutReceipt; multipartPlan?: import("@modainteract/moda-interact-shared/commerce/presentation").RecoveryMultipartDeliveryPlan;
    brandMediaPolicy?: import("../conversation-brand-media.js").BrandMediaPolicyRef; deliveryPlan?: ConversationMediaDeliveryPlan;
    presentationReceipt?: ConversationDeliveryReceipt;
  }): Promise<OutboundAdmissionResult> {
    let outboundText = terminal ? TERMINAL_MESSAGE : text;
    if(commonLayout || multipartPlan){
      const common=readCommonLayoutReceipt(commonLayout,conversationId);
      const owner=await this.ownership.readTurnOwnership(conversationId);
      if(!common||!multipartPlan||terminal||prepareRecoveryFooter||!owner||owner.mode!=="AI"||owner.shopId!==shopId||owner.revision!==expectedControlRevision||!matchesConversationReceipt(presentationReceipt,{shopId,conversationId,messageId,...(expectedInboundVersion===undefined?{}:{expectedInboundVersion}),...(expectedControlRevision===undefined?{}:{expectedControlRevision})})||common.shopId!==shopId||common.boundaries.header+common.boundaries.body+common.boundaries.footer!==text){
        await this.failPrepared(messageId,{shopId,conversationId,unpreparedOnly:true});return {kind:"suppressed",reason:"conversation-invalid"};
      }
      const engine=this.multipart??(await import("../recovery-multipart/runtime.js")).recoveryMultipartEngine;
      // Replays are resumed by the engine/repair from immutable stored source;
      // never recompose a prepared group or acquire a newer ownership snapshot.
      if(await this.hasCompletedPreparation(messageId))return {kind:"admitted",shopId,messageId,conversationId,terminal,executionScope,deliveryState:"pending"};
      const suppression=await this.revalidateBeforeProvider({kind:"admitted",shopId,messageId,conversationId,terminal,executionScope});if(suppression)return suppression;
      const source=prepareFrozenCommonReply({preparation:{plan:multipartPlan,policyRef:brandMediaPolicy??null,receipt:messageBrandReceipt(presentationReceipt!)},common,messageId,recoveryId:owner.recoveryId,recipient:to,sender:await this.provider.resolveSender(),command:null,now:new Date(),...(productContextUpdate?{productContextUpdate}:{})});
      if(!(await this.prepareUnadmittedContent(messageId,text,undefined,{shopId,conversationId})))return {kind:"suppressed",reason:"duplicate"};
      await engine.freeze(source);
      if(!(await this.approvePreparedOutbound({shopId,conversationId,messageId,outboundText:text})))return {kind:"suppressed",reason:"conversation-invalid"};
      const outcome=await engine.continue(messageId);
      return outcome==="failed"||outcome==="cancelled"?{kind:"suppressed",reason:"conversation-invalid"}:{kind:"admitted",shopId,messageId,conversationId,terminal,executionScope,deliveryState:"pending"};
    }
    // A replay/uncertain permit is immutable even if a newly supplied plan is invalid.
    if (await this.hasCompletedPreparation(messageId))
      return { kind: "suppressed", reason: "duplicate" };
    const parsed = deliveryPlan === undefined ? undefined : ConversationMediaDeliveryPlanSchema.safeParse(deliveryPlan);
    if (parsed && !parsed.success) {
      await this.failPrepared(messageId, {shopId, conversationId, unpreparedOnly: true});
      return {kind: "suppressed", reason: "conversation-invalid"};
    }
    let plan = parsed?.success ? parsed.data : undefined;
    if (plan && (prepareRecoveryFooter || expectedControlRevision === undefined || expectedInboundVersion === undefined || terminal || !matchesConversationReceipt(presentationReceipt, {shopId, conversationId, messageId, expectedInboundVersion, expectedControlRevision}) || !validConversationPlan(plan, outboundText, shopId, presentationReceipt))) {
      await this.failPrepared(messageId, {shopId, conversationId, unpreparedOnly: true});
      return {kind: "suppressed", reason: "conversation-invalid"};
    }
    if (plan?.kind === "BRAND_IMAGE") {
      // Billing scope is not relationship authority: normal contracts use general
      // billing even for a durable recovery. Retain the ORIGINAL revision/tenant.
      const decision = await this.ownership.checkAutomatedTurn({conversationId, shopId,
        expectedRevision: expectedControlRevision!, phase: "before-provider"});
      if (decision.kind !== "allowed") {
        await this.failPrepared(messageId, {shopId, conversationId, unpreparedOnly: true});
        return {kind: "suppressed", reason: "conversation-invalid"};
      }
    }
    const suppression = await this.revalidateBeforeProvider({
      kind: "admitted",
      shopId,
      messageId,
      conversationId,
      terminal,
      executionScope,
    });
    if (suppression) return suppression;
    const frozen = await this.frozenPending({shopId, conversationId, messageId});
    if (frozen === "INVALID") { await this.failPrepared(messageId); return {kind: "suppressed", reason: "conversation-invalid"}; }
    if (frozen) { outboundText = frozen.body; plan = frozen.plan; recoveryShopHeader = frozen.header; brandMediaPolicy=frozen.policy; if (frozen.receipt) { presentationReceipt = frozen.receipt; expectedControlRevision = frozen.receipt.controlRevision; expectedInboundVersion = frozen.receipt.inboundVersion; } }
    const identity = !frozen && (terminal || prepareRecoveryFooter)
      ? await this.noticeIdentity(shopId, conversationId, expectedControlRevision) : null;
    if (!frozen && (terminal || prepareRecoveryFooter)) {
      const preparedTerminal = await this.prepareRecoveryFreeformBody({shopId, conversationId, executionScope}, outboundText);
      if (preparedTerminal === null) { await this.failPrepared(messageId); return {kind: "suppressed", reason: "conversation-invalid"}; }
      outboundText = preparedTerminal.body;
      recoveryShopHeader = preparedTerminal.recoveryShopHeader;
      if (identity) {
        plan = await prepareRecoveryBrandPlan({shopId, body: outboundText, header: recoveryShopHeader, onPolicy: ref=>{brandMediaPolicy=ref;}}, this.logoResolver);
        if (!plan&&recoveryShopHeader?.schemaVersion===2)plan={schemaVersion:1,kind:"TEXT",body:outboundText};
        if (plan) { expectedControlRevision ??= identity.revision; expectedInboundVersion ??= identity.inboundVersion;
          presentationReceipt = {shopId, conversationId, messageId, controlRevision: expectedControlRevision,
            inboundVersion: expectedInboundVersion, firstPair: null}; }
      }
    }

    if (plan?.kind === "BRAND_IMAGE") {
      try { freezeBrandMedia(plan, messageBrandReceipt(presentationReceipt!), recoveryShopHeader!, brandMediaPolicy!); }
      catch {
        await this.failPrepared(messageId, {shopId, conversationId, unpreparedOnly: true});
        return {kind: "suppressed", reason: "conversation-invalid"};
      }
    }
    if (!(await this.prepareUnadmittedContent(messageId, outboundText, plan, {shopId, conversationId}, presentationReceipt, recoveryShopHeader, brandMediaPolicy)))
      return { kind: "suppressed", reason: "duplicate" };
    if (!(await this.approvePreparedOutbound({ shopId, conversationId, messageId, outboundText }))) {
      await this.failPrepared(messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    if (plan && !(await frozenBrandPlanCurrent(plan, this.logoResolver))) { await this.failPrepared(messageId); return {kind: "suppressed", reason: "conversation-invalid"}; }
    const fenced = await this.fenceProviderSend({
      shopId, conversationId, messageId, to, expectedContent: outboundText,
      executionScope, deliveryKind: plan && plan.kind !== "TEXT" ? "IMAGE" : "TEXT",
      ...(recoveryShopHeader ? {recoveryShopHeader} : {}),
      ...(plan ? {deliveryPlan: plan, presentationReceipt} : {}),
      ...(productContextUpdate ? { productContextUpdate } : {}),
      ...(expectedControlRevision === undefined ? {} : { expectedControlRevision }),
      ...(expectedInboundVersion === undefined ? {} : { expectedInboundVersion }),
    });
    if (fenced) return fenced;

    let result: {providerMessageId: string; providerStatus?: string};
    try {
      result = plan && plan.kind !== "TEXT" ? await this.provider.sendWhatsAppImage({to, link: plan.image.publicUrl,
        caption: plan.body, ...(replyToProviderMessageId ? {replyToProviderMessageId} : {})}) : await this.provider.sendWhatsAppText({
        to,
        text: outboundText,
        ...(previewUrl !== undefined ? { previewUrl } : {}),
        ...(replyToProviderMessageId
          ? { replyToProviderMessageId }
          : {}),
      });
    } catch (error) {
      await this.providerFailure.afterProviderError(messageId, to, error);
      throw error;
    }
    await this.markSent(conversationId, messageId, result.providerMessageId);
    return {
      kind: "admitted",
      shopId,
      messageId,
      conversationId,
      terminal,
      executionScope,
    };
  }

  async sendPreparedTemplate(
    admission: AdmittedOutbound,
    input: PreparedTemplateInput,
  ): Promise<OutboundAdmissionResult> {
    return this.sendPreparedTemplateInternal(admission, input);
  }

  /** Explicit Woo-only entrypoint. It shares all moderation/provider/failure
   * handling with normal sends but CANNOT fall back to the generic recovery
   * permit, which deliberately does not validate the Woo consent snapshot.
   */
  async sendPreparedWooInitialTemplate(
    admission: AdmittedOutbound,
    input: Omit<SendTemplateInput, "to"> & { to: string },
    scope: Omit<WooInitialFinalPermitInput,
      "shopId" | "conversationId" | "messageId" | "recipient" | "expectedContent" | "templateName" | "languageCode" | "verifiedCategory" | "templateRegistration">,
  ): Promise<OutboundAdmissionResult> {
    return this.sendPreparedTemplateInternal(admission, input, scope);
  }

  private async sendPreparedTemplateInternal(
    admission: AdmittedOutbound,
    input: PreparedTemplateInput,
    wooScope?: Omit<WooInitialFinalPermitInput,
      "shopId" | "conversationId" | "messageId" | "recipient" | "expectedContent" | "templateName" | "languageCode" | "verifiedCategory" | "templateRegistration">,
  ): Promise<OutboundAdmissionResult> {
    const initial = !!(wooScope || input.initialOutreach);
    const identity = {
      shopId: admission.shopId, conversationId: admission.conversationId, messageId: admission.messageId,
      recoveryId: wooScope?.recoveryId ?? input.initialOutreach?.recoveryId,
      attemptId: wooScope?.attemptId ?? input.initialOutreach?.outreachAttemptId,
    };
    if (input.initialOutreach && (input.initialOutreach.shopId !== admission.shopId ||
        !input.recoveryCreditSourceKey || admission.executionScope !== "recovery"))
      return { kind: "suppressed", reason: "conversation-invalid" };
    if (await this.hasCompletedPreparation(admission.messageId))
      return { kind: "suppressed", reason: "duplicate" };
    // The Woo initial recovery MUST send an approved Marketing template. Never
    // substitute the hard-limit terminal TEXT message on this path.
    if (initial && admission.terminal) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "normal-cap-reached" };
    }
    const suppression = await this.revalidateBeforeProvider(admission);
    if (suppression) return suppression;
    // Automated recovery may never silently fall back to the old, unlinked
    // Meta catalogue, even if another caller forgets the BG001 identity.
    if ((wooScope || admission.executionScope === "recovery") && !admission.terminal &&
        !input.templateRegistration) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "TEMPLATE_REGISTRATION_UNAVAILABLE" };
    }
    if (input.templateRegistration && (
        input.templateRegistration.shopId !== admission.shopId ||
        input.templateRegistration.providerTemplateName !== input.templateName ||
        input.templateRegistration.providerLanguageCode !== input.languageCode ||
        input.templateRegistration.senderWabaId !== await this.getProviderAccountId())) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "TEMPLATE_REGISTRATION_UNAVAILABLE" };
    }
    // DATABASE-005 has no structured automated-template columns: persist the
    // *exact* deterministic template/parameter input as the prepared message
    // TEXT before assessing it. Only those parameters are classified, not the
    // unseen Meta-managed static template body (whose approval is independent).
    // Terminal sends continue to moderate and send their fixed text instead.
    let prepared: ReturnType<typeof prepareAutomatedTemplateInput> | null = null;
    let outboundText = TERMINAL_MESSAGE;
    let recoveryShopHeader: RecoveryLayoutReceipt | undefined;
    let noticePlan: ConversationMediaDeliveryPlan | undefined;
    let noticePolicy: import("../conversation-brand-media.js").BrandMediaPolicyRef | undefined;
    let noticeReceipt: ConversationDeliveryReceipt | undefined;
    let noticeIdentity: {revision: number; inboundVersion: number} | null = null;
    const frozenNotice = admission.terminal ? await this.frozenPending(admission) : null;
    if (frozenNotice === "INVALID") { await this.failPrepared(admission.messageId); return {kind: "suppressed", reason: "conversation-invalid"}; }
    if (frozenNotice) { outboundText = frozenNotice.body; noticePlan = frozenNotice.plan; noticeReceipt = frozenNotice.receipt; recoveryShopHeader = frozenNotice.header; noticePolicy=frozenNotice.policy; }
    if (admission.terminal && !frozenNotice) {
      noticeIdentity = await this.noticeIdentity(admission.shopId, admission.conversationId, input.expectedControlRevision);
      const preparedTerminal = await this.prepareRecoveryFreeformBody(admission, TERMINAL_MESSAGE);
      if (preparedTerminal === null) { await this.failPrepared(admission.messageId); return {kind: "suppressed", reason: "conversation-invalid"}; }
      outboundText = preparedTerminal.body;
      recoveryShopHeader = preparedTerminal.recoveryShopHeader;
      if (noticeIdentity) noticePlan = await prepareRecoveryBrandPlan({shopId: admission.shopId, body: outboundText, header: recoveryShopHeader, onPolicy:ref=>{noticePolicy=ref;}}, this.logoResolver);
    }
    if(!frozenNotice&&noticeIdentity&&recoveryShopHeader?.schemaVersion===2){
      noticePlan??={schemaVersion:1,kind:"TEXT",body:outboundText};
      noticeReceipt={shopId:admission.shopId,conversationId:admission.conversationId,messageId:admission.messageId,controlRevision:input.expectedControlRevision??noticeIdentity.revision,inboundVersion:noticeIdentity.inboundVersion,firstPair:null};
    }
    if (noticePlan?.kind === "BRAND_IMAGE") {
      if (!noticeReceipt && noticeIdentity) noticeReceipt = {shopId: admission.shopId, conversationId: admission.conversationId, messageId: admission.messageId, controlRevision: input.expectedControlRevision ?? noticeIdentity.revision, inboundVersion: noticeIdentity.inboundVersion, firstPair: null};
      if (!noticeReceipt || !(await frozenBrandPlanCurrent(noticePlan, this.logoResolver))) { await this.failPrepared(admission.messageId); return {kind: "suppressed", reason: "conversation-invalid"}; }
    }
    if (!admission.terminal) {
      try {
        prepared = prepareAutomatedTemplateInput(input);
        outboundText = prepared.effectiveText;
      } catch (error) {
        deliveryLogger.error("outbound.template.preparation.failed", {
          ...identity, stage: "preparation",
          ...(initial ? { sourceError: initialOutreachDiagnostic(error) }
            : { errorType: error instanceof Error ? error.name : "unknown" }),
        });
        // Known local validation failures are refusals, not retryable provider
        // faults. Unexpected exceptions are always logged and propagated so
        // the worker can retry rather than acknowledging a false refusal.
        if (!initial) await this.failPrepared(admission.messageId);
        const invalidTemplateInput = error instanceof Error && [
          "automated_template_unsupported", "automated_template_invalid_parameters",
          "automated_template_promise_mismatch", "automated_template_invalid_header",
          "automated_template_invalid_media", "automated_template_invalid_button",
          "automated_template_input_too_large",
        ].includes(error.message);
        if (wooScope || !invalidTemplateInput) throw error;
        return { kind: "suppressed", reason: "conversation-invalid" };
      }
    }
    if (!(await this.prepareUnadmittedContent(admission.messageId, outboundText, noticePlan, {shopId: admission.shopId, conversationId: admission.conversationId}, noticeReceipt, recoveryShopHeader, noticePolicy)))
      return { kind: "suppressed", reason: "duplicate" };
    let moderationAllowed: boolean;
    try {
      moderationAllowed = await this.approvePreparedOutbound({
        shopId: admission.shopId, conversationId: admission.conversationId,
        messageId: admission.messageId, outboundText, initial,
      });
    } catch (error) {
      // Woo has not requested the SQL permit. A failed moderation dependency
      // cannot hold a completed provider admission or count as a refusal.
      if (initial) {
        if (error instanceof OutboundPreparationRetryError) {
          deliveryLogger.warn("outbound.template.moderation.retry", {
            ...identity, stage: "moderation", assessmentId: error.assessmentId, retryAt: error.retryAt,
          });
        } else {
          deliveryLogger.error("outbound.template.moderation.failed", {
            ...identity, stage: "moderation", sourceError: initialOutreachDiagnostic(error),
          });
        }
        throw error;
      }
      try {
        await this.failPrepared(admission.messageId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "WOO_PRE_PERMIT_MODERATION_CLEANUP_FAILED", { cause: cleanupError });
      }
      throw error;
    }
    if (!moderationAllowed) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    if (wooScope) {
      // BG001 compilation already established immutable Marketing purpose.
      // The *actual* registration approval and latest Meta observation are
      // re-read under the existing Woo final SQL permit, never over Meta HTTP.
      const permit = await this.wooInitialFence.admitFinalSend({
        ...wooScope,
        shopId: admission.shopId, conversationId: admission.conversationId,
        messageId: admission.messageId, recipient: input.to,
        expectedContent: outboundText, templateName: input.templateName,
        languageCode: input.languageCode, verifiedCategory: "MARKETING",
        templateRegistration: input.templateRegistration!,
        ...(input.templateRegistration?.commonLayout?{templateParameters:{header:input.textHeader?[input.textHeader]:[],body:input.bodyParameters??[]}}:{}),
      });
      if (permit.kind === "suppressed") {
        // A previously committed permit can already have reached Meta. Never
        // roll it back or release its usage/credit on a duplicate replay.
        if (permit.reason === "already-admitted-or-sent")
          return { kind: "suppressed", reason: "duplicate" };
        await this.failPrepared(admission.messageId);
        return { kind: "suppressed", reason: templateSuppression(permit.reason)
          ? permit.reason as "TEMPLATE_REGISTRATION_UNAVAILABLE" | "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" | "TEMPLATE_PROVIDER_STATUS_STALE"
          : "conversation-invalid" };
      }
    } else {
      const fenced = await this.fenceProviderSend({
        shopId: admission.shopId, conversationId: admission.conversationId,
        messageId: admission.messageId, to: input.to, expectedContent: outboundText,
        ...(admission.executionScope === undefined ? {} : { executionScope: admission.executionScope }),
        deliveryKind: prepared ? "TEMPLATE" : noticePlan && noticePlan.kind !== "TEXT" ? "IMAGE" : "TEXT",
        ...(noticePlan && noticeReceipt ? {deliveryPlan: noticePlan, presentationReceipt: noticeReceipt, expectedControlRevision: noticeReceipt.controlRevision, expectedInboundVersion: noticeReceipt.inboundVersion} : {}),
        ...(recoveryShopHeader ? {recoveryShopHeader} : {}),
        ...(input.initialOutreach ? { initialOutreach: {
          outreachAttemptId: input.initialOutreach.outreachAttemptId,
          recoveryId: input.initialOutreach.recoveryId,
          idempotencyKey: `recovery-outreach:${input.initialOutreach.outreachAttemptId}`,
          recoveryCreditSourceKey: input.recoveryCreditSourceKey!,
          expectedContent: outboundText,
        } } : {}),
        ...(noticeReceipt || input.expectedControlRevision === undefined ? {} : { expectedControlRevision: input.expectedControlRevision }),
        ...(!admission.terminal ? { template: { name: input.templateName, languageCode: input.languageCode,
          ...(input.templateRegistration?.commonLayout?{parameters:{header:input.textHeader?[input.textHeader]:[],body:input.bodyParameters??[]}}:{}),
          ...(input.templateRegistration ? { registration: input.templateRegistration } : {}) } } : {}),
      });
      if (fenced) return fenced;
    }

    let result: {providerMessageId: string; providerStatus?: string};
    try {
      result = prepared
        ? await this.provider.sendWhatsAppTemplate(prepared.providerInput)
        : noticePlan && noticePlan.kind !== "TEXT" ? await this.provider.sendWhatsAppImage({to: input.to, link: noticePlan.image.publicUrl, caption: outboundText}) : await this.provider.sendWhatsAppText({ to: input.to, text: outboundText });
    } catch (error) {
      if (initial) deliveryLogger.error("outbound.initial.send.failed", {
        ...identity, stage: "provider_http", sourceError: initialOutreachDiagnostic(error),
      });
      try {
        await this.providerFailure.afterProviderError(admission.messageId, input.to, error, initial);
      } catch (reconciliationError) {
        // Retain BOTH the provider/local-send error and the reconciliation
        // failure. The Woo worker must not acknowledge an uncertain outcome.
        if (initial) {
          deliveryLogger.error("outbound.initial.cleanup.failed", {
            ...identity, stage: "provider_reconciliation",
            sendError: initialOutreachDiagnostic(error),
            reconciliationError: initialOutreachDiagnostic(reconciliationError),
          });
          throw new AggregateError([error, reconciliationError],
            "WOO_PROVIDER_OUTCOME_RECONCILIATION_FAILED", { cause: reconciliationError });
        }
        throw reconciliationError;
      }
      throw error;
    }
    try {
      await this.markSent(admission.conversationId, admission.messageId, result.providerMessageId);
    } catch (error) {
      if (initial) deliveryLogger.error("outbound.initial.send.failed", {
        ...identity, stage: "receipt_persistence", sourceError: initialOutreachDiagnostic(error),
      });
      throw error;
    }
    return admission;
  }

  /** A read avoids cleanup or moderation side effects on a replay; the guarded
   * write below is the definitive protection against an admission racing it.
   */
  private async hasCompletedPreparation(messageId: string): Promise<boolean> {
    const message = await this.database.conversationMessage.findUnique({
      where: { id: messageId },
      select: {
        status: true, providerDispatchKey: true, providerDispatchAdmittedAt: true,
      },
    });
    return !message || message.status !== MessageStatus.PENDING ||
      message.providerDispatchKey !== null || message.providerDispatchAdmittedAt !== null;
  }

  /** Never change persisted content once any sender has acquired a dispatch
   * permit. The unique id plus AND predicates form an atomic compare-and-set.
   * Nullable unique fields belong in a nested WhereInput, not at the top level
   * of Prisma's WhereUniqueInput (which rejects null for providerDispatchKey).
   */
  private async prepareUnadmittedContent(messageId: string, content: string, plan?: ConversationMediaDeliveryPlan, scope?: {shopId: string; conversationId: string}, receipt?: ConversationDeliveryReceipt, recoveryShopHeader?: RecoveryLayoutReceipt, policy?: import("../conversation-brand-media.js").BrandMediaPolicyRef): Promise<boolean> {
    if (plan?.kind === "BRAND_IMAGE" && (!receipt || !policy || !recoveryShopHeader || !scope || !matchesConversationReceipt(receipt, {shopId: scope.shopId, conversationId: scope.conversationId, messageId, expectedInboundVersion: receipt.inboundVersion, expectedControlRevision: receipt.controlRevision}))) return false;
    if (plan) return this.database.$transaction(async tx => {
      const rows = await tx.$queryRawUnsafe<{content: string; outboundPresentation: unknown; senderType: string; status: string; providerDispatchKey: string | null; providerDispatchAdmittedAt: Date | null}[]>(`
        SELECT "content","outboundPresentation","senderType"::text,"status"::text,"providerDispatchKey","providerDispatchAdmittedAt"
        FROM "whatsapp"."ConversationMessage" m
        WHERE m."id"=$1 AND m."conversationId"=$2 AND m."direction"='OUTBOUND'
          AND EXISTS (SELECT 1 FROM "whatsapp"."Conversation" c
            LEFT JOIN "commerce"."CheckoutRecovery" r ON r."id"=c."checkoutRecoveryId"
            WHERE c."id"=m."conversationId" AND COALESCE(r."shopId",c."shopId")=$3
              AND (c."shopId" IS NULL OR c."shopId"=$3)) FOR UPDATE`, messageId, scope?.conversationId, scope?.shopId);
      const row = rows[0];
      if (!row || (row.senderType !== "AGENT" && !((plan.kind === "BRAND_IMAGE"||recoveryShopHeader?.schemaVersion===2) && row.senderType === "AUTOMATION")) || row.status !== "PENDING" || row.providerDispatchKey || row.providerDispatchAdmittedAt) return false;
      if (row.outboundPresentation !== null && (!sameConversationPlan(row.outboundPresentation, plan) || row.content !== content)) return false;
      const persisted = plan.kind === "BRAND_IMAGE" ? freezeBrandMedia(plan, messageBrandReceipt(receipt!), recoveryShopHeader!, policy!) : plan.kind==="TEXT"&&recoveryShopHeader?.schemaVersion===2?freezeCommonText(plan,messageBrandReceipt(receipt!),recoveryShopHeader):plan;
      if ((plan.kind === "BRAND_IMAGE"||recoveryShopHeader?.schemaVersion===2) && row.outboundPresentation !== null && canonicalStoredReceipt(row.outboundPresentation) !== canonicalJson(receipt)) return false;
      await tx.conversationMessage.update({where: {id: messageId}, data: {content, outboundPresentation: persisted as unknown as Prisma.InputJsonValue}});
      return true;
    });
    try {
      await this.database.conversationMessage.update({
        where: {
          id: messageId,
          AND: {
            status: MessageStatus.PENDING,
            outboundPresentation: { equals: Prisma.DbNull },
            providerDispatchKey: null,
            providerDispatchAdmittedAt: null,
          },
        },
        data: { content },
      });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2025")
        return false;
      throw error;
    }
  }

  private async approvePreparedOutbound(input: {
    shopId: string; conversationId: string; messageId: string; outboundText: string; initial?: boolean;
  }): Promise<boolean> {
    try {
      const message = await this.database.conversationMessage.findUnique({
        where: { id: input.messageId }, select: { senderType: true, content: true },
      });
      if (!message || message.content !== input.outboundText ||
          (message.senderType !== "AGENT" && message.senderType !== "AUTOMATION")) return false;
      const subject = { kind: message.senderType === "AGENT" ? "AGENT_MESSAGE" as const : "AUTOMATION_MESSAGE" as const,
        messageId: input.messageId };
      const policyVersion = moderationConfig().policyVersion;
      const outcome = await this.moderation.assessText({
        subject, shopId: input.shopId, conversationId: input.conversationId,
        effectiveText: input.outboundText, inputKind: "TEXT", policyVersion, now: new Date(),
      });
      if (input.initial && outcome.kind === "retry")
        throw new OutboundPreparationRetryError(outcome.assessmentId, outcome.retryAt);
      return outcome.kind === "allow" && await this.moderation.requireCurrentAllowance({
        subject, effectiveText: input.outboundText, policyVersion,
      });
    } catch (error) {
      // Woo technical dependency failures must retry; only an explicit
      // moderation deny is a known pre-permit suppression.
      if (!input.initial) deliveryLogger.error("outbound.template.moderation.failed", {
        shopId: input.shopId, conversationId: input.conversationId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      // A moderation dependency exception is not a customer refusal. Propagate
      // for retry, with the existing pre-permit cleanup in the caller.
      throw error;
    }
  }

  /** Both general and recovery sends must commit a final Shop-ordered permit
   * before Meta I/O. Never recapture a recovery turn revision after takeover.
   */
  private async fenceProviderSend(input: {
    shopId: string; conversationId: string; messageId: string; to: string;
    expectedContent: string; recoveryShopHeader?: RecoveryLayoutReceipt; expectedControlRevision?: number; expectedInboundVersion?: number;
    executionScope?: "general" | "recovery";
    productContextUpdate?: CommerceConversationProductContext;
    template?: { name: string; languageCode: string; parameters?:{header:readonly string[];body:readonly string[]};
      registration?: import("../recovery-template-integration/final-template-registration.service.js").FinalTemplateIdentity };
    deliveryKind: "TEXT" | "IMAGE" | "TEMPLATE";
    brandMediaPolicy?: import("../conversation-brand-media.js").BrandMediaPolicyRef; deliveryPlan?: ConversationMediaDeliveryPlan; presentationReceipt?: ConversationDeliveryReceipt;
    initialOutreach?: NonNullable<DispatchInput["initialOutreach"]> & { recoveryId: string };
  }): Promise<Extract<OutboundAdmissionResult, { kind: "suppressed" }> | null> {
    const ownership = await this.ownership.readTurnOwnership(input.conversationId);
    if (input.initialOutreach && ownership?.recoveryId !== input.initialOutreach.recoveryId)
      return { kind: "suppressed", reason: "conversation-invalid" };
    if (!ownership) {
      if (input.deliveryPlan?.kind === "BRAND_IMAGE") { await this.failPrepared(input.messageId); return {kind: "suppressed", reason: "conversation-invalid"}; }
      if (input.productContextUpdate) {
        await this.failPrepared(input.messageId);
        return { kind: "suppressed", reason: "conversation-invalid" };
      }
      // A recovery-scoped reservation may not bypass the recovery consent/STOP
      // fence merely because ownership resolution returned no row.
      if (input.executionScope === "recovery") {
        await this.failPrepared(input.messageId);
        return { kind: "suppressed", reason: "conversation-invalid" };
      }
      const permit = await this.generalFence.admitFinalSend({
        shopId: input.shopId, conversationId: input.conversationId,
        messageId: input.messageId, recipient: input.to,
        expectedContent: input.expectedContent,
        ...(input.deliveryPlan ? {deliveryPlan: input.deliveryPlan, presentationReceipt: input.presentationReceipt, expectedControlRevision: input.expectedControlRevision} : {}),
        ...(input.expectedInboundVersion === undefined ? {} : { expectedInboundVersion: input.expectedInboundVersion }),
      });
      if (permit.kind === "admitted") return null;
      if (permit.reason === "already-admitted-or-sent")
        return { kind: "suppressed", reason: "duplicate" };
      await this.failPrepared(input.messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    const message = await this.database.conversationMessage.findUnique({
      where: { id: input.messageId }, select: { senderType: true },
    });
    if (!message || (message.senderType !== "AGENT" && message.senderType !== "AUTOMATION")) {
      await this.failPrepared(input.messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    let proactive: RecoveryMarketingPermit | undefined;
    if (input.template) {
      // Stored-consent preflight is performed outside SQL; no Meta GET.
      // A changed consent/STOP revision is independently caught inside the
      // Shop-locked final permit; this check cannot perform Shopify GraphQL.
      const permission = await this.recoveryConsent.preflight({
        shopId: input.shopId, recoveryId: ownership.recoveryId, recipient: input.to,
      });
      if (permission.kind !== "allowed") {
        await this.failPrepared(input.messageId);
        return { kind: "suppressed", reason: "conversation-invalid" };
      }
      // BG007's legacy HUMAN sender can still use its own provider verifier
      // until it migrates. Automated recovery *must* carry BG001 registration.
      if (!input.template.registration) {
        await this.failPrepared(input.messageId);
        return { kind: "suppressed", reason: "TEMPLATE_REGISTRATION_UNAVAILABLE" };
      }
      proactive = {
        verifiedCategory: "MARKETING", templateName: input.template.name,
        languageCode: input.template.languageCode, consent: permission.snapshot,
        templateRegistration: input.template.registration,
        ...(input.template.parameters?{templateParameters:input.template.parameters}:{}),
      };
    }
    const permit = await this.recoveryFence.admitFinalSend({
      senderType: message.senderType,
      ...(input.recoveryShopHeader ? {recoveryShopHeader: input.recoveryShopHeader} : {}),
      conversationId: input.conversationId, shopId: input.shopId,
      recoveryId: ownership.recoveryId,
      expectedControlRevision: input.expectedControlRevision ?? ownership.revision,
      ...(input.expectedInboundVersion === undefined ? {} : { expectedInboundVersion: input.expectedInboundVersion }),
      messageId: input.messageId, recipient: input.to, now: new Date(), expectedContent: input.expectedContent,
      ...(input.productContextUpdate ? { productContextUpdate: input.productContextUpdate, expectedContent: input.expectedContent } : {}),
      ...(proactive ? { proactive } : {}),
      deliveryKind: input.deliveryKind,
      ...(input.deliveryPlan ? {deliveryPlan: input.deliveryPlan, presentationReceipt: input.presentationReceipt, expectedContent: input.expectedContent} : {}),
      ...(input.initialOutreach ? { initialOutreach: input.initialOutreach } : {}),
    });
    if (permit.kind === "admitted") return null;
    if (permit.reason !== "already-admitted-or-sent") {
      await this.failPrepared(input.messageId);
    }
    return { kind: "suppressed", reason: templateSuppression(permit.reason)
      ? permit.reason as "TEMPLATE_REGISTRATION_UNAVAILABLE" | "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" | "TEMPLATE_PROVIDER_STATUS_STALE"
      : "conversation-invalid" };
  }

  async failPrepared(messageId: string, expectedReservation?: import("./outbound-whatsapp-admission.types.js").UntouchedReservationIdentity): Promise<void> {
    if (expectedReservation) await this.providerFailure.failPrepared(messageId, expectedReservation);
    else await this.providerFailure.failPrepared(messageId);
  }

  private async revalidateBeforeProvider(
    admission: AdmittedOutbound,
  ): Promise<Extract<OutboundAdmissionResult, { kind: "suppressed" }> | null> {
    const execution =
      admission.executionScope === "recovery"
        ? await this.executionEligibility.evaluate(
            admission.shopId,
            undefined,
            "recovery",
          )
        : await this.executionEligibility.evaluate(admission.shopId);
    if (execution.allowed) return null;

    await this.failPrepared(admission.messageId);
    return {
      kind: "suppressed",
      reason: suppressionReason(execution.reason),
    };
  }

  private async markSent(
    conversationId: string,
    messageId: string,
    providerMessageId: string,
  ): Promise<void> {
    const receivedAt = new Date();
    await this.database.$transaction(async (transaction) => {
      // Lock the parent first, matching the final permit transaction.
      // A failed receipt update rolls back the parent timestamp as well.
      await transaction.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: receivedAt },
      });
      await transaction.conversationMessage.update({
        where: {
          id: messageId,
          AND: {
            conversationId,
            direction: "OUTBOUND",
            senderType: { in: ["AUTOMATION", "AGENT"] },
            status: MessageStatus.PENDING,
            providerDispatchKey: { not: null },
            providerDispatchAdmittedAt: { not: null },
            providerDispatchControlRevision: { not: null },
            providerMessageId: null,
            sentAt: null,
            deliveredAt: null,
            readAt: null,
            failedAt: null,
          },
        },
        data: { providerMessageId, status: MessageStatus.SENT, sentAt: receivedAt },
      });
    });
  }
}

function canonicalStoredReceipt(raw: unknown): string | undefined {
 const parsed = readPersistedConversationPlan(raw);
 const persisted=parsed?.brand??parsed?.common;
 const receipt = persisted ? asMessageDeliveryReceipt(persisted.receipt) : null;
 return receipt ? canonicalJson(receipt) : undefined;
}
