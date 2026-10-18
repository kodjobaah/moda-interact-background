/** ARCH-043 consumer adapters. Shared source of truth remains BACKGROUND-001. */
import { parseCredentialKeyring, resolveActiveCredentialKey } from "@modainteract/moda-interact-shared/security/credentials/node";
import { createProductionBackgroundPlatformConfiguration } from "./production.js";
import type { WooCouponSyncConfig } from "../woo-coupon-sync-config.js";

const configuration = createProductionBackgroundPlatformConfiguration();
export const platformConsumerConfiguration = configuration;

/** Capture one validated row per operation. No environment or last-good fallback. */
export async function readWooCouponPolicy(): Promise<Readonly<WooCouponSyncConfig & { workerConcurrency: number }>> {
  return (await configuration.read("woo.couponSync")).value;
}
export async function readR2Configuration() {
  return (await configuration.read("merchant.knowledge.r2")).value;
}
export async function readCommerceKeyring() {
  const value = (await configuration.read("commerce.connectionKeys")).value;
  const keyring = parseCredentialKeyring(value.connectionKeysJson);
  resolveActiveCredentialKey(keyring, value.activeKeyId);
  return keyring;
}
export async function readSpeechOperation() {
  const rows = await configuration.readBundle(["speech.transcription", "ai.providers"]);
  const policy = rows["speech.transcription"].value;
  const keys = rows["ai.providers"].value;
  const apiKey = policy.provider === "openai" ? keys.openAiApiKey : keys.groqApiKey;
  if (!apiKey) throw new Error("speech-transcription-configuration-missing");
  return { provider: policy.provider, model: policy.provider === "openai" ? policy.openaiModelId : policy.groqModelId, apiKey };
}
