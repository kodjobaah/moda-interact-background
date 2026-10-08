import type { TranslationProviderBatch } from "../../providers/translation.provider.js";

export type TranslationProviderPollCallbacks<
  ReadFailureResult,
  NonterminalResult,
  CompletedResult,
  TerminalResult,
> = {
  retrieve(): Promise<TranslationProviderBatch>;
  onReadFailure(error: unknown): Promise<ReadFailureResult>;
  onNonterminal(batch: TranslationProviderBatch): Promise<NonterminalResult>;
  onCompleted(batch: TranslationProviderBatch): Promise<CompletedResult>;
  onTerminal(batch: TranslationProviderBatch): Promise<TerminalResult>;
};

export async function pollTranslationProviderBatch<
  ReadFailureResult,
  NonterminalResult,
  CompletedResult,
  TerminalResult,
>(
  callbacks: TranslationProviderPollCallbacks<
    ReadFailureResult,
    NonterminalResult,
    CompletedResult,
    TerminalResult
  >,
): Promise<
  ReadFailureResult | NonterminalResult | CompletedResult | TerminalResult
> {
  let batch: TranslationProviderBatch;
  try {
    batch = await callbacks.retrieve();
  } catch (error) {
    return callbacks.onReadFailure(error);
  }

  if (batch.status === "nonterminal") {
    return callbacks.onNonterminal(batch);
  }
  if (batch.status === "completed") {
    return callbacks.onCompleted(batch);
  }
  return callbacks.onTerminal(batch);
}

export {
  translationItemRetryDisposition as translationTerminalItemDisposition,
  type TranslationItemRetryDisposition as TranslationTerminalItemDisposition,
} from "./item-retry.js";
