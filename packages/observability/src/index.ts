export type MetricLabels = Record<string, string>;

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { count: number; sum: number }>();

  increment(name: string, labels: MetricLabels = {}): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = metricKey(name, labels);
    const current = this.histograms.get(key) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += value;
    this.histograms.set(key, current);
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(formatMetric(key, String(value)));
    for (const [key, value] of this.histograms) {
      lines.push(formatMetric(key + "_count", String(value.count)));
      lines.push(formatMetric(key + "_sum", String(value.sum)));
    }
    return lines.length === 0 ? "# No metrics recorded\n" : lines.join("\n") + "\n";
  }
}

function metricKey(name: string, labels: MetricLabels): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error("Invalid metric name");
  const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return name + (sorted.length ? "|" + JSON.stringify(sorted) : "");
}

function formatMetric(key: string, value: string): string {
  const separator = key.indexOf("|");
  if (separator < 0) return key + " " + value;
  const labelsEnd = key.lastIndexOf("]");
  if (labelsEnd < separator) throw new Error("Invalid metric labels");
  const name = key.slice(0, separator) + key.slice(labelsEnd + 1);
  const labels = JSON.parse(key.slice(separator + 1, labelsEnd + 1)) as Array<[string, string]>;
  return name + "{" + labels.map(([label, content]) => label + "=\"" + escapeLabel(content) + "\"").join(",") + "} " + value;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}
