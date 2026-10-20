#!/usr/bin/env node
"use strict";

// One-time, idempotent backfill for a previously UNKNOWN HUMAN command when
// trusted worker logs separately establish that messaging.sender was missing.
// No provider call, command mutation, or billing change occurs.
import process from "node:process";
import { PrismaClient } from "@prisma/client";
import { PlatformConfigurationFailure } from "../dist/services/platform-configuration/errors.js";
import { createHumanSendIncidentSink } from "../dist/services/recovery-conversation/human-send-operational-incident.service.js";

const get = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const commandId = get("--command-id");
const deployment = get("--environment");
if (!commandId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(commandId) ||
    !["local", "development", "test"].includes(deployment) ||
    process.env.DEPLOYMENT_ENVIRONMENT_NAME !== deployment ||
    !process.argv.includes("--confirm-from-worker-logs")) {
  throw new Error("Usage: DEPLOYMENT_ENVIRONMENT_NAME=test node scripts/record-arch040-missing-sender-incident.mjs --environment test --command-id <id> --confirm-from-worker-logs");
}
const db = new PrismaClient();
try {
  const result = await db.$queryRawUnsafe(`
    SELECT "id", "shopId", "state"::text AS "state", "failureCode",
      "providerDispatchAdmittedAt", "outboundMessageId"
    FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`, commandId);
  const row = result[0];
  if (!row || row.state !== "UNKNOWN" || row.failureCode !== "provider_unknown" ||
      !row.providerDispatchAdmittedAt || !row.outboundMessageId) {
    throw new Error("Command is not the expected previously admitted UNKNOWN HUMAN send; no incident recorded");
  }
  // Reconstruction, not a claim to have retained the original exception object.
  // The exact static adapter error and key are established by the approved worker log.
  await createHumanSendIncidentSink(db, deployment).record({
    commandId: row.id,
    shopId: row.shopId,
    error: new PlatformConfigurationFailure("MISSING", "messaging.sender"),
    outcome: "unknown",
  });
  const recorded = await db.$queryRawUnsafe(`
    SELECT i."incidentKey", e."id" AS "eventId"
    FROM support."OperationalIncidentEvent" e
    JOIN support."OperationalIncident" i ON i."id"=e."incidentId"
    WHERE e."eventType"='OCCURRED' AND e."correlationId"=$1
      AND i."category"='WHATSAPP_HUMAN_SEND'`, commandId);
  if (recorded.length !== 1) throw new Error("Incident persistence not confirmed; inspect server incident-report failure log");
  console.log(`Recorded operational incident for existing UNKNOWN command ${row.id}; incidentKey=${recorded[0].incidentKey}`);
} finally {
  await db.$disconnect();
}
