import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface TracingEnvironment {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_SERVICE_NAME?: string;
}

export interface TracingRuntime {
  shutdown(): Promise<void>;
}

export function configureTracing(environment: TracingEnvironment = process.env): TracingRuntime {
  const endpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return { shutdown: async () => {} };

  const serviceName = environment.OTEL_SERVICE_NAME?.trim() || "videocraft-api";
  process.env.OTEL_SERVICE_NAME = serviceName;
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return {
    shutdown: async () => { await sdk.shutdown(); },
  };
}
