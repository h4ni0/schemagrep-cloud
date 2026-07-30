import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import type { Adapter, AdapterPayload } from "oidc-provider";

interface StoredModel {
  id: string;
  payload: AdapterPayload;
  createdAt: number;
  expiresAt: number;
  activeClient?: boolean;
  accountId?: string;
  lastActiveAt?: number;
}

const MAX_PENDING_CLIENTS = 100;
const MAX_ACTIVE_CLIENTS_PER_ACCOUNT = 20;
const MAX_MODEL_RECORDS = 5000;
const MAX_OWNER_RECORDS = 500;
const PENDING_CLIENT_TTL_SECONDS = 60 * 60;
const ACTIVE_CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_MODEL_TTL_SECONDS = 60 * 60;
const RECORD_MAX_BYTES = 1024 * 1024;

const CLIENT_ACTIVITY_WRITE_INTERVAL_MS = 60_000;
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordFilename(id: string): string {
  return `${createHash("sha256").update(id).digest("hex")}.json`;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

class PersistentModelStore {
  private readonly records = new Map<string, StoredModel>();
  private readonly directory: string;
  private initialization: Promise<void> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(storageDirectory: string, modelName: string) {
    const directoryName = createHash("sha256").update(modelName).digest("hex");
    this.directory = join(storageDirectory, "models", directoryName);
  }

  async mutate<T>(operation: (records: Map<string, StoredModel>) => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(async () => {
      await this.ensureInitialized();
      return operation(this.records);
    });
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async set(record: StoredModel): Promise<void> {
    await writeAtomic(
      join(this.directory, recordFilename(record.id)),
      `${JSON.stringify(record)}\n`,
    );
    this.records.set(record.id, record);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
    await rm(join(this.directory, recordFilename(id)), { force: true });
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= this.initialize();
    await this.initialization;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      const path = join(this.directory, entry.name);
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      try {
        const stat = await lstat(path);
        if (stat.size > RECORD_MAX_BYTES) {
          await rm(path, { force: true });
          continue;
        }
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (
          !isObject(parsed) ||
          typeof parsed.id !== "string" ||
          entry.name !== recordFilename(parsed.id) ||
          !isObject(parsed.payload) ||
          typeof parsed.createdAt !== "number" ||
          !Number.isFinite(parsed.createdAt) ||
          typeof parsed.expiresAt !== "number" ||
          !Number.isFinite(parsed.expiresAt) ||
          (parsed.activeClient !== undefined && typeof parsed.activeClient !== "boolean") ||
          (parsed.accountId !== undefined && typeof parsed.accountId !== "string") ||
          (parsed.lastActiveAt !== undefined && typeof parsed.lastActiveAt !== "number")
        ) {
          await rm(path, { force: true });
          continue;
        }
        if (parsed.expiresAt <= now) {
          await rm(path, { force: true });
          continue;
        }
        this.records.set(parsed.id, parsed as unknown as StoredModel);
      } catch {
        await rm(path, { force: true });
      }
    }
  }
}

export class PersistentOAuthAdapterRepository {
  private readonly stores = new Map<string, PersistentModelStore>();

  constructor(private readonly storageDirectory: string) {}

  store(name: string): PersistentModelStore {
    let store = this.stores.get(name);
    if (store === undefined) {
      store = new PersistentModelStore(this.storageDirectory, name);
      this.stores.set(name, store);
    }
    return store;
  }
}

export class PersistentOAuthAdapter implements Adapter {
  private readonly store: PersistentModelStore;
  private readonly modelName: string;
  private readonly namespace: string;

  constructor(name: string, private readonly repository: PersistentOAuthAdapterRepository) {
    this.store = repository.store(name);
    const separator = name.lastIndexOf(":");
    this.namespace = separator < 0 ? "" : name.slice(0, separator + 1);
    this.modelName = name.slice(separator + 1);
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    const now = Date.now();
    await this.store.mutate(async (records) => {
      await this.pruneExpired(records, now);
      const existing = records.get(id);
      if (existing === undefined) await this.makeRoom(records, payload);
      const dynamicClient = this.modelName === "Client";
      const ttlSeconds = expiresIn ??
        (dynamicClient
          ? existing?.activeClient === true ? ACTIVE_CLIENT_TTL_SECONDS : PENDING_CLIENT_TTL_SECONDS
          : DEFAULT_MODEL_TTL_SECONDS);
      await this.store.set({
        id,
        payload: structuredClone(payload),
        createdAt: existing?.createdAt ?? now,
        expiresAt: now + ttlSeconds * 1000,
        ...(existing?.activeClient === true ? { activeClient: true } : {}),
        ...(existing?.accountId === undefined ? {} : { accountId: existing.accountId }),
        ...(existing?.lastActiveAt === undefined ? {} : { lastActiveAt: existing.lastActiveAt }),
      });
    });
    if (this.recordsClientActivity(payload)) {
      await this.markClientActive(
        String(payload.clientId),
        now,
        typeof payload.accountId === "string" ? payload.accountId : undefined,
      );
    }
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const now = Date.now();
    const payload = await this.store.mutate(async (records) => {
      const record = records.get(id);
      if (record === undefined) return undefined;
      if (record.expiresAt <= now) {
        await this.store.delete(id);
        return undefined;
      }
      return structuredClone(record.payload);
    });
    if (payload !== undefined && this.recordsClientActivity(payload)) {
      await this.markClientActive(
        String(payload.clientId),
        now,
        typeof payload.accountId === "string" ? payload.accountId : undefined,
      );
    }
    return payload;
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findBy("userCode", userCode);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findBy("uid", uid);
  }

  async consume(id: string): Promise<void> {
    await this.store.mutate(async (records) => {
      const record = records.get(id);
      if (record === undefined) return;
      record.payload.consumed = Math.floor(Date.now() / 1000);
      await this.store.set(record);
    });
  }

  async destroy(id: string): Promise<void> {
    await this.store.mutate(async () => this.store.delete(id));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.store.mutate(async (records) => {
      const ids = [...records]
        .filter(([, record]) => record.payload.grantId === grantId)
        .map(([id]) => id);
      await Promise.all(ids.map((id) => this.store.delete(id)));
    });
  }

  private async makeRoom(records: Map<string, StoredModel>, payload: AdapterPayload): Promise<void> {
    if (this.modelName === "Client") {
      while (this.countRecords(records, (record) => record.activeClient !== true) >= MAX_PENDING_CLIENTS) {
        await this.evictOldest(records, (record) => record.activeClient !== true);
      }
      return;
    }
    const owner = typeof payload.accountId === "string"
      ? `account:${payload.accountId}`
      : typeof payload.clientId === "string"
        ? `client:${payload.clientId}`
        : undefined;
    if (owner !== undefined) {
      const owned = (record: StoredModel): boolean => {
        const recordOwner = typeof record.payload.accountId === "string"
          ? `account:${record.payload.accountId}`
          : typeof record.payload.clientId === "string"
            ? `client:${record.payload.clientId}`
            : undefined;
        return recordOwner === owner;
      };
      while (this.countRecords(records, owned) >= MAX_OWNER_RECORDS) {
        await this.evictOldest(records, owned);
      }
    }
    while (records.size >= MAX_MODEL_RECORDS) await this.evictOldest(records, () => true);
  }

  private countRecords(
    records: Map<string, StoredModel>,
    predicate: (record: StoredModel) => boolean,
  ): number {
    let count = 0;
    for (const record of records.values()) {
      if (predicate(record)) count += 1;
    }
    return count;
  }

  private async evictOldest(
    records: Map<string, StoredModel>,
    predicate: (record: StoredModel) => boolean,
  ): Promise<void> {
    let oldest: { id: string; createdAt: number } | undefined;
    for (const [id, record] of records) {
      if (!predicate(record)) continue;
      if (oldest === undefined || record.createdAt < oldest.createdAt) {
        oldest = { id, createdAt: record.createdAt };
      }
    }
    if (oldest !== undefined) await this.store.delete(oldest.id);
  }

  private async evictLeastRecentlyActive(
    clientsStore: PersistentModelStore,
    clients: Map<string, StoredModel>,
    predicate: (record: StoredModel) => boolean,
  ): Promise<void> {
    let leastRecent: { id: string; timestamp: number } | undefined;
    for (const [id, record] of clients) {
      if (!predicate(record)) continue;
      const timestamp = record.lastActiveAt ?? record.createdAt;
      if (leastRecent === undefined || timestamp < leastRecent.timestamp) {
        leastRecent = { id, timestamp };
      }
    }
    if (leastRecent !== undefined) await clientsStore.delete(leastRecent.id);
  }

  private async markClientActive(
    clientId: string,
    now: number,
    accountId: string | undefined,
  ): Promise<void> {
    const clientsStore = this.repository.store(`${this.namespace}Client`);
    await clientsStore.mutate(async (clients) => {
      for (const [id, record] of clients) {
        if (record.expiresAt <= now) await clientsStore.delete(id);
      }
      const client = clients.get(clientId);
      if (client === undefined) return;
      const owner = accountId ?? client.accountId ?? "unknown";
      if (client.activeClient !== true) {
        const sameAccount = (record: StoredModel): boolean =>
          record.activeClient === true && (record.accountId ?? "unknown") === owner;
        while (this.countRecords(clients, sameAccount) >= MAX_ACTIVE_CLIENTS_PER_ACCOUNT) {
          await this.evictLeastRecentlyActive(clientsStore, clients, sameAccount);
        }
      }
      if (
        client.activeClient === true &&
        client.lastActiveAt !== undefined &&
        now - client.lastActiveAt < CLIENT_ACTIVITY_WRITE_INTERVAL_MS
      ) {
        return;
      }
      client.activeClient = true;
      client.accountId = owner;
      client.lastActiveAt = now;
      client.expiresAt = now + ACTIVE_CLIENT_TTL_SECONDS * 1000;
      await clientsStore.set(client);
    });
  }

  private recordsClientActivity(payload: AdapterPayload): boolean {
    return typeof payload.clientId === "string" &&
      ["AuthorizationCode", "AccessToken", "RefreshToken"].includes(this.modelName);
  }

  private async pruneExpired(records: Map<string, StoredModel>, now: number): Promise<void> {
    for (const [id, record] of records) {
      if (record.expiresAt <= now) await this.store.delete(id);
    }
  }

  private async findBy(
    field: "uid" | "userCode",
    value: string,
  ): Promise<AdapterPayload | undefined> {
    const now = Date.now();
    const payload = await this.store.mutate(async (records) => {
      await this.pruneExpired(records, now);
      for (const record of records.values()) {
        if (record.payload[field] === value) return structuredClone(record.payload);
      }
      return undefined;
    });
    if (payload !== undefined && this.recordsClientActivity(payload)) {
      await this.markClientActive(
        String(payload.clientId),
        now,
        typeof payload.accountId === "string" ? payload.accountId : undefined,
      );
    }
    return payload;
  }
}
