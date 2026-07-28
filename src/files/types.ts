import type { Readable } from "node:stream";

export type SupportedCodec = "csv" | "json" | "jsonl" | "log";

export interface PublicFileRecord {
  id: string;
  status: "ready";
  codec: SupportedCodec;
  originalName: string;
  sourceBytes: number;
  schemaBytes: number;
  createdAt: string;
  expiresAt: string;
}

export interface StoredFileRecord extends PublicFileRecord {
  ownerId: string;
  directory: string;
  artifactPath: string;
  schemaPath: string;
}

export interface UploadSource {
  filename: string;
  stream: Readable;
  wasTruncated: () => boolean;
}

export interface FileService {
  ingest(source: UploadSource, ownerId: string): Promise<PublicFileRecord>;
  get(id: string, ownerId: string): Promise<PublicFileRecord | undefined>;
  readSchema(id: string, ownerId: string): Promise<string | undefined>;
  delete(id: string, ownerId: string): Promise<boolean>;
  close(): Promise<void>;
}
