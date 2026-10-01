import { randomUUID, createCipheriv } from "node:crypto";
import { execFileSync } from "node:child_process";
import { register } from "tsx/esm/api";
import {
  CommerceModelAvailabilitySchema,
  CommerceModelCatalogueEntrySchema,
  CommercePricingPlanModelAssignmentSchema,
  ResolvedCommerceModelSchema,
  createCommerceOpenRouterCredentialAad,
} from "@modainteract/moda-interact-shared/commerce/model";

const id = randomUUID().replaceAll("-", "");
const container = `arch024-production-model-${id}`;
const network = `${container}-network`;
const databasePassword = `disposable-${randomUUID()}`;
const encryptionKey = Buffer.alloc(32, 0x5a);
const encryptionKeyBase64 = encryptionKey.toString("base64");
const environment = { ...process.env };

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function sealCredential(credential) {
  const nonce = Buffer.from(randomUUID().replaceAll("-", "").slice(0, 24), "hex");
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(createCommerceOpenRouterCredentialAad({
    environment: "DEVELOPMENT",
    keyId: "disposable-key",
  }), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(credential, "utf8")),
    cipher.final(),
  ]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

async function waitForPostgres() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      docker(["exec", container, "pg_isready", "-U", "postgres", "-d", "postgres"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready");
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertWinner(result, source, modelId) {
  assert(
    result.selectionSource === source && result.model.catalogueEntryId === modelId,
    `expected ${source}/${modelId}, got ${result.selectionSource}/${result.model.catalogueEntryId}`,
  );
}

async function expectUnavailable(operation, description) {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof Error && error.message === "Commerce model is unavailable", `${description} returned a bounded error`);
    return;
  }
  throw new Error(`Assertion failed: ${description} should fail closed`);
}

let client;

try {
  docker(["network", "create", network]);
  docker([
    "run", "--detach", "--name", container, "--network", network,
    "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_USER=postgres",
    "--env", `POSTGRES_PASSWORD=${databasePassword}`,
    "--env", "POSTGRES_DB=postgres",
    "pgvector/pgvector:pg16",
  ]);
  await waitForPostgres();
  const published = docker(["port", container, "5432/tcp"]);
  const port = Number(published.slice(published.lastIndexOf(":") + 1));
  assert(Number.isInteger(port) && port > 0, "Docker published a disposable PostgreSQL port");
  const databaseUrl = `postgresql://postgres:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/postgres`;

  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "database/prisma/schema.prisma"], {
    cwd: process.cwd(),
    env: { ...environment, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  await waitForPostgres();

  register();
  const [{ PrismaClient }, { resolveProductionCommerceModel }, { createOpenRouterCredentialResolver }, { createProductionCommerceModelInvoker }] = await Promise.all([
    import("@prisma/client"),
    import("../src/commerce/model-resolution.ts"),
    import("../src/commerce/openrouter-credential.ts"),
    import("../src/commerce/production-model.ts"),
  ]);
  client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const admin = await client.platformAdmin.create({
    data: {
      id: "arch024-proof-admin",
      email: "arch024-proof@example.invalid",
      displayName: "Disposable ARCH-024 proof",
      role: "ADMIN",
    },
  });

  await client.shop.createMany({
    data: [
      { id: "shop-a", domain: "shop-a.myshopify.com" },
      { id: "shop-b", domain: "shop-b.myshopify.com" },
    ],
  });
  const platformAvailability = await client.commerceModelAvailability.findFirstOrThrow({
    where: { scope: "PLATFORM", shopId: null },
  });
  const shopAvailability = await client.commerceModelAvailability.create({
    data: { id: "proof-shop-a-availability", scope: "SHOP", shopId: "shop-a", enabled: true },
  });

  const modelRows = [
    ["platform-model", platformAvailability.id],
    ["starter-model", platformAvailability.id],
    ["growth-model", platformAvailability.id],
    ["shop-a-model", shopAvailability.id],
  ];
  for (const [modelId, availabilityId] of modelRows) {
    await client.commerceModelCatalogueEntry.create({
      data: {
        id: modelId,
        availabilityId,
        provider: "openai",
        providerModelId: modelId,
        displayName: modelId,
        description: "Disposable model-resolution proof entry",
        configurationSchemaVersion: 1,
        configuration: { temperature: 0.2 },
        enabled: true,
        createdByAdminId: admin.id,
        updatedByAdminId: admin.id,
      },
    });
  }

  const platformConfiguration = await client.commerceAgentConfiguration.create({
    data: {
      id: "proof-platform-development",
      environment: "DEVELOPMENT",
      scope: "PLATFORM",
      modelId: "platform-model",
    },
  });
  const shopConfiguration = await client.commerceAgentConfiguration.create({
    data: {
      id: "proof-shop-a-development",
      environment: "DEVELOPMENT",
      scope: "SHOP",
      shopId: "shop-a",
      modelId: null,
    },
  });
  await client.commerceAgentConfiguration.create({
    data: {
      id: "proof-shop-b-development",
      environment: "DEVELOPMENT",
      scope: "SHOP",
      shopId: "shop-b",
      modelId: "shop-a-model",
    },
  });

  const planDetails = [
    { id: "merchant-starter", handle: "starter", modelId: "starter-model", displayName: "Starter" },
    { id: "merchant-growth", handle: "growth", modelId: "growth-model", displayName: "Growth" },
  ];
  const pricingLocales = [
    "zh-Hans", "zh-Hant", "cs", "da", "nl", "en", "fi", "fr", "de", "it",
    "ja", "ko", "nb", "pl", "pt-BR", "pt-PT", "es", "sv", "th", "tr",
  ];
  await client.$transaction(async (transaction) => {
    for (const [cataloguePosition, plan] of planDetails.entries()) {
      await transaction.merchantPricingPlan.create({
        data: {
          id: plan.id,
          shopifyPlanHandle: plan.handle,
          displayName: plan.displayName,
          planKind: "PAID_METERED",
          cataloguePosition,
          includedRecoveryCredits: 0,
          allowancePeriod: "EVERY_30_DAYS",
          billingPeriod: "EVERY_30_DAYS",
          recurringAmountMinor: plan.handle === "starter" ? 1000 : 3000,
          currency: "USD",
          commerceModelId: plan.modelId,
        },
      });
      await transaction.merchantPricingPlanTranslation.createMany({
        data: pricingLocales.map((locale) => ({
          merchantPricingPlanId: plan.id,
          locale,
          merchantDescription: `${plan.displayName} disposable proof plan`,
        })),
      });
    }
  });
  for (const plan of planDetails) {
    await client.billingPlan.create({
      data: {
        id: `billing-${plan.handle}`,
        shopifyPlanHandle: plan.handle,
        name: plan.displayName,
        kind: "PAID_METERED",
      },
    });
  }
  await client.subscription.create({
    data: {
      id: "subscription-shop-a",
      shopId: "shop-a",
      planId: "billing-starter",
      status: "ACTIVE",
    },
  });

  const input = { db: client, environment: "DEVELOPMENT", shopId: "shop-a" };
  const proofState = await client.subscription.findUnique({
    where: { shopId: "shop-a" },
    select: {
      status: true,
      planId: true,
      plan: { select: { shopifyPlanHandle: true } },
    },
  });
  const proofPlan = await client.merchantPricingPlan.findUnique({
    where: { shopifyPlanHandle: "starter" },
    select: { id: true, shopifyPlanHandle: true, commerceModelId: true },
  });
  assert(proofState?.status === "ACTIVE" && proofState.plan?.shopifyPlanHandle === "starter", "current subscription points to the Starter BillingPlan");
  assert(proofPlan?.commerceModelId === "starter-model", "Starter MerchantPricingPlan points to starter-model");
  const proofShopConfiguration = await client.commerceAgentConfiguration.findFirst({
    where: { environment: "DEVELOPMENT", scope: "SHOP", shopId: "shop-a" },
    select: { modelId: true },
  });
  assert(proofShopConfiguration?.modelId === null, "Shop Agent Configuration has no explicit model override");
  const proofPlanModel = await client.commerceModelCatalogueEntry.findUnique({
    where: { id: "starter-model" },
    include: { availability: true },
  });
  assert(proofPlanModel?.enabled && proofPlanModel.availability.enabled && proofPlanModel.availability.scope === "PLATFORM" && proofPlanModel.availability.shopId === null, "Starter model has enabled Platform availability");
  const proofAvailability = CommerceModelAvailabilitySchema.parse({
    id: proofPlanModel.availability.id,
    scope: proofPlanModel.availability.scope,
    shopId: proofPlanModel.availability.shopId,
    enabled: proofPlanModel.availability.enabled,
    editVersion: proofPlanModel.availability.editVersion,
  });
  const proofCatalogueEntry = CommerceModelCatalogueEntrySchema.parse({
    id: proofPlanModel.id,
    availabilityId: proofPlanModel.availabilityId,
    provider: proofPlanModel.provider,
    providerModelId: proofPlanModel.providerModelId,
    displayName: proofPlanModel.displayName,
    description: proofPlanModel.description,
    configurationSchemaVersion: proofPlanModel.configurationSchemaVersion,
    configuration: proofPlanModel.configuration,
    enabled: proofPlanModel.enabled,
    editVersion: proofPlanModel.editVersion,
  });
  ResolvedCommerceModelSchema.parse({
    environment: input.environment,
    sourceScope: proofAvailability.scope,
    sourceShopId: proofAvailability.shopId,
    catalogueEntryId: proofCatalogueEntry.id,
    provider: proofCatalogueEntry.provider,
    providerModelId: proofCatalogueEntry.providerModelId,
    configurationSchemaVersion: proofCatalogueEntry.configurationSchemaVersion,
    configuration: proofCatalogueEntry.configuration,
  });
  CommercePricingPlanModelAssignmentSchema.parse({
    merchantPricingPlanId: proofPlan.id,
    shopifyPlanHandle: proofPlan.shopifyPlanHandle,
    modelId: proofPlan.commerceModelId,
  });
  let resolved = await resolveProductionCommerceModel(input);
  assertWinner(resolved, "PRICING_PLAN", "starter-model");

  await client.subscription.update({
    where: { shopId: "shop-a" },
    data: { pendingPlanId: "billing-growth", pendingShopifyPlanHandle: "growth" },
  });
  resolved = await resolveProductionCommerceModel(input);
  assertWinner(resolved, "PRICING_PLAN", "starter-model");

  await client.subscription.update({
    where: { shopId: "shop-a" },
    data: { planId: "billing-growth" },
  });
  resolved = await resolveProductionCommerceModel(input);
  assertWinner(resolved, "PRICING_PLAN", "growth-model");

  await client.commerceAgentConfiguration.update({
    where: { id: shopConfiguration.id },
    data: { modelId: "shop-a-model" },
  });
  resolved = await resolveProductionCommerceModel(input);
  assertWinner(resolved, "SHOP", "shop-a-model");

  await client.commerceAgentConfiguration.update({
    where: { id: shopConfiguration.id },
    data: { modelId: null },
  });
  await client.commerceAgentConfiguration.delete({ where: { id: platformConfiguration.id } });
  resolved = await resolveProductionCommerceModel(input);
  assertWinner(resolved, "PRICING_PLAN", "growth-model");

  await client.merchantPricingPlan.update({
    where: { id: "merchant-growth" },
    data: { commerceModelId: "shop-a-model" },
  });
  await expectUnavailable(
    () => resolveProductionCommerceModel(input),
    "a Price Plan assignment to Shop-only availability",
  );

  await client.merchantPricingPlan.update({
    where: { id: "merchant-growth" },
    data: { commerceModelId: null },
  });
  await client.commerceAgentConfiguration.create({
    data: {
      id: "proof-platform-development-restored",
      environment: "DEVELOPMENT",
      scope: "PLATFORM",
      modelId: "platform-model",
    },
  });
  resolved = await resolveProductionCommerceModel(input);
  assertWinner(resolved, "PLATFORM", "platform-model");
  await expectUnavailable(
    () => resolveProductionCommerceModel({ ...input, shopId: "shop-b" }),
    "Shop B selecting Shop A model availability",
  );

  const keyring = { "disposable-key": encryptionKey };
  process.env.COMMERCE_CONNECTION_KEYS_JSON = JSON.stringify({
    "disposable-key": encryptionKeyBase64,
  });
  const credentialResolver = createOpenRouterCredentialResolver({ db: client, keyring });
  const firstCredential = sealCredential("credential-A");
  await client.commerceOpenRouterCredential.create({
    data: {
      id: "proof-openrouter-credential",
      environment: "DEVELOPMENT",
      keyId: "disposable-key",
      ...firstCredential,
      updatedByAdminId: admin.id,
    },
  });

  const observedInvocations = [];
  const createClient = (options) => ({
    invoke: async (request, signal) => {
      assert(!signal.aborted, "model invocation receives an active signal");
      observedInvocations.push({
        provider: options.provider,
        providerModelId: options.providerModelId,
        configurationSchemaVersion: options.configurationSchemaVersion,
        configuration: options.configuration,
        credential: options.credential,
        request,
      });
      return { calls: [], outputTokens: 0 };
    },
  });
  const productionInvoker = await createProductionCommerceModelInvoker({
    ...input,
    credentialResolver,
    createClient,
  });
  const originalModelId = productionInvoker.selection.selectionSource;
  const testRequest = {
    instructions: [], context: {}, history: [], messages: [], tools: [], maxOutputTokens: 1,
  };
  await productionInvoker.invoke(testRequest, new AbortController().signal);
  assert(observedInvocations[0]?.credential === "credential-A", "first invocation uses credential A");
  assert(observedInvocations[0]?.providerModelId === "platform-model", "invoker retains selected Platform model");

  const secondCredential = sealCredential("credential-B");
  await client.commerceOpenRouterCredential.update({
    where: { environment: "DEVELOPMENT" },
    data: { ...secondCredential, editVersion: { increment: 1 } },
  });
  await client.commerceAgentConfiguration.update({
    where: { id: "proof-platform-development-restored" },
    data: { modelId: "starter-model" },
  });
  await productionInvoker.invoke(testRequest, new AbortController().signal);
  assert(observedInvocations[1]?.credential === "credential-B", "next invocation observes credential B");
  assert(observedInvocations[1]?.providerModelId === "platform-model", "current invoker keeps original model identity");
  assert(productionInvoker.selection.selectionSource === originalModelId, "selection provenance is stable for the turn");

  const nextTurnInvoker = await createProductionCommerceModelInvoker({
    ...input,
    credentialResolver,
    createClient,
  });
  await nextTurnInvoker.invoke(testRequest, new AbortController().signal);
  assert(observedInvocations[2]?.credential === "credential-B", "new turn also sees current credential");
  assert(observedInvocations[2]?.providerModelId === "starter-model", "new turn resolves changed model selection");

  console.log("ARCH-024 disposable production-model proof passed (selection, pending-plan, Shop scope, credential rotation, and turn stability)");
} finally {
  if (client) await client.$disconnect().catch(() => {});
  delete process.env.COMMERCE_CONNECTION_KEYS_JSON;
  try { docker(["rm", "--force", container]); } catch {}
  try { docker(["network", "rm", network]); } catch {}
}