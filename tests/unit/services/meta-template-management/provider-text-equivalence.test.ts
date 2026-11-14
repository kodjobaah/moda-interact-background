import {describe,it,expect} from 'vitest';
import {observedContentHash,type MetaComponent} from '../../../../src/services/meta-template-management/contracts.js';
import {metaNbspEquivalenceEvidence} from '../../../../src/services/meta-template-management/provider-text-equivalence.js';
const expected=[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'Boutique\u00a0: Exemple\nPanier\u00a0: {{1}}'}];
const observed=[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'Boutique : Exemple\nPanier : {{1}}'}];
const evidence={normalizationKind:'U+00A0_TO_U+0020_TEXT_ONLY',rawObservedContentHash:'f6ee4fc0dc11c3ce77ca934eeb477841aa498dd00858a85d371e64219c8841cd',expectedContentHash:'e17121a73dfea9c4202119663c50d123ff20f30f0b9d0d8158464c18d5741c77'};
describe('Meta display-only NBSP equivalence',()=>{
 it('pins shared Admin golden hashes without changing raw hash algorithm or immutable inputs',()=>{
  const before=structuredClone({expected,observed});expect(observedContentHash(expected)).toBe(evidence.expectedContentHash);expect(observedContentHash(observed)).toBe(evidence.rawObservedContentHash);
  expect(metaNbspEquivalenceEvidence(expected,observed)).toEqual(evidence);expect({expected,observed}).toEqual(before);
  expect(metaNbspEquivalenceEvidence(expected,expected)).toBeNull();
 });
 it.each(['HEADER','BODY','FOOTER'])('normalizes only known %s display text leaves',type=>{
  const left=[{type,...(type==='HEADER'?{format:'TEXT'}:{}),text:'Texte\u00a0: {{1}}'}],right=[{...left[0],text:'Texte : {{1}}'}];expect(metaNbspEquivalenceEvidence(left,right)).not.toBeNull();
 });
 it.each(['URL','QUICK_REPLY','PHONE_NUMBER'])('preserves %s button identity/target while comparing display label',type=>{
  const left=[{type:'BUTTONS',buttons:[{type,text:'Voir\u00a0: panier',url:'https://example.test/{{1}}',phone_number:'+12345678'}]}];
  const right=structuredClone(left);right[0]!.buttons[0]!.text='Voir : panier';expect(metaNbspEquivalenceEvidence(left,right)).not.toBeNull();
  right[0]!.buttons[0]!.url='https://other.test/{{1}}';expect(metaNbspEquivalenceEvidence(left,right)).toBeNull();
 });
 const changes=['Boutique : Autre\nPanier : {{1}}','Boutique  : Exemple\nPanier : {{1}}','Boutique\t: Exemple\nPanier : {{1}}','Boutique\u202f: Exemple\nPanier : {{1}}','Boutique : Exemple\r\nPanier : {{1}}','boutique : Exemple\nPanier : {{1}}','Boutique : Exemple\nPanier : {{2}}'];
 it.each(changes)('does not generalize whitespace/content/placeholders %s',text=>{expect(metaNbspEquivalenceEvidence(expected,[{type:'HEADER',format:'IMAGE'},{type:'BODY',text}])).toBeNull();});
 it.each([
  [[{type:'BODY',text:'Lien https://example.test/a\u00a0b'}],[{type:'BODY',text:'Lien https://example.test/a b'}]],
  [[{type:'BODY',text:'Parametre {{\u00a01}}'}],[{type:'BODY',text:'Parametre {{ 1}}'}]],
  [[{type:'BUTTONS',buttons:[{type:'URL',text:'Texte\u00a0: test',url:'https://example.test/a\u00a0b'}]}],[{type:'BUTTONS',buttons:[{type:'URL',text:'Texte : test',url:'https://example.test/a b'}]}]],
  [[{type:'UNKNOWN',text:'Texte\u00a0: test'}],[{type:'UNKNOWN',text:'Texte : test'}]],
  [[{type:'HEADER',format:'IMAGE',text:'Texte\u00a0: test'}],[{type:'HEADER',format:'IMAGE',text:'Texte : test'}]],
  [[{type:'BODY',text:'Texte\u00a0: test',id:'a\u00a0b'}],[{type:'BODY',text:'Texte : test',id:'a b'}]],
 ])('refuses URL/parameter/unsupported-path ambiguity and identity changes', (left,right)=>{expect(metaNbspEquivalenceEvidence(left as MetaComponent[],right as MetaComponent[])).toBeNull();});
 it('retains existing example exclusion and rejects oversized normalization',()=>{
  expect(metaNbspEquivalenceEvidence([{...expected[1],example:{body_text:[['one']]}}],[{...observed[1],example:{body_text:[['two']]}}])).not.toBeNull();
  expect(metaNbspEquivalenceEvidence([{type:'BODY',text:'x'.repeat(4096)+'\u00a0'}],[{type:'BODY',text:'x'.repeat(4096)+' '}])).toBeNull();
 });
});
