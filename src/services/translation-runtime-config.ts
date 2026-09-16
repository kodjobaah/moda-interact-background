import {
  backgroundRuntimeConfigService,
  type BackgroundRuntimeConfigSnapshot,
} from "../runtime/background-runtime-config.js";

export type TranslationRuntimeConfigReader = {
  current(): BackgroundRuntimeConfigSnapshot;
};

export function currentTranslationRuntimeConfig(
  reader: TranslationRuntimeConfigReader = backgroundRuntimeConfigService,
): BackgroundRuntimeConfigSnapshot {
  return reader.current();
}