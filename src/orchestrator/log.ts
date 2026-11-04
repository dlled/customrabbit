// Logging (design §9, §9.3): every line goes through redact(). Logs never print env, prompts or raw
// stderr; callers pass short, already-safe messages.

import { redact } from "../env.js";

export type Log = (message: string) => void;

/** Writes one redacted line to stdout (the job log). */
export const stdoutLog: Log = (message) => {
  process.stdout.write(`${redact(message).replace(/\r?\n/g, " ")}\n`);
};

/** Short, redacted, single-line message of an unknown error. Never a stack trace. */
export function errorText(err: unknown, max = 500): string {
  const raw =
    err instanceof Error ? `${err.name === "Error" ? "" : `${err.name}: `}${err.message}` : typeof err === "string" ? err : "unknown error";
  const line = redact(raw).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
