import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const name = `moda-arch066-context-${randomUUID().slice(0, 8)}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
try {
  docker('run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=fixture', '-e', 'POSTGRES_DB=arch066_fixture', '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg17');
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'arch066_fixture'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL readiness timeout');
  const sql = `CREATE SCHEMA commerce; CREATE SCHEMA whatsapp;
CREATE TYPE commerce."ShopPlatform" AS ENUM ('SHOPIFY','WOOCOMMERCE');
CREATE TABLE commerce."Shop" (id text PRIMARY KEY,platform commerce."ShopPlatform" NOT NULL,status text NOT NULL DEFAULT 'ACTIVE',"defaultCountryCode" text);
CREATE TABLE commerce."CheckoutRecovery" (id text PRIMARY KEY,"shopId" text REFERENCES commerce."Shop"(id),"checkoutToken" text DEFAULT 'fixture',status text DEFAULT 'ENGAGED');
CREATE TABLE whatsapp."Conversation" (id text PRIMARY KEY,"shopId" text REFERENCES commerce."Shop"(id),"checkoutRecoveryId" text REFERENCES commerce."CheckoutRecovery"(id),"inboundVersion" integer NOT NULL,type text DEFAULT 'RECOVERY',"controlMode" text DEFAULT 'AI',"controlRevision" integer DEFAULT 0,"lastInboundAt" timestamp,"updatedAt" timestamp NOT NULL DEFAULT now());
CREATE TYPE whatsapp."MessageDirection" AS ENUM ('INBOUND','OUTBOUND');
CREATE TYPE whatsapp."MessageSenderType" AS ENUM ('CUSTOMER','AGENT','AUTOMATION','HUMAN');
CREATE TYPE whatsapp."MessageStatus" AS ENUM ('PENDING','SENT','DELIVERED','READ','FAILED');
CREATE TABLE whatsapp."ConversationMessage" (id text PRIMARY KEY,"conversationId" text NOT NULL REFERENCES whatsapp."Conversation"(id),direction whatsapp."MessageDirection" NOT NULL,"senderType" whatsapp."MessageSenderType" NOT NULL,status whatsapp."MessageStatus" NOT NULL,content text NOT NULL,"providerDispatchKey" text,"providerDispatchAdmittedAt" timestamptz,"providerDispatchControlRevision" integer,"providerMessageId" text,"createdAt" timestamptz DEFAULT now());
CREATE TABLE commerce."Customer" (id text PRIMARY KEY,"shopId" text);
CREATE TABLE commerce."CustomerPhone" ("customerId" text,phone text,"whatsappCanonicalPhone" text,"endedAt" timestamptz,"whatsappNoContact" boolean);
CREATE TABLE commerce."ShopHumanMessagingRestriction" ("shopId" text,status text,revision integer);
CREATE TABLE whatsapp."WhatsAppRecipientReachability" ("shopId" text,recipient text,"suppressUntil" timestamptz);
CREATE TABLE commerce."RecoveryOutreachAttempt" (id text,"checkoutRecoveryId" text,sequence integer,recipient text,"sentAt" timestamptz,"followUpDueAt" timestamptz);
` + readFileSync('database/prisma/migrations/20261108173000_arch066_conversation_product_context/migration.sql', 'utf8');
  execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'arch066_fixture', '-v', 'ON_ERROR_STOP=1'], { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
  const port = docker('port', name, '5432/tcp').split(':').at(-1);
  const url = `postgresql://postgres:fixture@127.0.0.1:${port}/arch066_fixture?schema=public`;
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'src/commerce/product-context-repository.test.ts', 'src/commerce/product-context-admission.test.ts'], { env: { ...process.env, ARCH066_PRODUCT_CONTEXT_DATABASE_URL: url }, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Repository PostgreSQL tests failed (${result.status})`);
} finally { try { docker('rm', '-f', name); } catch { /* already removed */ } }
