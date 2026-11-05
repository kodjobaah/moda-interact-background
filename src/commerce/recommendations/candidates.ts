export function buildReplyCandidates(input: {
  fullBody: string;
  firstProductBody?: string | null;
  minimalBody: string;
}): readonly string[] {
  const candidates: string[] = [];
  for (const body of [input.fullBody, input.firstProductBody ?? null, input.minimalBody]) {
    if (typeof body !== "string" || !body.trim() || body.length > 4096 || candidates.includes(body)) continue;
    candidates.push(body);
  }
  if (!candidates.includes(input.minimalBody) && input.minimalBody.trim() && input.minimalBody.length <= 4096) {
    candidates.push(input.minimalBody);
  }
  return Object.freeze(candidates);
}
