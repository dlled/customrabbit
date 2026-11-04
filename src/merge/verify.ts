// §6.3 verification orchestration: single-source findings at or above the threshold get up to
// `budget` verify calls, most severe first. A rejection demotes; budget exhaustion or a verifier
// error keeps the finding blocking.

import type { MergedFinding, Verification } from "../types.js";
import { severityRank } from "./severity.js";
import type { VerifyFn, VerifyRequest } from "./types.js";

/** Most severe first, then most confident, then input order. */
export function verifyOrder(a: MergedFinding, b: MergedFinding): number {
  return severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence;
}

export interface VerifyRunOptions {
  budget: number;
  concurrency: number;
  timeoutMs?: number | undefined;
}

/**
 * Runs the verifier over `requests` (already in priority order) and returns one outcome per request:
 * the first `budget` get a call, the rest are `unverified_budget`.
 */
export async function verifyAll(
  requests: readonly VerifyRequest[],
  verify: VerifyFn,
  opts: VerifyRunOptions,
): Promise<Verification[]> {
  const budget = Math.max(0, Math.floor(opts.budget));
  const out: Verification[] = requests.map(() => "unverified_budget");
  const todo = requests.slice(0, budget);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const i = next++;
      const req = todo[i];
      if (req) out[i] = await verifyOne(req, verify, opts.timeoutMs);
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(opts.concurrency), todo.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

async function verifyOne(
  req: VerifyRequest,
  verify: VerifyFn,
  timeoutMs: number | undefined,
): Promise<Verification> {
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  try {
    const call = Promise.resolve().then(() => verify(req, controller.signal));
    const result =
      timeoutMs === undefined
        ? await call
        : await Promise.race([
            call,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort(new Error("verify timeout"));
                reject(new Error("verify timeout"));
              }, timeoutMs);
            }),
          ]);
    // Anything but an explicit boolean is a malformed answer, treated as an error (stays blocking).
    const confirmed: unknown = (result as { confirmed?: unknown } | null)?.confirmed;
    if (typeof confirmed !== "boolean") return "unverified_error";
    return confirmed ? "verified" : "rejected";
  } catch {
    return "unverified_error";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
