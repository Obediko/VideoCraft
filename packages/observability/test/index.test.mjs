import test from "node:test";
import assert from "node:assert/strict";
import { configureTracing, MetricsRegistry } from "../dist/index.js";

test("renders counters and bounded latency summaries", () => {
  const metrics = new MetricsRegistry();
  metrics.increment("videocraft_http_requests_total", { method: "GET", route: "/healthz", status: "200" });
  metrics.observe("videocraft_http_request_duration_ms", 12.5, { method: "GET", route: "/healthz" });
  const output = metrics.renderPrometheus();
  assert.match(output, /videocraft_http_requests_total\{method="GET",route="\/healthz",status="200"\} 1/);
  assert.match(output, /videocraft_http_request_duration_ms_count\{method="GET",route="\/healthz"\} 1/);
  assert.match(output, /videocraft_http_request_duration_ms_sum\{method="GET",route="\/healthz"\} 12.5/);
});


test("tracing is a no-op without an exporter endpoint", async () => {
  const runtime = configureTracing({ OTEL_SERVICE_NAME: "videocraft-test" });
  await runtime.shutdown();
});
