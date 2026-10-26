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
      // All integration files share one disposable PostgreSQL/Redis instance.
      // Global due-command scans must not claim another file's active fixture;
      // race tests still exercise concurrency explicitly within each file.
      fileParallelism: false,
      server: { deps: { inline: ['@modainteract/moda-interact-shared'] } },
    } : {}),
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: disposableIntegrationEnabled
      ? configDefaults.exclude
      : [...configDefaults.exclude, 'tests/integration/**'],
  },
})
