import 'dotenv/config'
import { configDefaults, defineConfig } from 'vitest/config'

const disposableIntegrationEnabled = process.env.MODA_DISPOSABLE_INTEGRATION === '1'

export default defineConfig({
  test: {
    environment: 'node',
    // The installed Shared runner normally loads through Node as an external
    // dependency. For disposable integration tests, transform it through
    // Vitest so mocks of its @langchain/openrouter constructor are effective.
    // Without this, the real SDK can bypass the test-only loopback baseURL.
    ...(disposableIntegrationEnabled ? {
      server: { deps: { inline: ['@modainteract/moda-interact-shared'] } },
    } : {}),
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: disposableIntegrationEnabled
      ? configDefaults.exclude
      : [...configDefaults.exclude, 'tests/integration/**'],
  },
})
