// Composition only: all executable host scenarios live in focused suite modules.
import { registerAiMockHostTests } from "./host-suites/ai-mock.js";
import { registerLiveBudgetHostTests } from "./host-suites/budgets.js";
import { registerLifecycleHostTests } from "./host-suites/lifecycle.js";
import { registerGrantHostTests } from "./host-suites/grants.js";
import { registerAuthorityHostTests } from "./host-suites/authority.js";
import { registerLanguageHostTests } from "./host-suites/language.js";
import { registerMcpDiagnosticsHostTests } from "./host-suites/diagnostics.js";
import { registerEvidenceHostTests } from "./host-suites/evidence.js";

registerAiMockHostTests();
registerLiveBudgetHostTests();
registerLifecycleHostTests();
registerGrantHostTests();
registerAuthorityHostTests();
registerLanguageHostTests();
registerMcpDiagnosticsHostTests();
registerEvidenceHostTests();
