export class EmptyUploadError extends Error {
  constructor() {
    super("Uploaded file is empty");
    this.name = "EmptyUploadError";
  }
}

export class InvalidFilenameError extends Error {
  constructor() {
    super("Uploaded filename is invalid");
    this.name = "InvalidFilenameError";
  }
}

export class InvalidQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQueryError";
  }
}

export class TenantStorageQuotaError extends Error {
  constructor() {
    super("Tenant retained-storage quota exceeded");
    this.name = "TenantStorageQuotaError";
  }
}

export class UnsupportedFileTypeError extends Error {
  constructor(filename: string) {
    super(`Unsupported file type for ${filename}`);
    this.name = "UnsupportedFileTypeError";
  }
}

export class UploadTooLargeError extends Error {
  constructor() {
    super("Upload exceeds the configured size limit");
    this.name = "UploadTooLargeError";
  }
}

export type ProcessFailureKind = "exit" | "output_limit" | "spawn" | "timeout";

export class SchemagrepProcessError extends Error {
  constructor(
    public readonly kind: ProcessFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "SchemagrepProcessError";
  }
}
