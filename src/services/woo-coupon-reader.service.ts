import { WooCouponPageTransport } from "../providers/woo-coupon-transport.js";
import { readAllWooCouponPages } from "../providers/woo-coupon-pages.js";
import { WooCouponGrantService } from "./woo-coupon-grant.service.js";
import { loadWooCouponSyncConfig, type WooCouponSyncConfig } from "./woo-coupon-sync-config.js";

/** Read-only full scan. No catalogue writes or worker activation in Attempt 2. */
export class WooCouponReaderService {
  constructor(
    private readonly grants: WooCouponGrantService = new WooCouponGrantService(),
    private readonly transport: WooCouponPageTransport = new WooCouponPageTransport(),
    private readonly settings: WooCouponSyncConfig = loadWooCouponSyncConfig(),
  ) {}

  async fetchAll(shopId: string): Promise<Record<string, unknown>[]> {
    return this.grants.withAuthorizedRead(shopId, (site, credentials) =>
      readAllWooCouponPages((page, perPage) => this.transport.readPage(site, credentials, page, perPage), this.settings.maxPages, this.settings.maxScanDurationMs));
  }
}
