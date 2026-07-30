import { createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const FORMAT_VERSION = 1;
const ACTIONS = ["session", "upload", "metadata", "schema", "query", "delete", "feedback", "mcp"] as const;
const OUTCOMES = ["ok", "error"] as const;
const LATENCIES = ["lt10ms", "10to49ms", "50to199ms", "200to999ms", "1splus"] as const;

type ProductAction = typeof ACTIONS[number];
type ProductOutcome = typeof OUTCOMES[number];
type ProductLatency = typeof LATENCIES[number];

export interface ProductTelemetryInput {
  tenantId: string;
  action: ProductAction;
  outcome: ProductOutcome;
  status: "2xx" | "3xx" | "4xx" | "5xx";
  durationMs: number;
  mode?: string;
}

interface ProductEvent {
  v: typeof FORMAT_VERSION;
  day: string;
  tenant: string;
  action: ProductAction;
  outcome: ProductOutcome;
  status: ProductTelemetryInput["status"];
  latency: ProductLatency;
  mode?: string;
}

export interface ProductTelemetrySummary {
  formatVersion: number;
  events: number;
  invalidLines: number;
  activeTenants: number;
  repeatUploadTenants: number;
  byDay: Record<string, number>;
  byAction: Record<string, number>;
  byOutcome: Record<string, number>;
  byStatus: Record<string, number>;
  byLatency: Record<string, number>;
  queryModes: Record<string, number>;
}
export interface TenantProductUsage {
  events: number;
  successfulUploads: number;
  queries: number;
  schemaReads: number;
  mcpRequests: number;
  errors: number;
}


function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function latencyBucket(durationMs: number): ProductLatency {
  if (durationMs < 10) return "lt10ms";
  if (durationMs < 50) return "10to49ms";
  if (durationMs < 200) return "50to199ms";
  if (durationMs < 1_000) return "200to999ms";
  return "1splus";
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function parseEvent(line: string): ProductEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (event.v !== FORMAT_VERSION
    || typeof event.day !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(event.day)
    || typeof event.tenant !== "string"
    || !/^[0-9a-f]{24}$/.test(event.tenant)
    || !includes(ACTIONS, event.action)
    || !includes(OUTCOMES, event.outcome)
    || !includes(["2xx", "3xx", "4xx", "5xx"] as const, event.status)
    || !includes(LATENCIES, event.latency)
    || (event.mode !== undefined && typeof event.mode !== "string")) return null;
  return event as unknown as ProductEvent;
}

function tenantHash(hashKey: string, tenantId: string): string {
  return createHmac("sha256", hashKey).update(tenantId).digest("hex").slice(0, 24);
}

function emptyTenantUsage(): TenantProductUsage {
  return {
    events: 0,
    successfulUploads: 0,
    queries: 0,
    schemaReads: 0,
    mcpRequests: 0,
    errors: 0,
  };
}

export class ProductTelemetry {
  private pending: Promise<void>;
  private readonly tenantUsage = new Map<string, TenantProductUsage>();

  constructor(
    readonly path: string,
    private readonly hashKey: string,
    private readonly reportError: (error: Error) => void = () => undefined,
  ) {
    this.pending = this.loadTenantUsage().catch((error: unknown) => this.report(error));
  }

  record(input: ProductTelemetryInput): void {
    const event: ProductEvent = {
      v: FORMAT_VERSION,
      day: new Date().toISOString().slice(0, 10),
      tenant: tenantHash(this.hashKey, input.tenantId),
      action: input.action,
      outcome: input.outcome,
      status: input.status,
      latency: latencyBucket(Math.max(0, input.durationMs)),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    };
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(this.path, 0o600);
      this.addToTenantUsage(event);
    }).catch((error: unknown) => this.report(error));
  }

  flush(): Promise<void> {
    return this.pending;
  }

  async summarizeTenant(tenantId: string): Promise<TenantProductUsage> {
    await this.pending;
    return {
      ...(this.tenantUsage.get(tenantHash(this.hashKey, tenantId)) ?? emptyTenantUsage()),
    };
  }

  private async loadTenantUsage(): Promise<void> {
    const input = createReadStream(this.path, { encoding: "utf8" });
    try {
      const lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.length === 0) continue;
        const event = parseEvent(line);
        if (event !== null) this.addToTenantUsage(event);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      input.destroy();
    }
  }

  private addToTenantUsage(event: ProductEvent): void {
    const usage = this.tenantUsage.get(event.tenant) ?? emptyTenantUsage();
    usage.events += 1;
    if (event.outcome === "error") usage.errors += 1;
    if (event.action === "upload" && event.outcome === "ok") usage.successfulUploads += 1;
    if (event.action === "query") usage.queries += 1;
    if (event.action === "schema") usage.schemaReads += 1;
    if (event.action === "mcp") usage.mcpRequests += 1;
    this.tenantUsage.set(event.tenant, usage);
  }

  private report(error: unknown): void {
    try {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Product telemetry must never affect a customer request.
    }
  }
}


export async function summarizeProductTelemetry(path: string): Promise<ProductTelemetrySummary> {
  const summary: ProductTelemetrySummary = {
    formatVersion: FORMAT_VERSION,
    events: 0,
    invalidLines: 0,
    activeTenants: 0,
    repeatUploadTenants: 0,
    byDay: {},
    byAction: {},
    byOutcome: {},
    byStatus: {},
    byLatency: {},
    queryModes: {},
  };
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return summary;
    throw error;
  }

  const tenants = new Set<string>();
  const uploads = new Map<string, number>();
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    const event = parseEvent(line);
    if (event === null) {
      summary.invalidLines += 1;
      continue;
    }
    summary.events += 1;
    tenants.add(event.tenant);
    increment(summary.byDay, event.day);
    increment(summary.byAction, event.action);
    increment(summary.byOutcome, event.outcome);
    increment(summary.byStatus, event.status);
    increment(summary.byLatency, event.latency);
    if (event.action === "upload" && event.outcome === "ok") {
      uploads.set(event.tenant, (uploads.get(event.tenant) ?? 0) + 1);
    }
    if (event.action === "query" && event.mode !== undefined) increment(summary.queryModes, event.mode);
  }
  summary.activeTenants = tenants.size;
  summary.repeatUploadTenants = [...uploads.values()].filter((count) => count >= 2).length;
  return summary;
}
