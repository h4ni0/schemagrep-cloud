import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { extname } from "node:path";
import { SchemagrepProcessError } from "../files/errors";
import { bubblewrapIsolationArgs } from "./sandbox";

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

class BufferCollector extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  override toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export interface SchemagrepProcessor {
  encode(sourcePath: string, outputPath: string): Promise<number>;
  schema(artifactPath: string, outputPath: string): Promise<number>;
  query(artifactPath: string, args: readonly string[]): Promise<string>;
}

export type WorkerSandbox =
  | { mode: "disabled" }
  | { mode: "bwrap"; bubblewrapBinary: string };

interface ProcessInvocation {
  executable: string;
  args: string[];
}

export interface SchemagrepRunnerOptions {
  binaryPath: string;
  timeoutMs: number;
  maxArtifactBytes: number;
  maxSchemaBytes: number;
  maxQueryOutputBytes: number;
  sandbox: WorkerSandbox;
}

export class SchemagrepRunner implements SchemagrepProcessor {
  constructor(private readonly options: SchemagrepRunnerOptions) {}

  encode(sourcePath: string, outputPath: string): Promise<number> {
    return this.runToFile("encode", sourcePath, outputPath, this.options.maxArtifactBytes);
  }

  schema(artifactPath: string, outputPath: string): Promise<number> {
    return this.runToFile(
      "schema",
      artifactPath,
      outputPath,
      this.options.maxSchemaBytes,
      ["--encoded"],
    );
  }

  async query(artifactPath: string, args: readonly string[]): Promise<string> {
    const output = new BufferCollector();
    await this.runInvocation(
      this.buildInvocation("query", artifactPath, args),
      this.options.maxQueryOutputBytes,
      output,
    );
    return output.toString();
  }

  private buildInvocation(
    action: "encode" | "schema" | "query",
    inputPath: string,
    extraArgs: readonly string[] = [],
  ): ProcessInvocation {
    if (this.options.sandbox.mode === "disabled") {
      return { executable: this.options.binaryPath, args: [action, inputPath, ...extraArgs] };
    }

    const sandboxInput = `/input/data${extname(inputPath)}`;
    const args = [
      ...bubblewrapIsolationArgs(),
      "--dir",
      "/engine",
      "--dir",
      "/input",
    ];
    args.push(
      "--ro-bind",
      this.options.binaryPath,
      "/engine/schemagrep",
      "--ro-bind",
      inputPath,
      sandboxInput,
      "--tmpfs",
      "/tmp",
      "--dir",
      "/proc",
      "--dir",
      "/dev",
      "--chdir",
      "/tmp",
      "--setenv",
      "LANG",
      "C",
      "--setenv",
      "LC_ALL",
      "C",
      "--cap-drop",
      "ALL",
      "--",
      "/engine/schemagrep",
      action,
      sandboxInput,
      ...extraArgs,
    );
    return { executable: this.options.sandbox.bubblewrapBinary, args };
  }

  private runToFile(
    action: "encode" | "schema",
    inputPath: string,
    outputPath: string,
    maxBytes: number,
    extraArgs: readonly string[] = [],
  ): Promise<number> {
    return this.runInvocation(
      this.buildInvocation(action, inputPath, extraArgs),
      maxBytes,
      createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
    );
  }

  private async runInvocation(
    invocation: ProcessInvocation,
    maxBytes: number,
    destination: Writable,
  ): Promise<number> {
    const child = spawn(invocation.executable, invocation.args, {
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

    const output = pipeline(child.stdout, limiter, destination);
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
