import { structuredFinalizationInstructions } from "./structured-finalization-instructions.js";
import type { CommerceResponseContract } from "@modainteract/moda-interact-shared/commerce";
import type { ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";
import { RECOVERY_INSTRUCTIONS } from "./recovery-instructions.js";
export const RECOVERY_TERMINAL_PHASE_INSTRUCTION = "This is the required application completion phase. Choose exactly one currently advertised completion tool and supply only its schema fields. Earlier finalResponse/envelope formatting directions describe the canonical decision validated by the host, not extra arguments for these tools. For recovery_complete_details or recovery_complete_options supply only selectedPairs: exact relevant productId/variantId identities from authorized current observations. The application renders verified facts/options in the already-resolved language, with no generated evidence or new language detection. Use rich combined tools when their additional wording, shipping, evidence or new language detection fields are needed, including a clearly changed customer language; preserve existing language detection rules and never invent regional subtags. Preserve every pinned business rule, required referral, discount inspection/authority, shipping qualification and current-turn identity restriction. Never invent identifiers, facts or promotions, and do not make further discovery calls.";
/** Only known application formatting guidance is replaced. Pinned business,
 * platform, shop, security, language and ordinary discovery instructions stay. */
export function recoveryTerminalPhaseRequest(request: ModelRequest, applicationFormatting: readonly string[]): ModelRequest {
  if (!request.requireToolCall || !request.tools.some(tool => tool.name.startsWith("recovery_complete_"))) return request;
  const formatting = new Set(applicationFormatting);
  return { ...request, instructions: [...request.instructions.filter(instruction => !formatting.has(instruction)).map(instruction =>
    RECOVERY_INSTRUCTIONS.some(owned => owned === instruction) ? instruction.replace("after finalResponse", "after terminal completion") : instruction), RECOVERY_TERMINAL_PHASE_INSTRUCTION] };
}

/** The production host and isolated probe use this same owned formatting list. */
export function recoveryTerminalModelRequest(request: ModelRequest, pinnedContract: CommerceResponseContract): ModelRequest {
  return recoveryTerminalPhaseRequest(request, structuredFinalizationInstructions(pinnedContract));
}
