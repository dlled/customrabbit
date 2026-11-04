// Which changed files each tool understands, and the exact §7.1 invocation for each tool.
//
// Every file argument is an absolute path under the staging dir, so a PR path starting with `-`
// can never become an option. Additions to the §7.1 flags, all output/exit-code only, none of
// them reads repository config:
//   - ruff `--no-cache --exit-zero`: no cache write in cwd; findings do not change the exit code;
//   - zizmor `--no-exit-codes`: same;
//   - hadolint: `no-fail` lives in the pinned config;
//   - gitleaks `--no-banner -r - --exit-code 3`: JSON report on stdout, and leaks (3) are told
//     apart from errors (1), so the §7.5 fail-closed rule can tell "found" from "did not run".

import { posix } from "node:path";

import type { ToolName } from "../types.js";
import { CONFIG_FILES } from "./install.js";

/** Exit codes that mean "ran and reported" (anything else is a tool failure). */
export const OK_EXIT_CODES: Record<ToolName, readonly number[]> = {
  shellcheck: [0, 1],
  actionlint: [0, 1],
  hadolint: [0],
  zizmor: [0],
  ruff: [0],
  yamllint: [0, 1, 2],
  squawk: [0, 1],
  gitleaks: [0, 3],
};

const SHELL_EXT = /\.(?:sh|bash|ksh|dash)$/;
const SHELL_SHEBANG = /^#!\s*(?:\/usr)?\/bin\/(?:env\s+)?(?:ba|da|k)?sh\b/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_FILE = /(?:^|\/)action\.ya?ml$/;
const DOCKERFILE = /(?:^|\/)(?:(?:Docker|Container)file(?:\.[^/]+)?|[^/]+\.(?:docker|container)file)$/i;
const PYTHON = /\.pyi?$/;
const YAML = /\.ya?ml$/;
const SQL = /\.sql$/i;

/** True when `tool` checks the repo-relative `path` (`head` is the file's first line, for shebangs). */
export function toolHandles(tool: ToolName, path: string, firstLine: string): boolean {
  switch (tool) {
    case "shellcheck":
      return SHELL_EXT.test(path) || (!posix.basename(path).includes(".") && SHELL_SHEBANG.test(firstLine));
    case "actionlint":
      return WORKFLOW.test(path);
    case "zizmor":
      return WORKFLOW.test(path) || ACTION_FILE.test(path);
    case "hadolint":
      return DOCKERFILE.test(path);
    case "ruff":
      return PYTHON.test(path);
    case "yamllint":
      return YAML.test(path);
    case "squawk":
      return SQL.test(path);
    case "gitleaks":
      return true;
  }
}

export interface CommandContext {
  /** Install root (ToolsManifest.root). */
  root: string;
  /** Staging root: repo-relative paths live under it. */
  stage: string;
  /** Absolute staging paths of the files this tool checks. */
  files: readonly string[];
  /** Installed shellcheck for actionlint, or null to disable that integration. */
  shellcheck: string | null;
}

export interface ToolCommand {
  /** Absolute executable path, run through bin/as-tools. */
  file: string;
  args: string[];
}

const config = (root: string, tool: ToolName): string => posix.join(root, "config", CONFIG_FILES[tool] ?? "");
const bin = (root: string, tool: ToolName): string => posix.join(root, "bin", tool);

/**
 * The §7.1 invocation. `ruffSelect` is the content of tools/config/ruff-select.txt (passed in, so
 * this stays pure).
 */
export function toolCommand(tool: ToolName, ctx: CommandContext, ruffSelect: string): ToolCommand {
  const files = [...ctx.files];
  const { root } = ctx;
  switch (tool) {
    case "shellcheck":
      return { file: bin(root, tool), args: ["--norc", "-f", "json1", ...files] };
    case "actionlint":
      return {
        file: bin(root, tool),
        args: [
          "-config-file", config(root, tool),
          `-shellcheck=${ctx.shellcheck ?? ""}`,
          "-pyflakes=",
          "-format", "{{json .}}",
          ...files,
        ],
      };
    case "hadolint":
      return { file: bin(root, tool), args: ["--config", config(root, tool), "--disable-ignore-pragma", "-f", "json", ...files] };
    case "zizmor":
      return { file: bin(root, tool), args: ["--offline", "--no-config", "--no-exit-codes", "--format", "json-v1", ...files] };
    case "ruff":
      return {
        file: bin(root, tool),
        args: ["check", "--isolated", "--no-cache", "--exit-zero", "--select", ruffSelect.trim(), "--output-format", "json", ...files],
      };
    case "yamllint": {
      const py = posix.join(root, "py");
      // sys.path is the pinned wheel dir only: -I drops the cwd, env vars and user site.
      const boot = `import sys; sys.path.insert(0, ${JSON.stringify(py)}); from yamllint.cli import run; run()`;
      return { file: "/usr/bin/python3", args: ["-I", "-c", boot, "-c", config(root, tool), "-f", "parsable", ...files] };
    }
    case "squawk":
      return { file: bin(root, tool), args: ["-c", config(root, tool), "--reporter", "json", ...files] };
    case "gitleaks":
      return {
        file: bin(root, tool),
        args: [
          "dir", ctx.stage,
          "--config", config(root, tool),
          "-i", posix.join(root, "no-ignore"),
          "--ignore-gitleaks-allow",
          "--redact",
          "-f", "json",
          "-r", "-",
          "--no-banner",
          "--exit-code", "3",
        ],
      };
  }
}
