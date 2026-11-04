// design-v2 §7.2 install: verify before extract, per-tool failures, layout and modes. Offline:
// downloads and tar/python are faked.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTools, readToolsManifest, removeTools, sha256Hex, type InstallDeps } from "../../src/tools/install.js";

const repo = new URL("../../", import.meta.url).pathname;
let base: string;
let lockPath: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "p6-install-"));
  lockPath = join(base, "tools.lock");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A lock for two tools whose artifacts are the given fake bytes. */
async function writeLock(art: Record<string, string>): Promise<void> {
  const real = JSON.parse(await readFile(join(repo, "tools/tools.lock"), "utf8")) as { tools: Record<string, Record<string, unknown>> };
  real.tools.hadolint = { ...real.tools.hadolint, url: "https://github.com/x/hadolint", sha256: sha256Hex(bytes(art.hadolint ?? "")) };
  real.tools.gitleaks = { ...real.tools.gitleaks, url: "https://github.com/x/gitleaks.tgz", sha256: sha256Hex(bytes(art.gitleaks ?? "")) };
  const yl = real.tools.yamllint as { wheels: { url: string; sha256: string }[] };
  yl.wheels = yl.wheels.map((w, i) => ({ ...w, url: `https://files.pythonhosted.org/w${i}.whl`, sha256: sha256Hex(bytes(`wheel${i}`)) }));
  await writeFile(lockPath, JSON.stringify(real));
}

function fakeDeps(served: Record<string, string>, calls: string[][] = []): Partial<InstallDeps> {
  return {
    fetchBytes: (url) => {
      const body = served[url];
      return body === undefined ? Promise.reject(new Error("404")) : Promise.resolve(bytes(body));
    },
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file === "tar") {
        // tar -xzf <archive> -C <out> ... -- <member>
        const out = args[args.indexOf("-C") + 1] ?? "";
        await writeFile(join(out, args.at(-1) ?? ""), "#!/bin/sh\n");
      }
    },
  };
}

const opts = (tools: Parameters<typeof installTools>[0]["tools"], deps: Partial<InstallDeps>) => ({
  tools,
  lockPath,
  configDir: join(repo, "tools/config"),
  tmpBase: base,
  deps,
});

describe("installTools", () => {
  it("installs verified binaries 0755 in a runner-owned 0755 dir with configs and empty dirs", async () => {
    await writeLock({ hadolint: "H", gitleaks: "G" });
    const calls: string[][] = [];
    const m = await installTools(opts(["hadolint", "gitleaks"], fakeDeps({ "https://github.com/x/hadolint": "H", "https://github.com/x/gitleaks.tgz": "G" }, calls)));
    expect(m.root.startsWith(join(base, "myrabbit-tools-"))).toBe(true);
    expect(m.failed).toEqual({});
    expect(m.installed).toEqual({ hadolint: join(m.root, "bin/hadolint"), gitleaks: join(m.root, "bin/gitleaks") });
    expect((await stat(m.root)).mode & 0o777).toBe(0o755);
    expect((await stat(join(m.root, "bin"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(m.root, "bin/hadolint"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(m.root, "config/gitleaks.toml"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(m.root, "cwd"))).isDirectory()).toBe(true);
    expect((await stat(join(m.root, "no-ignore"))).isDirectory()).toBe(true);
    // Only the pinned member, after `--`; no download dir left behind.
    expect(calls.find((c) => c[0] === "tar")?.slice(-2)).toEqual(["--", "gitleaks"]);
    await expect(stat(join(m.root, "dl"))).rejects.toThrow();
    expect(await readToolsManifest(m.root)).toEqual(m);
  });

  it("a sha256 mismatch is 'sha256': nothing is extracted or made executable", async () => {
    await writeLock({ hadolint: "H", gitleaks: "G" });
    const calls: string[][] = [];
    const m = await installTools(opts(["gitleaks", "hadolint"], fakeDeps({ "https://github.com/x/hadolint": "H", "https://github.com/x/gitleaks.tgz": "tampered" }, calls)));
    expect(m.failed).toEqual({ gitleaks: "sha256" });
    expect(m.installed.hadolint).toBeDefined();
    expect(m.installed.gitleaks).toBeUndefined();
    expect(calls.some((c) => c[0] === "tar")).toBe(false);
    await expect(stat(join(m.root, "bin/gitleaks"))).rejects.toThrow();
  });

  it("a download error is 'download'", async () => {
    await writeLock({ hadolint: "H", gitleaks: "G" });
    const m = await installTools(opts(["gitleaks"], fakeDeps({})));
    expect(m.failed).toEqual({ gitleaks: "download" });
  });

  it("wheels: every wheel is verified before any is unpacked", async () => {
    await writeLock({});
    const calls: string[][] = [];
    const served = { "https://files.pythonhosted.org/w0.whl": "wheel0", "https://files.pythonhosted.org/w1.whl": "wheel1", "https://files.pythonhosted.org/w2.whl": "bad" };
    const m = await installTools(opts(["yamllint"], fakeDeps(served, calls)));
    expect(m.failed).toEqual({ yamllint: "sha256" });
    expect(calls.some((c) => c[0] === "python3")).toBe(false);

    const ok = await installTools(opts(["yamllint"], fakeDeps({ ...served, "https://files.pythonhosted.org/w2.whl": "wheel2" }, calls)));
    expect(ok.installed.yamllint).toBe(join(ok.root, "py"));
    expect(calls.filter((c) => c[0] === "python3").map((c) => c.slice(1, 5))).toEqual([
      ["-I", "-m", "zipfile", "-e"],
      ["-I", "-m", "zipfile", "-e"],
      ["-I", "-m", "zipfile", "-e"],
    ]);
  });

  it("removeTools refuses anything that is not an install dir", async () => {
    await expect(removeTools("/")).rejects.toThrow();
    await expect(removeTools("/tmp/other")).rejects.toThrow();
    await expect(removeTools("relative/myrabbit-tools-x")).rejects.toThrow();
  });

  it("readToolsManifest rejects a manifest for another directory", async () => {
    await writeLock({ hadolint: "H", gitleaks: "G" });
    const m = await installTools(opts([], fakeDeps({})));
    await writeFile(join(m.root, "manifest.json"), JSON.stringify({ ...m, root: "/tmp/elsewhere" }));
    await expect(readToolsManifest(m.root)).rejects.toThrow();
  });
});
