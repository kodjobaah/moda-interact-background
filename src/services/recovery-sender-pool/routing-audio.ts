import { createHash } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import type { PrismaClient } from '@prisma/client';
import prisma from '../../lib/db.js';
import type { WhatsAppInboundEvent } from '../../integration/whatsapp/types.js';
import { MAX_DURATION_MS } from '../inbound-whatsapp-audio.service.js';
import { platformConsumerConfiguration } from '../platform-configuration/consumers.js';
import { sha256 } from '../recovery-multipart/frozen.js';
import { readDispatchSenderSnapshot, type DispatchSenderSnapshot } from './dispatch-sender.js';
import { recipientDigits, type SenderHandoff } from './inbound-authority.js';
import {
  MAX_AUDIO_BYTES, whatsappMediaService, type DownloadedWhatsAppAudio, type FrozenWhatsAppMediaCredential,
} from '../whatsapp-media.service.js';
import { MAX_TRANSCRIPTION_CHARACTERS, transcriptionFilename, validateTranscriptionMedia, transcribeWithSpeechOperation, type FrozenSpeechOperation } from '../speech-transcription.service.js';

export type RoutingAudioOperation = Readonly<{
  sender: DispatchSenderSnapshot;
  mediaCredential: FrozenWhatsAppMediaCredential;
  speech: FrozenSpeechOperation;
  operationRows: readonly Readonly<{ id: string; version: number }>[];
}>;
export type RoutingAudioProvenance = Readonly<{
  schemaVersion: 1; verified: true; sourceSha256: string; providerMessageId: string;
  mediaIdSha256: string; mediaSha256: string | null; transcriptSha256: string;
  provider: string; model: string; durationMs: number;
  operationRows: readonly Readonly<{ id: string; version: number }>[];
}>;
export type RoutingAudioTranscript = Readonly<{text:string;provenance:RoutingAudioProvenance}>;
export type RoutingAudioPorts = Readonly<{
  readOperation(): Promise<RoutingAudioOperation>;
  assertCurrent(event: WhatsAppInboundEvent, scope: SenderHandoff, operation: RoutingAudioOperation): Promise<void>;
  download(mediaId: string, mimeType: string | null, credential: FrozenWhatsAppMediaCredential): Promise<DownloadedWhatsAppAudio>;
  duration(input: DownloadedWhatsAppAudio): Promise<number>;
  transcribe(input: DownloadedWhatsAppAudio, operation: FrozenSpeechOperation): Promise<{ text: string; provider: string; model: string }>;
}>;

async function readOperation(): Promise<RoutingAudioOperation> {
  // Protected readers decrypt/validate outside SQL; retain no secret in provenance.
  const sender = await readDispatchSenderSnapshot();
  const rows = await platformConsumerConfiguration.readBundle(['messaging.sender','speech.transcription','ai.providers']);
  const senderRow = rows['messaging.sender'];
  if (senderRow.rowId !== sender.rowId || senderRow.version !== sender.version || senderRow.value.businessAccountId !== sender.providerAccountId || senderRow.value.phoneNumberId !== sender.providerPhoneNumberId) throw new Error('ROUTING_AUDIO_CONFIGURATION_CHANGED');
  const policy = rows['speech.transcription'].value;
  const apiKey = policy.provider === 'openai' ? rows['ai.providers'].value.openAiApiKey : rows['ai.providers'].value.groqApiKey;
  if (!apiKey) throw new Error('ROUTING_AUDIO_CONFIGURATION_UNAVAILABLE');
  const operationRows = [senderRow,rows['speech.transcription'],rows['ai.providers']].map(row=>{
    if (!row.rowId || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error('ROUTING_AUDIO_CONFIGURATION_UNAVAILABLE');
    return {id:row.rowId,version:row.version};
  });
  return {sender,mediaCredential:{accessToken:senderRow.value.accessToken},speech:{provider:policy.provider,model:policy.provider === 'openai' ? policy.openaiModelId : policy.groqModelId,apiKey},operationRows};
}

/** A short read-only proof before and after every external operation; no SQL lock encloses network I/O. */
export async function assertCurrentRoutingAudio(db: Pick<PrismaClient,'$queryRawUnsafe'>, event: WhatsAppInboundEvent, scope: SenderHandoff, operation: RoutingAudioOperation): Promise<void> {
  if (event.providerAccountId !== scope.providerAccountId || event.providerPhoneNumberId !== scope.providerPhoneNumberId || recipientDigits(event.customerPhone) !== scope.canonicalRecipient || operation.sender.providerAccountId !== scope.providerAccountId || operation.operationRows.length !== 3 || new Set(operation.operationRows.map(row=>row.id)).size !== 3) throw new Error('ROUTING_AUDIO_SENDER_CHANGED');
  const rows = await db.$queryRawUnsafe<Array<{id:string}>>(`SELECT t.id
    FROM whatsapp."RecoverySenderThread" t
    JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=t."providerPhoneNumberId"
    WHERE t.id=$1 AND t."closedAt" IS NULL AND t."canonicalRecipient"=$2 AND t."providerPhoneNumberId"=$3
      AND s."providerAccountId"=$4 AND s."verifiedAt"<=statement_timestamp()
      AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM whatsapp."RecoverySenderRoute" r WHERE r.id=$5 AND r."threadId"=t.id AND r."canonicalRecipient"=t."canonicalRecipient" AND r."providerPhoneNumberId"=t."providerPhoneNumberId" AND r."closedAt" IS NULL))
      AND EXISTS (SELECT 1 FROM public."PlatformConfiguration" c WHERE c.id=$6 AND c.environment=$7 AND c.key='messaging.sender' AND c.version=$8)
      AND EXISTS (SELECT 1 FROM public."PlatformConfiguration" c WHERE c.id=$9 AND c.environment=$7 AND c.key='speech.transcription' AND c.version=$10)
      AND EXISTS (SELECT 1 FROM public."PlatformConfiguration" c WHERE c.id=$11 AND c.environment=$7 AND c.key='ai.providers' AND c.version=$12)`,
    scope.threadId,scope.canonicalRecipient,scope.providerPhoneNumberId,scope.providerAccountId,scope.routeId,
    operation.operationRows[0]!.id,operation.sender.environment,operation.operationRows[0]!.version,
    operation.operationRows[1]!.id,operation.operationRows[1]!.version,operation.operationRows[2]!.id,operation.operationRows[2]!.version);
  if (rows.length !== 1 || operation.operationRows[0]!.id !== operation.sender.rowId || operation.operationRows[0]!.version !== operation.sender.version) throw new Error('ROUTING_AUDIO_CONFIGURATION_OR_SCOPE_CHANGED');
}

const defaultPorts: RoutingAudioPorts = {
  readOperation,
  assertCurrent:(event,scope,operation)=>assertCurrentRoutingAudio(prisma,event,scope,operation),
  download:(mediaId,mimeType,credential)=>whatsappMediaService.downloadAudio(mediaId,mimeType,credential),
  duration:async input=>Math.round(((await parseBuffer(input.bytes,{mimeType:input.mimeType})).format.duration ?? 0)*1000),
  transcribe:transcribeWithSpeechOperation,
};

/** Returns authentic verified transcript evidence only; the routing owner stores and moderates it under its existing lease.
 * sourceSha256 must come from whatsapp.arch076_r15_audio_source_sha256 on the persisted inputJson.
 * JavaScript object serialization is deliberately not a substitute for that durable proof. */
export async function prepareRoutingAudio(event: WhatsAppInboundEvent, scope: SenderHandoff, sourceSha256: string, overrides: Partial<RoutingAudioPorts> = {}): Promise<RoutingAudioTranscript> {
  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('ROUTING_AUDIO_DURABLE_SOURCE_HASH_REQUIRED');
  if (event.content.type !== 'audio') throw new Error('ROUTING_AUDIO_REQUIRED');
  const ports = {...defaultPorts,...overrides};
  const operation = await ports.readOperation();
  await ports.assertCurrent(event,scope,operation);
  const downloaded = await ports.download(event.content.mediaId,event.content.mimeType,{...operation.mediaCredential,assertCurrent:()=>ports.assertCurrent(event,scope,operation)});
  await ports.assertCurrent(event,scope,operation);
  if (!downloaded.bytes.byteLength || downloaded.bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('ROUTING_AUDIO_MEDIA_SIZE_INVALID');
  validateTranscriptionMedia(downloaded);
  if (event.content.mimeType && transcriptionFilename(event.content.mimeType) !== transcriptionFilename(downloaded.mimeType)) throw new Error('ROUTING_AUDIO_MEDIA_TYPE_CHANGED');
  const mediaDigest = createHash('sha256').update(downloaded.bytes).digest();
  if (event.content.sha256 && event.content.sha256 !== mediaDigest.toString('base64') && event.content.sha256.toLowerCase() !== mediaDigest.toString('hex')) throw new Error('ROUTING_AUDIO_MEDIA_HASH_MISMATCH');
  const durationMs = await ports.duration(downloaded);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) throw new Error('ROUTING_AUDIO_DURATION_INVALID');
  await ports.assertCurrent(event,scope,operation);
  const transcript = await ports.transcribe(downloaded,operation.speech);
  await ports.assertCurrent(event,scope,operation);
  if (!transcript.text.trim() || transcript.text.length > MAX_TRANSCRIPTION_CHARACTERS || transcript.provider !== operation.speech.provider || transcript.model !== operation.speech.model) throw new Error('ROUTING_AUDIO_TRANSCRIPT_INVALID');
  return {text:transcript.text,provenance:{schemaVersion:1,verified:true,sourceSha256,providerMessageId:event.providerMessageId,mediaIdSha256:sha256(event.content.mediaId),mediaSha256:event.content.sha256 ?? null,transcriptSha256:sha256(transcript.text),provider:transcript.provider,model:transcript.model,durationMs,operationRows:operation.operationRows.map(row=>({...row}))}};
}
