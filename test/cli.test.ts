import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");

async function runCli(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("cloud CLI guidance", () => {
  test("prints top-level help without requiring credentials", async () => {
    const result = await runCli("--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: bun run cloud -- <command> [options]");
    expect(result.stdout).toContain("Run `bun run cloud -- help COMMAND` for command-specific help.");
  });

  test("prints contextual query help with copyable one-line examples", async () => {
    const result = await runCli("query", "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("query <FILE_ID|--latest> --mode MODE");
    expect(result.stdout).toContain("query --latest --mode count --key type --value push");
    expect(result.stdout).not.toContain("\\\n");
  });

  test("diagnoses whitespace-only arguments before authentication", async () => {
    const result = await runCli("query", " ");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("A blank argument was received. Your shell probably broke a multiline command.");
    expect(result.stderr).toContain("Retry with the entire command on one line.");
  });

  test("rejects unknown options before authentication", async () => {
    const result = await runCli("files", "--bogus");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown arguments: --bogus");
  });
});
