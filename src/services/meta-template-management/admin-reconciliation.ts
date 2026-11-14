import type { WhatsAppTemplateMetaEvent } from '@prisma/client';
import type { RegistrationWithLocale } from './repository.js';

export type AdminReconciliationRequest = Pick<WhatsAppTemplateMetaEvent,
 'id'|'registrationId'|'source'|'eventType'|'processedAt'|'wabaId'|'providerTemplateId'|'providerTemplateName'|'providerLanguageCode'|'requestDigest'>;
/** Existing persisted command identity, not permission to submit/create a template. */
export function adminReconciliationMatches(row: RegistrationWithLocale, request: AdminReconciliationRequest): boolean {
 return request.registrationId===row.id&&request.source==='ADMIN'&&request.eventType==='RECONCILE_REQUESTED'&&request.processedAt===null&&
  row.submissionState!=='READY_TO_SUBMIT'&&/^[a-f0-9]{64}$/i.test(row.submittedContentHash)&&
  row.locale.contentHash===row.submittedContentHash&&row.locale.providerLanguageCode===row.providerLanguageCode&&
  request.wabaId===row.wabaId&&request.providerTemplateId===row.providerTemplateId&&
  request.providerTemplateName===row.providerTemplateName&&request.providerLanguageCode===row.providerLanguageCode&&request.requestDigest===row.submittedContentHash;
}
