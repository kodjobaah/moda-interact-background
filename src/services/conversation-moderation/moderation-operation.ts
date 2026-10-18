/** ARCH-043 owns the only database-backed moderation policy and provider-credential reader.
 * Read fresh for each moderation operation; never fall back to legacy process.env
 * model, endpoint or OPENAI_API_KEY values.
 */
import { platformConsumerConfiguration } from "../platform-configuration/consumers.js";
import type { BackgroundPlatformConfigurationService } from "../platform-configuration/service.js";

export type ModerationOperation = Awaited<ReturnType<
  BackgroundPlatformConfigurationService["requireModerationOperation"]
>>;
export type ModerationOperationReader = () => Promise<ModerationOperation>;

export const readModerationOperation: ModerationOperationReader = () =>
  platformConsumerConfiguration.requireModerationOperation();
