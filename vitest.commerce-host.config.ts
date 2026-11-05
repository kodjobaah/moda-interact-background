import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    env: { DEPLOYMENT_ENVIRONMENT_NAME: "test" },
    include: ["tests/integration/commerce/host.test.ts"],
    exclude: configDefaults.exclude,
    fileParallelism: false,
    server: { deps: { inline: ["@modainteract/moda-interact-shared"] } },
  },
});
