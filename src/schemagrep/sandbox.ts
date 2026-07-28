import { existsSync } from "node:fs";

export function bubblewrapIsolationArgs(): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
  ];
  for (const systemDirectory of ["/lib", "/lib64"]) {
    if (existsSync(systemDirectory)) args.push("--ro-bind", systemDirectory, systemDirectory);
  }
  return args;
}
