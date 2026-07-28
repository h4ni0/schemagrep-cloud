import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { WorkerSandboxMode } from "../config";
import { bubblewrapIsolationArgs } from "./sandbox";

const MAX_PROBE_OUTPUT_BYTES = 32 * 1024;
const REQUIRED_USAGE_MARKERS = ["schemagrep encode <file>", "schemagrep schema <file>"];

export async function assertSchemagrepBinary(binaryPath: string): Promise<void> {
  try {
    await access(binaryPath, constants.X_OK);
  } catch {
    throw new Error(
      `schemagrep engine is not executable at ${binaryPath}. ` +
        "Run `git submodule update --init --recursive && bun run setup-engine`, " +
        "or set SCHEMAGREP_BIN to the compiled hshei/schemagrep binary.",
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, [], {
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: process.env.PATH ?? "",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;

    const capture = (chunk: Buffer): void => {
      if (outputBytes >= MAX_PROBE_OUTPUT_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retained = buffer.subarray(0, MAX_PROBE_OUTPUT_BYTES - outputBytes);
      chunks.push(retained);
      outputBytes += retained.byteLength;
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5000);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Unable to start schemagrep engine at ${binaryPath}: ${error.message}`));
    });
    child.once("close", () => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`schemagrep engine probe timed out at ${binaryPath}`));
        return;
      }

      const output = Buffer.concat(chunks).toString("utf8");
      if (!REQUIRED_USAGE_MARKERS.every((marker) => output.includes(marker))) {
        reject(
          new Error(
            `${binaryPath} is not the expected hshei/schemagrep CLI. ` +
              "Build the bundled engine with `bun run setup-engine` or correct SCHEMAGREP_BIN.",
          ),
        );
        return;
      }
      resolve();
    });
  });
}

export async function assertWorkerSandbox(
  mode: WorkerSandboxMode,
  bubblewrapBinary: string,
): Promise<void> {
  if (mode === "disabled") return;

  try {
    await access(bubblewrapBinary, constants.X_OK);
  } catch {
    throw new Error(
      `Bubblewrap is not executable at ${bubblewrapBinary}. ` +
        "Install bubblewrap, set BWRAP_BIN, or explicitly use WORKER_SANDBOX=disabled for isolated local development.",
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      bubblewrapBinary,
      [...bubblewrapIsolationArgs(), "--", "/usr/bin/true"],
      {
        env: { LANG: "C", LC_ALL: "C", PATH: process.env.PATH ?? "" },
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.byteLength >= MAX_PROBE_OUTPUT_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = Buffer.concat([
        stderr,
        buffer.subarray(0, MAX_PROBE_OUTPUT_BYTES - stderr.byteLength),
      ]);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5000);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Unable to start Bubblewrap at ${bubblewrapBinary}: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error("Bubblewrap sandbox probe timed out"));
        return;
      }
      if (code !== 0) {
        const detail = stderr.toString("utf8").trim();
        reject(
          new Error(
            detail.length > 0
              ? `Bubblewrap sandbox is unavailable: ${detail}`
              : `Bubblewrap sandbox probe exited with code ${code}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
