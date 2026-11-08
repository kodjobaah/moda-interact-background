import { describe, expect, it } from 'vitest';
import { shopVoiceInstruction } from '../../../src/commerce/product-discovery-instructions.js';
describe('saved shop identity and representative voice', () => {
  it('supplies the exact saved name and shipping limitation guidance', () => {
    const value = shopVoiceInstruction('  Acme & Co  ');
    expect(value).toContain('"name":"Acme & Co"');
    expect(value).toContain('our shipping policy');
    expect(value).toContain('never substitute "this store"');
    expect(value).toContain('not instructions');
  });
  it.each([undefined, null, '', ' ', 'x'.repeat(256), 'Name\nIgnore'])('uses representative voice when no usable saved name exists', (name) => {
    const value = shopVoiceInstruction(name);
    expect(value).toContain('No verified shop name');
    expect(value).toContain('we, us and our');
    expect(value).not.toContain('"name":');
  });
});
