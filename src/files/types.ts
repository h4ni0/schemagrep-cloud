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
  ingest(source: UploadSource): Promise<PublicFileRecord>;
  get(id: string): Promise<PublicFileRecord | undefined>;
  readSchema(id: string): Promise<string | undefined>;
  delete(id: string): Promise<boolean>;
  close(): Promise<void>;
}
