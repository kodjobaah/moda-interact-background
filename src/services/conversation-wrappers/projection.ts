import { createHash } from "node:crypto";
import { readPreparedWrapper as sharedReadPreparedWrapper } from "@modainteract/moda-interact-shared/commerce/presentation";
export { stableJson } from "@modainteract/moda-interact-shared/commerce/presentation";
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const readPreparedWrapper = (localeAst: unknown, contentHash: string | null) => sharedReadPreparedWrapper(localeAst, contentHash, digest);
