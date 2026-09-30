import { describe, expect, it } from "vitest";

import {
  decodeMerchantKnowledgeUtf8,
  extractVisibleHtmlText,
} from "../../../src/services/merchant-knowledge-html-extraction.js";

describe("Merchant Knowledge HTML extraction", () => {
  it("extracts text in document order with block line boundaries", () => {
    expect(
      extractVisibleHtmlText(
        "<main><h1>About &amp; us</h1><p>First <b>important</b> paragraph.</p><div>Second</div></main>",
      ),
    ).toBe("About & us\nFirst important paragraph.\nSecond\n");
  });

  it("excludes active, hidden, and aria-hidden subtrees", () => {
    const html = `
      <p>Visible</p><script>secret()</script><style>.secret {}</style>
      <noscript>fallback secret</noscript><template>template secret</template>
      <iframe>frame secret</iframe><svg><text>svg secret</text></svg>
      <canvas>canvas secret</canvas><div hidden>hidden secret</div>
      <section aria-hidden="true">aria secret</section><p>After</p>
    `;
    const extracted = extractVisibleHtmlText(html);
    expect(extracted).toContain("Visible");
    expect(extracted).toContain("After");
    for (const secret of [
      "secret()",
      ".secret",
      "fallback secret",
      "template secret",
      "frame secret",
      "svg secret",
      "canvas secret",
      "hidden secret",
      "aria secret",
    ]) {
      expect(extracted).not.toContain(secret);
    }
  });

  it("does not fetch relative subresources and preserves source text spacing", () => {
    const extracted = extractVisibleHtmlText(
      '<link rel="stylesheet" href="/style.css"><img src="/image.png"><p>A  B</p><script src="/app.js"></script>',
    );
    expect(extracted).toBe("A  B\n");
  });

  it("decodes malformed UTF-8 with replacement without normalization", () => {
    expect(decodeMerchantKnowledgeUtf8(Buffer.from([0x41, 0xff, 0x0d, 0x0a]))).toBe(
      "A�\r\n",
    );
  });
});