# Basic Shopify shop name refresh

The recovery worker independently scans active installed Shopify shops in keyset order, including shops without a ShopBrand row. Each five-minute sweep inspects at most 500 shops and claims at most 20 reads, with two concurrent reads. A durable per-shop two-minute lease arbitrates replicas; successful names refresh after 24 hours. Transient failures back off for 1 minute, 5 minutes, 30 minutes, 2 hours and 24 hours (bounded Retry-After respected); permanent failures are reconsidered after 24 hours. Failed or stale reads never erase a known name.

Only authenticated Admin API 2026-07 `shop { name }` is requested. No `read_brand`, logo/media access, additional permission or per-message provider request is needed. The current selected-Shop-ID credential snapshot must match the claimed shop/domain before HTTP. Locked active platform/domain/installation identity is rechecked before durable writes; provider I/O never runs inside the transaction.

Only ShopBrand.brandName/fetchedAt and the existing whatsAppMedia JSON's shopifySourceSync lease/cadence metadata are written. Existing media roles/source state and concurrent media work remain intact. Shutdown waits for the bounded current sweep; no new queue, schema or Shared release is needed. This task acquires names only; message header composition is a separate task.
