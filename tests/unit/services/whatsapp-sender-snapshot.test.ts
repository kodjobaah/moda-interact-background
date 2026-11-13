import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {WhatsAppService} from "../../../src/services/whatsapp.service.js";

const {read} = vi.hoisted(() => ({read: vi.fn()}));
vi.mock("../../../src/services/platform-configuration/consumers.js", () => ({platformConsumerConfiguration: {read}}));
const sender = {providerAccountId: "account-a", providerPhoneNumberId: "phone-a"};
const configuration = {businessAccountId: sender.providerAccountId, phoneNumberId: sender.providerPhoneNumberId, accessToken: "token-a"};
const rotated = {businessAccountId: "account-b", phoneNumberId: "phone-b", accessToken: "token-b"};
afterEach(() => vi.unstubAllEnvs());
type Kind = "TEXT" | "IMAGE";
function send(service: WhatsAppService, kind: Kind, expectedSender?: typeof sender) {
  return kind === "TEXT"
    ? service.sendWhatsAppText({to: "15551234567", text: "Answer", expectedSender})
    : service.sendWhatsAppImage({to: "15551234567", link: "https://media.example/product.jpg", caption: "Answer", expectedSender});
}
function transport() {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({messages: [{id: "provider-receipt"}]}), {status: 200}));
}
describe.each<Kind>(["TEXT", "IMAGE"])("%s frozen sender identity", kind => {
  beforeEach(() => {vi.clearAllMocks(); read.mockReset(); vi.stubEnv("WHATSAPP_API_BASE_URL", "https://graph.example/v1");});
  it.each([
    {providerAccountId: "different-account", providerPhoneNumberId: sender.providerPhoneNumberId},
    {providerAccountId: sender.providerAccountId, providerPhoneNumberId: "different-phone"},
    {providerAccountId: "", providerPhoneNumberId: sender.providerPhoneNumberId},
  ])("refuses mismatched identity before any HTTP request: %j", async expected => {
    read.mockResolvedValue({value: configuration}); const fetch = transport();
    await expect(send(new WhatsAppService(fetch), kind, expected)).rejects.toMatchObject({code: "sender-mismatch"});
    expect(fetch).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
  });
  it("uses the same snapshot for identity, credentials and endpoint", async () => {
    read.mockResolvedValueOnce({value: configuration}).mockResolvedValueOnce({value: rotated}); const fetch = transport();
    await expect(send(new WhatsAppService(fetch), kind, sender)).resolves.toEqual({providerMessageId: "provider-receipt"});
    expect(read).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("https://graph.example/v1/phone-a/messages");
    const request = fetch.mock.calls[0]![1]!;
    expect(request.headers).toEqual({Authorization: "Bearer token-a", "Content-Type": "application/json"});
    expect(JSON.parse(request.body as string)).not.toHaveProperty("expectedSender");
  });
  it("refuses a sender rotated before the send snapshot", async () => {
    read.mockResolvedValue({value: rotated}); const fetch = transport();
    await expect(send(new WhatsAppService(fetch), kind, sender)).rejects.toMatchObject({code: "sender-mismatch"});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves legacy sends without a frozen sender", async () => {
    read.mockResolvedValue({value: rotated}); const fetch = transport();
    await expect(send(new WhatsAppService(fetch), kind)).resolves.toEqual({providerMessageId: "provider-receipt"});
    expect(fetch.mock.calls[0]![0]).toBe("https://graph.example/v1/phone-b/messages");
  });
});
