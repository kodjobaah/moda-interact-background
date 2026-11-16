import { beforeEach, describe, it, expect, vi } from 'vitest';
const authority = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn(), active: vi.fn() }));
vi.mock('../../../src/services/recovery-sender-pool/inbound-authority.js', () => ({
  resolveSenderInbound: authority.resolve, readAssignedOwner: authority.read,
  isAssignedConversationActive: authority.active,
}));
vi.mock('../../../src/lib/db.js', () => ({ default: {} }));
import { RecoveryRoutingService } from '../../../src/services/recovery-routing.service.js';
const event = { schemaVersion: 1, provider: 'whatsapp', providerAccountId: '9001', providerPhoneNumberId: '8001', providerMessageId: 'incoming', customerPhone: '447700900001', contextMessageId: null, occurredAt: new Date().toISOString(), content: { type: 'text', text: 'help' } } as const;
const evidence = { conversationId: 'c1', checkoutRecoveryId: 'r1', shopId: 's1', threadId: 't1', routeId: 'p1', canonicalRecipient: event.customerPhone, providerAccountId: event.providerAccountId, providerPhoneNumberId: event.providerPhoneNumberId };
function fixture() { const db = {} as never, execution = { isShopExecutionActive: vi.fn(async () => true) }; return { execution, service: new RecoveryRoutingService(db, execution) }; }
beforeEach(() => { vi.clearAllMocks(); authority.resolve.mockResolvedValue({ kind: 'invalid' }); authority.read.mockResolvedValue(evidence); authority.active.mockResolvedValue(true); });
describe('verified sender-pool router', () => {
  it.each(['active','historical'] as const)('returns immutable %s owner without singleton or recipient inference', async mode => {
    const f = fixture();authority.resolve.mockResolvedValue({kind:'owned',evidence,mode});
    expect(await f.service.resolveInboundMessage(event)).toEqual({kind:'resolved',conversationId:'c1',checkoutRecoveryId:'r1',shopId:'s1',mode,senderEvidence:evidence});
    expect(f.execution.isShopExecutionActive).toHaveBeenCalledWith('s1',mode==='active'?'recovery':'general');
  });
  it('passes unresolved verified scope to durable router',async()=>{
    const f=fixture(),scope={...evidence,routeId:null};authority.resolve.mockResolvedValue({kind:'routing',scope});
    expect(await f.service.resolveInboundMessage(event)).toEqual({kind:'routing',scope});
    expect(f.execution.isShopExecutionActive).not.toHaveBeenCalled();
  });
  it('unregistered or foreign sender cannot acquire conversation ownership even with a quote',async()=>{
    const f=fixture();expect(await f.service.resolveInboundMessage({...event,contextMessageId:'old'})).toEqual({kind:'ignored'});
    expect(f.execution.isShopExecutionActive).not.toHaveBeenCalled();
  });
  it('shop suspension prevents persistence independent of credit',async()=>{
    const f=fixture();authority.resolve.mockResolvedValue({kind:'owned',evidence,mode:'active'});
    f.execution.isShopExecutionActive.mockResolvedValue(false);
    expect(await f.service.resolveInboundMessage(event)).toEqual({kind:'ignored'});
  });
  it('active-route check requires the exact still-assigned sender and customer',async()=>{
    const f=fixture(),route={kind:'resolved' as const,conversationId:'c1',checkoutRecoveryId:'r1',shopId:'s1',mode:'active' as const,senderEvidence:evidence};
    expect(await f.service.isCurrentActiveRoute(route)).toBe(true);
    authority.read.mockResolvedValue({...evidence,providerPhoneNumberId:'foreign'});
    expect(await f.service.isCurrentActiveRoute(route)).toBe(false);
    expect(await f.service.isCurrentActiveRoute({...route,senderEvidence:undefined})).toBe(false);
  });
});
