import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { assertWorkerSandbox } from "../src/schemagrep/probe";
import { bubblewrapIsolationArgs } from "../src/schemagrep/sandbox";

describe("worker sandbox configuration", () => {
  test("defaults to Bubblewrap and rejects unknown modes", () => {
    expect(loadConfig({ AUTH_DISABLED: "true" }).workerSandbox).toBe("bwrap");
    expect(() =>
      loadConfig({ AUTH_DISABLED: "true", WORKER_SANDBOX: "unknown" }),
    ).toThrow("WORKER_SANDBOX must be bwrap or disabled");
  });

  test("keeps network, environment, session, and filesystem isolation flags together", () => {
    const args = bubblewrapIsolationArgs();

    expect(args).toContain("--unshare-all");
    expect(args).toContain("--clearenv");
    expect(args).toContain("--new-session");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--ro-bind");
  });

  test("allows an explicit local-development opt-out but rejects a missing Bubblewrap binary", async () => {
    await expect(
      assertWorkerSandbox("disabled", "/definitely/missing/bwrap"),
    ).resolves.toBeUndefined();
    await expect(assertWorkerSandbox("bwrap", "/definitely/missing/bwrap")).rejects.toThrow(
      "Bubblewrap is not executable",
    );
  });
});
