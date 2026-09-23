import { randomUUID } from "node:crypto";

export type MetricLabels = Readonly<Record<string, string>>;
type Counter = { value: number; labels: MetricLabels };

function labelsKey(labels: MetricLabels): string {
  return Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join(",");
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    const key = `${name}|${labelsKey(labels)}`;
    const current = this.counters.get(key);
    if (current) current.value += amount;
    else this.counters.set(key, { value: amount, labels });
  }
  snapshot(): string {
    const lines: string[] = [];
    for (const [key, counter] of this.counters) {
      const name = key.split("|", 1)[0]!;
      const labelText = Object.entries(counter.labels).map(([k, v]) => `${k}="${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(",");
      lines.push(`${name}${labelText ? `{${labelText}}` : ""} ${counter.value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export const metrics = new MetricsRegistry();

export function requestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}

/**
 * Emits only explicitly supplied scalar fields. Callers must never pass tokens, bytes, or OCR payloads. The filter also
 * drops `cookie`, `authorization` and `csrf` keys, so a session credential cannot reach `docker logs` by a slip of the
 * spread operator. An action therefore goes in the event **name**: a field named `password_reset` would be dropped.
 */
export function logEvent(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  const safe: Record<string, string | number | boolean> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (/(token|secret|password|credential|content|payload|raw|response|cookie|authorization|csrf)/i.test(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") safe[key] = value;
  }
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}
