// Keep structured-log environment identity aligned with the shared OpenTelemetry
// resource resolver. Render test and production both run with NODE_ENV=production,
// so NODE_ENV alone is not a deployment-environment discriminator.
export {
  resolveDeploymentEnvironmentName,
} from "@modainteract/moda-interact-shared/observability/node";
