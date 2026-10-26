import { canonicaliseLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import type { WrapperAudience, WrapperDefinition, WrapperSlot } from "./contracts.js";

export function canonicalTag(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return canonicaliseLanguageTag(value);
}

/** Explicit precedence. Invalid override never silently falls back to SHARED. */
export function chooseSlot(slots: readonly WrapperSlot[], source: "AI" | "HUMAN"):
  WrapperSlot | "invalid" | null {
  const own = slots.filter((slot) => slot.audience === source);
  const shared = slots.filter((slot) => slot.audience === "SHARED");
  if (own.length > 1 || shared.length > 1 || slots.some((slot) =>
    !["SHARED", "AI", "HUMAN"].includes(slot.audience))) return "invalid";
  return own[0] ?? shared[0] ?? null;
}

export function validDefinition(def: WrapperDefinition, slot: WrapperSlot): boolean {
  return def.id === slot.definitionId && slot.definition.id === slot.definitionId &&
    Number.isSafeInteger(slot.editVersion) && slot.editVersion > 0 &&
    def.kind === "MODA_CONVERSATION_WRAPPER" && def.audience === slot.audience &&
    ["SHARED", "AI", "HUMAN"].includes(slot.audience as WrapperAudience) &&
    def.status === "PUBLISHED" && def.publishedAt instanceof Date &&
    Number.isFinite(def.publishedAt.getTime()) && def.retiredAt === null &&
    Boolean(def.createdByAdminId) && def.sourceLanguageTag === "en" &&
    def.astSchemaVersion === 1 && /^[a-f0-9]{64}$/.test(def.sourceHash);
}

export function languageChoices(input: {
  conversationTag: string | null;
  merchantTag: string | null;
  preferredTag: string | null | undefined;
  platformFallbackTag: string | null;
}, onInvalid?: (error: unknown) => void): string[] | "invalid" {
  let customer: string | null;
  let merchant: string | null;
  let caller: string | null;
  let platform: string | null;
  try {
    customer = canonicalTag(input.conversationTag);
    merchant = canonicalTag(input.merchantTag);
    caller = canonicalTag(input.preferredTag);
    platform = canonicalTag(input.platformFallbackTag);
  } catch (error) { onInvalid?.(error); return "invalid"; }
  if ((input.conversationTag && !customer) || (input.merchantTag && !merchant) ||
      (input.preferredTag && !caller) || (input.platformFallbackTag && !platform)) return "invalid";
  // The stored conversation language is authoritative. Caller cannot override it.
  if (caller && customer && caller !== customer) return "invalid";
  const choices: string[] = [];
  const add = (tag: string | null) => { if (tag && !choices.includes(tag)) choices.push(tag); };
  add(customer ?? caller);
  const base = customer ?? caller;
  if (base) {
    try { add(new Intl.Locale(base).language); } catch (error) { onInvalid?.(error); return "invalid"; }
  }
  add(merchant);
  add(platform);
  return choices;
}
