import 'dotenv/config'
import { configDefaults, defineConfig } from 'vitest/config'

const disposableIntegrationEnabled = process.env.MODA_DISPOSABLE_INTEGRATION === '1'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: disposableIntegrationEnabled
      ? configDefaults.exclude
      : [...configDefaults.exclude, 'tests/integration/**'],
  },
})
