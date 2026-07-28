import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiCredentialConfig } from "../config";

interface StoredCredential {
  tenantId: string;
  digest: Buffer;
}

export class ApiKeyAuthenticator {
  private readonly credentials: readonly StoredCredential[];

  constructor(credentials: readonly ApiCredentialConfig[]) {
    this.credentials = credentials.map(({ tenantId, secret }) => ({
      tenantId,
      digest: createHash("sha256").update(secret, "utf8").digest(),
    }));
  }

  authenticate(authorization: string | undefined): string | undefined {
    if (
      authorization === undefined ||
      authorization.slice(0, "Bearer ".length).toLowerCase() !== "bearer "
    ) {
      return undefined;
    }
    const token = authorization.slice("Bearer ".length);
    if (token.length === 0 || Buffer.byteLength(token, "utf8") > 512) return undefined;

    const candidate = createHash("sha256").update(token, "utf8").digest();
    let tenantId: string | undefined;
    for (const credential of this.credentials) {
      if (timingSafeEqual(candidate, credential.digest)) tenantId = credential.tenantId;
    }
    return tenantId;
  }
}
