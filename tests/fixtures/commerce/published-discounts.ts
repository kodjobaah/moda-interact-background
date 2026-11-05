import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DISCOUNT_POLICY_OPERATION_DESCRIPTORS, InputSchemaSchema, deduplicateTools,
  exampleManifest, type CommerceManifest } from '@modainteract/moda-interact-shared/commerce';

export function publishedDiscountDescriptors() {
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== 'object') return value;
    const source = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$schema' && key !== 'default'));
    if (Array.isArray(source.anyOf) && source.anyOf.length === 2 && source.anyOf.some(part => part.type === 'null')) {
      const other = source.anyOf.find(part => part.type !== 'null'); delete source.anyOf;
      return project({ ...source, ...other, type: [other.type, 'null'] });
    }
    return Object.fromEntries(Object.entries(source).map(([key, child]) => [key, project(child)]));
  };
  return DISCOUNT_POLICY_OPERATION_DESCRIPTORS.map(operation => ({ name: operation.toolName,
    description: operation.description, inputSchema: InputSchemaSchema.parse(project(z.toJSONSchema(operation.inputValidator, { io: 'input' }))) }));
}
export function appendPublishedDiscounts(manifest: CommerceManifest): CommerceManifest {
  const featureId = manifest.featureBehaviours[0]?.featureId ?? 'feature-product-search';
  if (!manifest.featureBehaviours.length) manifest.featureBehaviours.push({ featureId, behaviourPrompt: 'Product Search' });
  const offset = Math.max(-1, ...manifest.capabilities.map(cap => cap.position)) + 1;
  for (const [index, descriptor] of publishedDiscountDescriptors().entries()) manifest.capabilities.push({
    capabilityId: `capability-discount-${index}`, key: descriptor.name, featureId, position: offset + index,
    toolDescriptor: { ...descriptor, toolId: `tool-discount-${index}`, toolRevisionId: `revision-discount-${index}-3`, definitionVersion: '3.0.0' },
  });
  manifest.builtInTools = [];
  manifest.selectedCapabilityKeys = manifest.capabilities.map(cap => cap.key);
  manifest.grantedTools = deduplicateTools(manifest.capabilities, []).sort((a, b) =>
    manifest.capabilities.findIndex(cap => cap.toolDescriptor.toolId === ("toolId" in a ? a.toolId : "")) -
    manifest.capabilities.findIndex(cap => cap.toolDescriptor.toolId === ("toolId" in b ? b.toolId : "")));
  return manifest;
}
export function publishedManifest(tools = publishedDiscountDescriptors()) {
  const manifest = exampleManifest(text => createHash('sha256').update(text).digest('hex'), false);
  const featureId = 'feature-product-search';
  manifest.featureBehaviours = [{ featureId, behaviourPrompt: 'Product Search' }];
  manifest.capabilities = tools.map((descriptor, index) => ({ capabilityId: `capability-${index}`, key: descriptor.name,
    featureId, position: index, toolDescriptor: { ...descriptor, inputSchema: InputSchemaSchema.parse(descriptor.inputSchema),
      toolId: `tool-${index}`, toolRevisionId: `revision-${index}`,
      definitionVersion: descriptor.name.startsWith('commerce_get_discount_') ? '3.0.0' : '1.0.0' } }));
  manifest.selectedCapabilityKeys = manifest.capabilities.map(cap => cap.key);
  manifest.grantedTools = deduplicateTools(manifest.capabilities, []);
  return manifest;
}
