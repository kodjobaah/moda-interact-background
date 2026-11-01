import type { PrismaClient } from "@prisma/client";
import type { CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import type { CommerceModelInvoker } from "@modainteract/moda-interact-shared/commerce/runner";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { runInitialOutreachOfferAgent } from "../../agents/initial-outreach-offer.agent.js";
import type { InitialOutreachAgentResult } from "../../agents/initial-outreach-offer.types.js";
import { createProductionCommerceModelInvoker } from "../../commerce/production-model.js";
import { readCanonicalCredentialKeyring } from "../../commerce/credential-keyring.js";
import { createOpenRouterCredentialResolver } from "../../commerce/openrouter-credential.js";
import { resolveCommerceEnvironment } from "../../commerce/model-environment.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { InitialOutreachAgentContextService } from "./initial-outreach-agent-context.service.js";
import { RecoveryOutreachMcpSelectorService } from "./recovery-outreach-mcp-selector.service.js";
import { CurrentOutreachOfferRevalidationService, type CurrentOutreachOfferAdmissionToken } from "./current-outreach-offer-revalidation.service.js";
import { CheckoutPriceReconciliationService } from "../recovery-pricing/checkout-price-reconciliation.service.js";
import type {
  ExactProductReader, RecoveryPricingState, TrustedRecoveryAttemptReader,
} from "../recovery-pricing/checkout-price-reconciliation.types.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type ContextBuilder = Pick<InitialOutreachAgentContextService, "build">;

export class InitialOfferEnrichmentError extends Error {
  constructor(readonly trigger: "AI_UNAVAILABLE" | "MCP_UNAVAILABLE", cause: unknown) {
    super("Initial offer enrichment failed.", { cause });
    this.name = "InitialOfferEnrichmentError";
  }
}

export type InitialOutreachOfferSelectionDependencies = Readonly<{
  db?: PrismaClient;
  environment?: CommerceEnvironment;
  contextBuilder?: ContextBuilder;
  modelInvoker?: CommerceModelInvoker;
  createSelector?: (input: { shopId: string; signal: AbortSignal }) => RecoveryOutreachMcpSelectorService;
  agent?: typeof runInitialOutreachOfferAgent;
  logger?: Pick<StructuredLogger, "info" | "warn" | "error">;
  revalidator?: Pick<CurrentOutreachOfferRevalidationService,
    "revalidateCurrentOutreachOffer" | "validateAdmission">;
}>;

function createTrustedRecoveryAttemptReader(db: PrismaClient): TrustedRecoveryAttemptReader {
  return {
    async read(input): Promise<RecoveryPricingState | null> {
      const [recovery, attempt] = await Promise.all([
        db.checkoutRecovery.findFirst({
          where: { id: input.checkoutRecoveryId, shopId: input.shopId },
          select: { id: true, shopId: true, generation: true, currency: true,
            lineItems: true, platform: true, status: true },
        }),
        db.recoveryOutreachAttempt.findFirst({
          where: { id: input.outreachAttemptId, checkoutRecoveryId: input.checkoutRecoveryId },
          select: { id: true, checkoutRecoveryId: true, sequence: true, trigger: true,
            status: true, initiatedBy: true },
        }),
      ]);
      return recovery && attempt ? { recovery, attempt } : null;
    },
  };
}

function createExactProductReader(
  createSelector: NonNullable<InitialOutreachOfferSelectionDependencies["createSelector"]>,
): ExactProductReader {
  return {
    async read(input) {
      const selector = createSelector({ shopId: input.shopId, signal: input.signal });
      try {
        await selector.connect();
        await selector.tools();
        return await selector.call("commerce_get_product", {
          productId: input.productId,
          variantId: input.variantId,
        }, input.signal);
      } finally {
        await selector.close();
      }
    },
  };
}

function productionContextBuilder(
  db: PrismaClient,
  environment: CommerceEnvironment,
  createSelector: NonNullable<InitialOutreachOfferSelectionDependencies["createSelector"]>,
): ContextBuilder {
  const prices = new CheckoutPriceReconciliationService({
    recoveryAttemptReader: createTrustedRecoveryAttemptReader(db),
    productReader: createExactProductReader(createSelector),
    environment,
    logger,
  });
  return new InitialOutreachAgentContextService({ db, environment, priceReconciliationService: prices });
}

/** Composes current trusted context, BG016 source-price evidence and BG010's validated decision. */
export class InitialOutreachOfferSelectionService {
  private readonly db: PrismaClient;
  private readonly environment: CommerceEnvironment;
  private contextBuilder: ContextBuilder | null;
  private readonly createSelector: NonNullable<InitialOutreachOfferSelectionDependencies["createSelector"]>;
  private readonly agent: typeof runInitialOutreachOfferAgent;
  private readonly logger: Pick<StructuredLogger, "info" | "warn" | "error">;
  private revalidator: Pick<CurrentOutreachOfferRevalidationService,
    "revalidateCurrentOutreachOffer" | "validateAdmission"> | null;
  private credentialResolver: ReturnType<typeof createOpenRouterCredentialResolver> | null = null;

  constructor(dependencies: InitialOutreachOfferSelectionDependencies = {}) {
    this.db = dependencies.db ?? prisma;
    this.environment = dependencies.environment ?? resolveCommerceEnvironment();
    this.createSelector = dependencies.createSelector ?? ((input) =>
      new RecoveryOutreachMcpSelectorService(input));
    this.contextBuilder = dependencies.contextBuilder ?? null;
    this.logger = dependencies.logger ?? logger;
    this.revalidator = dependencies.revalidator ?? null;
    this.agent = dependencies.agent ?? runInitialOutreachOfferAgent;
    this.injectedModelInvoker = dependencies.modelInvoker;
  }

  async resolve(input: Readonly<{
    shopId: string;
    checkoutRecoveryId: string;
    outreachAttemptId: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    result: InitialOutreachAgentResult;
    context: Awaited<ReturnType<ContextBuilder["build"]>>;
    currentContext: Awaited<ReturnType<ContextBuilder["build"]>>;
    signal: AbortSignal;
    admissionToken?: CurrentOutreachOfferAdmissionToken;
  }>> {
    const signal = input.signal ?? AbortSignal.timeout(65_000);
    const contextBuilder = this.getContextBuilder();
    const revalidator = this.getRevalidator();
    const context = await contextBuilder.build({
      shopId: input.shopId,
      checkoutRecoveryId: input.checkoutRecoveryId,
      outreachAttemptId: input.outreachAttemptId,
      signal,
    });
    let result: InitialOutreachAgentResult;
    try {
      result = await this.agent(context, {
        signal,
        ...(this.dependenciesModelInvoker ? { modelInvoker: this.dependenciesModelInvoker } : {}),
        createSelector: this.createSelector,
        createModelInvoker: () => this.createModelInvoker(input.shopId),
        logger: this.logger,
      });
    } catch (error) {
      const trigger = error instanceof Error && error.name === "CommerceHostError"
        ? "MCP_UNAVAILABLE" : "AI_UNAVAILABLE";
      this.logger.error("recovery_offer.initial_enrichment.failed", {
        shopId: input.shopId,
        recoveryId: input.checkoutRecoveryId,
        attemptId: input.outreachAttemptId,
        trigger,
        reason: "OPTIONAL_ENRICHMENT_FAILURE",
        errorType: error instanceof Error ? error.name : "unknown",
        error,
      });
      throw new InitialOfferEnrichmentError(trigger, error);
    }
    const currentContext = await contextBuilder.build({
      shopId: input.shopId,
      checkoutRecoveryId: input.checkoutRecoveryId,
      outreachAttemptId: input.outreachAttemptId,
      signal,
    });
    const revalidated = await revalidator.revalidateCurrentOutreachOffer({
      shopId: input.shopId,
      checkoutRecoveryId: input.checkoutRecoveryId,
      outreachAttemptId: input.outreachAttemptId,
      proposed: result,
      signal,
    });
    if (revalidated.kind === "FAILURE") {
      return {
        result: { kind: "FAILURE", code: "UNAVAILABLE", reasonCode: revalidated.reasonCode,
          retryable: revalidated.retryable },
        context, currentContext,
        signal,
      };
    }
    return {
      result: revalidated.result, context, currentContext: revalidated.context, signal,
      admissionToken: revalidated.admissionToken,
    };
  }

  validateAdmission(token: CurrentOutreachOfferAdmissionToken, signal: AbortSignal): Promise<boolean> {
    return this.getRevalidator().validateAdmission(token, signal);
  }

  private getContextBuilder(): ContextBuilder {
    this.contextBuilder ??= productionContextBuilder(this.db, this.environment, this.createSelector);
    return this.contextBuilder;
  }

  private getRevalidator(): Pick<CurrentOutreachOfferRevalidationService,
    "revalidateCurrentOutreachOffer" | "validateAdmission"> {
    this.revalidator ??= new CurrentOutreachOfferRevalidationService({
      contextBuilder: this.getContextBuilder(),
      createSelector: (input) => this.createSelector(input),
      logger: this.logger,
    });
    return this.revalidator;
  }

  private get dependenciesModelInvoker(): CommerceModelInvoker | undefined {
    return this.injectedModelInvoker;
  }

  private readonly injectedModelInvoker: CommerceModelInvoker | undefined;

  private async createModelInvoker(shopId: string): Promise<CommerceModelInvoker> {
    if (!this.credentialResolver) {
      this.credentialResolver = createOpenRouterCredentialResolver({
        db: this.db,
        keyring: await readCanonicalCredentialKeyring(),
      });
    }
    return createProductionCommerceModelInvoker({
      db: this.db,
      environment: this.environment,
      shopId,
      credentialResolver: this.credentialResolver,
      logger: this.logger as StructuredLogger,
    });
  }
}

export const initialOutreachOfferSelectionService = new InitialOutreachOfferSelectionService();