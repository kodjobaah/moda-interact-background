import {
  canonicalJson, CommerceManifestSchema, deduplicateTools, isBuiltInTool,
  type CommerceManifest,
} from '@modainteract/moda-interact-shared/commerce';
import { CommerceHostError } from './mcp-client.js';

/** Shared validates wire contracts; this host admits published identities only.
 * Reused tools are valid when every capability pins the same descriptor. */
export function assertPublishedManifest(manifest: CommerceManifest): void {
  if (!CommerceManifestSchema.safeParse(manifest).success || manifest.builtInTools.length ||
      manifest.grantedTools.some(isBuiltInTool)) throw new CommerceHostError('INCOMPATIBLE_VERSION');
  try {
    const sortedGrants = [...manifest.grantedTools].sort((a, b) => a.toolName.localeCompare(b.toolName, "en"));
    if (canonicalJson(deduplicateTools(manifest.capabilities, [])) !== canonicalJson(sortedGrants) ||
        canonicalJson(manifest.selectedCapabilityKeys) !== canonicalJson(manifest.capabilities.map(cap => cap.key))) {
      throw new Error('Published selection mismatch');
    }
    const identities = new Map<string, string>();
    for (const capability of manifest.capabilities) {
      const descriptor = capability.toolDescriptor;
      const identity = canonicalJson(descriptor);
      const previous = identities.get(descriptor.name);
      if (previous && previous !== identity) throw new Error('Conflicting published name');
      identities.set(descriptor.name, identity);
      if (descriptor.name === 'commerce_get_discount_options' || descriptor.name === 'commerce_get_discount_details') {
        if (capability.key !== descriptor.name || descriptor.definitionVersion !== '3.0.0' ||
            manifest.capabilities.filter(cap => cap.toolDescriptor.name === descriptor.name).length !== 1) {
          throw new Error('Canonical discount identity mismatch');
        }
      }
    }
  } catch { throw new CommerceHostError('INCOMPATIBLE_VERSION'); }
}

/** tools/list advertises capability keys, while the runner uses tool names. */
export function publishedToolEntries(manifest: CommerceManifest) {
  assertPublishedManifest(manifest);
  return manifest.capabilities.map(cap => ({ capability: cap, descriptor: {
    name: cap.key, description: cap.toolDescriptor.description, inputSchema: cap.toolDescriptor.inputSchema,
  } }));
}

export function assertPublishedToolList(manifest: CommerceManifest,
  listed: readonly { name: string; description?: string | undefined; inputSchema: unknown }[]): void {
  const expected = publishedToolEntries(manifest);
  if (listed.length !== expected.length || new Set(listed.map(tool => tool.name)).size !== listed.length ||
      expected.some(({ descriptor }) => !listed.some(tool => tool.name === descriptor.name &&
        typeof tool.description === "string" && tool.description.length <= 4000 &&
        canonicalJson(tool.inputSchema) === canonicalJson(descriptor.inputSchema)))) {
    throw new CommerceHostError('DENIED');
  }
}
