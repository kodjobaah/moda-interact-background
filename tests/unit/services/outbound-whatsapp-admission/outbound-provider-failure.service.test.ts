import { describe, expect, it, vi } from "vitest";
import { OutboundProviderFailureService } from "../../../../src/services/outbound-whatsapp-admission/outbound-provider-failure.service.js";

const rejection = (code: string, providerCode?: string) => Object.assign(new Error("provider rejected"), {
  name: "WhatsAppServiceError", code, providerCode,
});

function fixture() {
  const database = {
    conversationMessage: { update: vi.fn(async () => ({})) },
    usageEvent: { deleteMany: vi.fn(async () => ({ count: 1 })) },
  };
  const correction = { afterAutomatedRejection: vi.fn(async () => undefined) };
  return { database, correction,
    subject: new OutboundProviderFailureService(database as never, correction) };
}

describe("ARCH-028-BACKGROUND-006 provider rejection adapter", () => {
  it("sends exact provider-rejected 131026 to correction without first deleting usage", async () => {
    const x = fixture();
    await x.subject.afterProviderError("m-1", "447700900001", rejection("provider-rejected", "131026"));
    expect(x.correction.afterAutomatedRejection).toHaveBeenCalledWith("m-1", "447700900001");
    expect(x.database.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(x.database.conversationMessage.update).not.toHaveBeenCalled();
  });

  it.each(["131027", "2", "10"])("does not suppress unrelated code %s", async (code) => {
    const x = fixture();
    await x.subject.afterProviderError("m-2", "447700900001", rejection("provider-rejected", code));
    expect(x.correction.afterAutomatedRejection).not.toHaveBeenCalled();
    expect(x.database.conversationMessage.update).toHaveBeenCalledWith({
      where: { id: "m-2" }, data: {
        status: "FAILED", failedAt: expect.any(Date), providerFailureCode: code,
      },
    });
    expect(x.database.usageEvent.deleteMany).toHaveBeenCalledOnce();
  });

  it("does not treat a network timeout or invalid response as a definitive rejection", async () => {
    const x = fixture();
    await x.subject.afterProviderError("m", "447700900001", new Error("socket timeout"));
    await x.subject.afterProviderError("m", "447700900001", rejection("invalid-provider-response", "131026"));
    await x.subject.afterProviderError("m", "447700900001", rejection("configuration-missing", "131026"));
    expect(x.correction.afterAutomatedRejection).not.toHaveBeenCalled();
    // configuration failure is definitive but must never create suppression
    expect(x.database.usageEvent.deleteMany).toHaveBeenCalledOnce();
  });

  it("keeps original definitive cleanup with no providerCode", async () => {
    const x = fixture();
    await x.subject.afterProviderError("m-3", "447700900001", rejection("provider-rejected"));
    expect(x.database.conversationMessage.update).toHaveBeenCalledWith({
      where: { id: "m-3" }, data: { status: "FAILED" },
    });
    expect(x.database.usageEvent.deleteMany).toHaveBeenCalledOnce();
  });
});
