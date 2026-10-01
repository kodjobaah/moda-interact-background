const UNICODE_WHITE_SPACE = /\p{White_Space}/u;

export function countMerchantKnowledgeCodePoints(value: string): number {
  let count = 0;
  for (const _codePoint of value) count += 1;
  return count;
}

export function merchantKnowledgeContentUnits(value: string): number {
  return Math.ceil(countMerchantKnowledgeCodePoints(value) / 4);
}

export function normalizeMerchantKnowledgeText(input: string): string {
  const lineNormalized = input.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const converted: string[] = [];
  for (const codePoint of lineNormalized) {
    converted.push(
      codePoint !== "\n" && UNICODE_WHITE_SPACE.test(codePoint) ? " " : codePoint,
    );
  }

  const collapsedSpaces: string[] = [];
  for (const codePoint of converted) {
    if (codePoint === " " && collapsedSpaces.at(-1) === " ") continue;
    collapsedSpaces.push(codePoint);
  }

  const lineCleaned: string[] = [];
  for (let index = 0; index < collapsedSpaces.length; index += 1) {
    const codePoint = collapsedSpaces[index];
    if (codePoint === undefined) continue;
    if (codePoint === "\n") {
      while (lineCleaned.at(-1) === " ") lineCleaned.pop();
      while (collapsedSpaces[index + 1] === " ") index += 1;
    }
    lineCleaned.push(codePoint);
  }

  const blankLinesCollapsed: string[] = [];
  let consecutiveLineFeeds = 0;
  for (const codePoint of lineCleaned) {
    if (codePoint === "\n") {
      consecutiveLineFeeds += 1;
      if (consecutiveLineFeeds > 2) continue;
    } else {
      consecutiveLineFeeds = 0;
    }
    blankLinesCollapsed.push(codePoint);
  }

  let start = 0;
  let end = blankLinesCollapsed.length;
  while (start < end && (blankLinesCollapsed[start] === " " || blankLinesCollapsed[start] === "\n")) start += 1;
  while (end > start && (blankLinesCollapsed[end - 1] === " " || blankLinesCollapsed[end - 1] === "\n")) end -= 1;
  return blankLinesCollapsed.slice(start, end).join("");
}