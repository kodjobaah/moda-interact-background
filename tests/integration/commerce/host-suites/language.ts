import { describe, expect, it } from "vitest";
import { hostFixture as f } from "../host.fixture.js";

export function registerLanguageHostTests() {
  describe("Commerce host language signals and referrals", () => {
it("A1 legacy preference does not block substantive recovery language detection", async () => {
    f.state.languageTag = "fr";
    f.state.languageSource = "CUSTOMER_EXPLICIT";
    await expect(
      f.run(async () =>
        f.final({ detectedLanguageTag: "en", detectedLanguageConfidence: 0.99 }),
      ),
    ).resolves.toMatchObject({ detectedLanguageTag: "en" });
  });

it("logs model language candidates and unstable-input rejection without customer text", async () => {
    f.state.languageTag = "fr";
    f.state.languageSource = "DETECTED";
    const altered = structuredClone(f.context);
    altered.conversation.messages = [{ role: "user", content: "👍" }];
    const records: Array<Record<string, unknown>> = [];
    const logger = f.createLogger({
      serviceName: "moda-messaging-worker",
      environment: f.environment,
      sink: (record) => records.push(record as unknown as Record<string, unknown>),
    });

    const result = await f.run(
      async () =>
        f.final({ detectedLanguageTag: "en", detectedLanguageConfidence: 0.99 }),
      altered,
      undefined,
      logger,
    );

    expect(result).toMatchObject({
      detectedLanguageTag: null,
      detectedLanguageConfidence: null,
    });
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "whatsapp.language.detection_received",
          data: expect.objectContaining({
            conversationId: "conversation-fixture",
            observedVersion: 1,
            currentLanguageTag: "fr",
            detectedLanguageTag: "en",
            detectedLanguageConfidence: 0.99,
          }),
        }),
        expect.objectContaining({
          event: "whatsapp.language.detection_rejected",
          data: expect.objectContaining({
            conversationId: "conversation-fixture",
            observedVersion: 1,
            reason: "unstable-input",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("👍");
  });

it("P07/P08/P09/P12 preserves validated language metadata and null fallback", async () => {
    f.state.languageTag = "fr";
    f.state.languageSource = "DETECTED";
    expect(
      await f.run(async () =>
        f.final({
          answerKind: "ANSWER",
          referralReason: null,
          replyText: "Le total historique est 10.00.",
          detectedLanguageTag: "fr",
          detectedLanguageConfidence: 0.95,
        }),
      ),
    ).toMatchObject({
      detectedLanguageTag: "fr",
      detectedLanguageConfidence: 0.95,
    });
    expect(await f.run(async () => f.final())).toMatchObject({
      detectedLanguageTag: null,
      detectedLanguageConfidence: null,
    });
  });

it("P06 renders the verified referral in explicit French without using model contacts", async () => {
  f.state.languageTag = "fr";
  f.state.languageSource = "CUSTOMER_EXPLICIT";
  const result = await f.run(async () =>
    f.final({ replyText: "Contact attacker.invalid" }),
  );
  expect(result.replyText).toContain("Veuillez contacter");
  expect(result.replyText).toContain("fixture.myshopify.com");
  expect(result.replyText).not.toContain("attacker");
});

it.each(["ok", "12345", "https://example.com", "👍"])("A1-L06 ambiguous %s returns null detection despite model guess",async(content)=>{
 f.state.languageTag="fr";f.state.languageSource="DETECTED";
 const altered=structuredClone(f.context); altered.conversation.messages=[{role:"user",content}];
 const result=await f.run(async()=>f.final({detectedLanguageTag:"en",detectedLanguageConfidence:0.99}),altered);
 expect(result).toMatchObject({detectedLanguageTag:null,detectedLanguageConfidence:null});
 expect(result.replyText).toContain("Veuillez contacter");
});
  });
}
