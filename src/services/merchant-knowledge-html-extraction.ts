import { parse } from "parse5";

const IGNORED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
]);

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "dl",
  "dt",
  "dd",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

interface ParsedNode {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedNode[];
}

function isHidden(node: ParsedNode): boolean {
  return node.attrs?.some(
    ({ name, value }) =>
      name === "hidden" || (name === "aria-hidden" && value.toLowerCase() === "true"),
  ) ?? false;
}

export function extractVisibleHtmlText(html: string): string {
  const document = parse(html) as unknown as ParsedNode;
  const output: string[] = [];
  let lastCharacter = "";

  const boundary = () => {
    if (output.length > 0 && lastCharacter !== "\n") {
      output.push("\n");
      lastCharacter = "\n";
    }
  };

  const visit = (node: ParsedNode): void => {
    if (node.nodeName === "#text") {
      if (node.value) {
        output.push(node.value);
        lastCharacter = node.value.at(-1) ?? lastCharacter;
      }
      return;
    }

    const name = node.nodeName.toLowerCase();
    if (IGNORED_ELEMENTS.has(name) || isHidden(node)) return;

    const isBlock = BLOCK_ELEMENTS.has(name);
    if (isBlock) boundary();
    for (const child of node.childNodes ?? []) visit(child);
    if (isBlock) boundary();
  };

  visit(document);
  return output.join("");
}

export function decodeMerchantKnowledgeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}