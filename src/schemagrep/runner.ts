import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, type TransformCallback } from "node:stream";
import { SchemagrepProcessError } from "../files/errors";

const MAX_STDERR_BYTES = 64 * 1024;

class OutputLimitTransform extends Transform {
  bytesWritten = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytesWritten += buffer.byteLength;

    if (this.bytesWritten > this.limit) {
      callback(new SchemagrepProcessError("output_limit", "schemagrep output exceeded its limit"));
      return;
    }

    callback(null, buffer);
  }
}

export interface SchemagrepProcessor {
  encode(sourcePath: string, outputPath: string): Promise<number>;
  schema(sourcePath: string, outputPath: string): Promise<number>;
}

export interface SchemagrepRunnerOptions {
  binaryPath: string;
  timeoutMs: number;
  maxArtifactBytes: number;
  maxSchemaBytes: number;
}

export class SchemagrepRunner implements SchemagrepProcessor {
  constructor(private readonly options: SchemagrepRunnerOptions) {}

  encode(sourcePath: string, outputPath: string): Promise<number> {
    return this.runToFile(["encode", sourcePath], outputPath, this.options.maxArtifactBytes);
  }

  schema(sourcePath: string, outputPath: string): Promise<number> {
    return this.runToFile(["schema", sourcePath], outputPath, this.options.maxSchemaBytes);
  }

  private async runToFile(args: readonly string[], outputPath: string, maxBytes: number): Promise<number> {
    const child = spawn(this.options.binaryPath, args, {
      cwd: undefined,
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: process.env.PATH ?? "",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const limiter = new OutputLimitTransform(maxBytes);

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.byteLength >= MAX_STDERR_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = Buffer.concat([stderr, buffer.subarray(0, MAX_STDERR_BYTES - stderr.byteLength)]);
    });

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    const output = pipeline(
      child.stdout,
      limiter,
      createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
    );
    output.catch(() => child.kill("SIGKILL"));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, this.options.timeoutMs);
    timeout.unref();

    try {
      const [result] = await Promise.all([exit, output]);

      if (timedOut) {
        throw new SchemagrepProcessError("timeout", "schemagrep exceeded its execution timeout");
      }
      if (result.code !== 0) {
        const detail = stderr.toString("utf8").trim();
        throw new SchemagrepProcessError(
          "exit",
          detail.length > 0 ? `schemagrep failed: ${detail}` : `schemagrep exited with code ${result.code}`,
        );
      }

      return limiter.bytesWritten;
    } catch (error) {
      child.kill("SIGKILL");
      await exit.catch(() => undefined);

      if (timedOut) {
        throw new SchemagrepProcessError("timeout", "schemagrep exceeded its execution timeout");
      }
      if (error instanceof SchemagrepProcessError) throw error;
      throw new SchemagrepProcessError(
        "spawn",
        error instanceof Error ? error.message : "Unable to execute schemagrep",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
