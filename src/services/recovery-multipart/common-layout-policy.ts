import { readCommonRecoveryLayoutReference, type CommonRecoveryLayoutReference, type PreparedWrapper } from '@modainteract/moda-interact-shared/commerce/presentation';
import { digest } from '../conversation-wrappers/projection.js';

/** Recovery business policy, separate from Shared's structural snapshot parser.
 * Both reviewed website positions are valid immutable authored sources. */
export function recoveryCommonLayoutPolicy(prepared: PreparedWrapper): boolean {
 const header = prepared.header;
 if (!prepared.footer.every(token => token.kind === 'text' && token.value === '') || prepared.conditionals.length !== 1) return false;
 if (!header.every(token => token.kind === 'text' || token.kind === 'variable' &&
   (token.name === 'shop.name' || token.name === 'shop.websiteUrl'))) return false;
 if (header.filter(token => token.kind === 'variable' && token.name === 'shop.name').length !== 1) return false;
 const conditional = prepared.conditionals[0]!;
 if (conditional.when !== 'checkout.available' || !conditional.tokens.every(token => token.kind === 'text' ||
   token.kind === 'variable' && (token.name === 'shop.websiteUrl' || token.name === 'checkout.url'))) return false;
 const websiteCount = [...header, ...conditional.tokens].filter(token => token.kind === 'variable' && token.name === 'shop.websiteUrl').length;
 const checkoutCount = conditional.tokens.filter(token => token.kind === 'variable' && token.name === 'checkout.url').length;
 const last = conditional.tokens.at(-1);
 if (websiteCount !== 1 || checkoutCount !== 1 || last?.kind !== 'variable' || last.name !== 'checkout.url') return false;
 // The mandatory trusted checkout URL is its own final line. No rendered-text
 // heuristics or authored-answer rewriting establish this token boundary.
 const prefix = conditional.tokens.slice(0, -1);
 let suffix = '';
 for (let index = prefix.length - 1; index >= 0 && prefix[index]?.kind === 'text'; index--) {
  const token = prefix[index]!; if (token.kind === 'text') suffix = token.value + suffix;
 }
 return prefix.length === 0 || suffix.endsWith('\n') || prefix.every(token => token.kind === 'text') && suffix === '';
}

/** A parsed reference is still not active-source or tenant authority. */
export function readRecoveryCommonReference(raw: unknown): {kind:'ok';reference:CommonRecoveryLayoutReference}|{kind:'invalid'} {
 const parsed = readCommonRecoveryLayoutReference(raw, digest);
 return parsed.kind === 'ok' && recoveryCommonLayoutPolicy(parsed.reference.prepared) ? parsed : {kind:'invalid'};
}
