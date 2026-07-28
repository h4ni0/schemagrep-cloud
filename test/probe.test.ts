import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSchemagrepBinary } from "../src/schemagrep/probe";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createExecutable(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "schemagrep-probe-test-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "schemagrep");
  await writeFile(executable, content);
  await chmod(executable, 0o700);
  return executable;
}

describe("assertSchemagrepBinary", () => {
  test("rejects a missing engine with setup instructions", async () => {
    await expect(assertSchemagrepBinary("/definitely/missing/schemagrep")).rejects.toThrow(
      "bun run setup-engine",
    );
  });

  test("rejects an unrelated executable with the same name", async () => {
    const executable = await createExecutable("#!/bin/sh\necho unrelated-cli >&2\nexit 1\n");

    await expect(assertSchemagrepBinary(executable)).rejects.toThrow(
      "is not the expected hshei/schemagrep CLI",
    );
  });

  test("accepts the engine CLI contract even though bare invocation exits nonzero", async () => {
    const executable = await createExecutable(
      "#!/bin/sh\n" +
        "echo 'schemagrep encode <file>' >&2\n" +
        "echo 'schemagrep schema <file>' >&2\n" +
        "exit 1\n",
    );

    await expect(assertSchemagrepBinary(executable)).resolves.toBeUndefined();
  });
});
