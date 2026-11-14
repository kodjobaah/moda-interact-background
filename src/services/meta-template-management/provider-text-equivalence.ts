import { observedContentHash, type MetaComponent, type MetaTextEquivalenceEvidence } from './contracts.js';

/** Provider display-text policy only. No source, binding or hash format changes. */
function displayText(value: string): string | null {
  if (value.length > 4096) return null;
  // A NBSP inside/adjacent to a raw URL or inside a parameter is ambiguous:
  // refuse equivalence rather than reinterpret URL/placeholder bytes.
  if (/(?:\b[a-z][a-z\d+.-]*:\/\/|\bmailto:|\btel:)[^\t\r\n ]*\u00a0/i.test(value) ||
      /\{\{[^{}]*\u00a0[^{}]*\}\}/.test(value)) return null;
  return value.replaceAll('\u00a0', ' ');
}
function displayProjection(components: readonly MetaComponent[]): MetaComponent[] | null {
  if (components.length > 20) return null;
  const result: MetaComponent[] = [];
  for (const component of components) {
    const next = { ...component };
    if (component.type === 'BODY' || component.type === 'FOOTER' || component.type === 'HEADER' && component.format === 'TEXT') {
      if (typeof component.text === 'string') {
        const text = displayText(component.text); if (text === null) return null; next.text = text;
      }
    }
    if (component.type === 'BUTTONS' && Array.isArray(component.buttons)) {
      if (component.buttons.length > 20) return null;
      const buttons: unknown[] = [];
      for (const button of component.buttons) {
        if (!button || typeof button !== 'object' || Array.isArray(button)) return null;
        const nextButton = { ...button };
        if (['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(String(button.type)) && typeof button.text === 'string') {
          const text = displayText(button.text); if (text === null) return null; nextButton.text = text;
        }
        buttons.push(nextButton);
      }
      next.buttons = buttons;
    }
    result.push(next);
  }
  return result;
}

/** Keep the raw digest domain used by existing Admin/Shared selectors. Only a
 * proven display-text equivalence may use the frozen raw hash as representative. */
export function metaNbspEquivalenceEvidence(expected: MetaComponent[], observed: MetaComponent[]): MetaTextEquivalenceEvidence | null {
  const expectedContentHash = observedContentHash(expected), rawObservedContentHash = observedContentHash(observed);
  if (expectedContentHash === rawObservedContentHash) return null;
  const left = displayProjection(expected), right = displayProjection(observed);
  if (!left || !right || observedContentHash(left) !== observedContentHash(right)) return null;
  return { normalizationKind: 'U+00A0_TO_U+0020_TEXT_ONLY', rawObservedContentHash, expectedContentHash };
}
