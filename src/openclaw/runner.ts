/**
 * Phase 8 subprocess runner (P8-R7).
 *
 * A narrow `SubprocessRunner` seam plus a real Node implementation. The runner
 * takes a FIXED executable path, a fixed cwd, and an argv ARRAY. It never
 * builds a shell string, never enables a shell, and forwards only a CLOSED
 * child environment (never the whole OpenClaw/Gateway env).
 *
 * It bounds wall time, bounds captured output, and can cancel the whole process
 * group. Environment VALUES are never logged, returned, or persisted.
 */

import { spawn } from 'node:child_process';

import {
  MAX_CAPTURED_OUTPUT_BYTES,
  MAX_PROVIDER_ENV_NAMES,
  hasControlChars,
  isAllowedProviderEnvName,
} from './contracts.ts';

export interface SpawnInfo {
  pid: number;
  /** Process-group id (POSIX) when the child was detached as a group leader. */
  processGroup: number | null;
}

export interface RunRequest {
  executablePath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Invoked once a child actually started (before it exits). */
  onSpawn?: (info: SpawnInfo) => void | Promise<void>;
}

export type RunResult =
  | {
      kind: 'exit';
      code: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      pid: number;
      processGroup: number | null;
    }
  | { kind: 'spawn_failed'; errorCode: string }
  | {
      kind: 'timeout';
      stdout: string;
      stderr: string;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      pid: number;
      processGroup: number | null;
      signal: string | null;
    }
  | {
      kind: 'output_cap';
      stream: 'stdout' | 'stderr';
      stdout: string;
      stderr: string;
      pid: number;
      processGroup: number | null;
      signal: string | null;
    };

export interface SubprocessRunner {
  run(request: RunRequest): Promise<RunResult>;
}

/** Always-forwarded baseline names (§14.1). */
const BASELINE_ENV_NAMES = ['PATH', 'HOME'] as const;

/**
 * Build the CLOSED child environment. Only `PATH`/`HOME` plus the exact,
 * validated `providerEnvNames` are copied from the parent env, and only when
 * the value is present. Unknown/unlisted names are never forwarded.
 *
 * Returns name→value; the caller must never log or expose the values.
 */
export function buildChildEnv(
  providerEnvNames: readonly string[],
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of BASELINE_ENV_NAMES) {
    const value = parentEnv[name];
    if (typeof value === 'string') out[name] = value;
  }
  for (const name of providerEnvNames) {
    if (providerEnvNames.length > MAX_PROVIDER_ENV_NAMES) break;
    if (!isAllowedProviderEnvName(name)) continue;
    const value = parentEnv[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

/** Validate one argv element as inert data (NUL is the only true separator). */
export function isInertArg(value: string): boolean {
  return !value.includes('\u0000') && !hasControlChars(value);
}

const DEFAULT_MAX_OUTPUT = MAX_CAPTURED_OUTPUT_BYTES;

/**
 * Real Node runner. Uses `spawn` with `shell: false` and `detached: true`
 * (POSIX process group) — equivalent to `execFile` for argv-array execution,
 * but with a synchronous PID so the adapter can persist post-spawn ownership
 * and cancel the whole group.
 */
export class NodeSubprocessRunner implements SubprocessRunner {
  run(request: RunRequest): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const maxOutputBytes = request.maxOutputBytes > 0 ? request.maxOutputBytes : DEFAULT_MAX_OUTPUT;

      let child;
      try {
        child = spawn(request.executablePath, request.args, {
          cwd: request.cwd,
          env: request.env,
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ kind: 'spawn_failed', errorCode: errorCodeOf(err) });
        return;
      }

      let spawned = false;
      let settled = false;
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let capHit: 'stdout' | 'stderr' | null = null;
      let timer: NodeJS.Timeout | null = null;

      const pid = child.pid ?? 0;
      const processGroup = pid > 0 ? pid : null;

      const clearTimer = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const killGroup = (signal: NodeJS.Signals): void => {
        if (pid <= 0) return;
        try {
          process.kill(-pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        }
      };

      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(result);
      };

      child.on('error', (err) => {
        if (!spawned) {
          finish({ kind: 'spawn_failed', errorCode: errorCodeOf(err) });
        }
      });

      child.on('spawn', () => {
        spawned = true;
        try {
          void request.onSpawn?.({ pid, processGroup });
        } catch {
          /* ownership persistence must never break the child */
        }
        if (request.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            killGroup('SIGTERM');
            // Escalate to SIGKILL shortly after so a stubborn child cannot hold
            // the adapter forever.
            setTimeout(() => killGroup('SIGKILL'), 2_000);
          }, request.timeoutMs);
          timer.unref?.();
        }
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          stdoutTruncated = true;
          capHit = capHit ?? 'stdout';
          killGroup('SIGKILL');
          const remaining = Math.max(0, maxOutputBytes - (stdoutBytes - chunk.length));
          stdout += chunk.subarray(0, remaining).toString('utf8');
          return;
        }
        stdout += chunk.toString('utf8');
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) {
          stderrTruncated = true;
          capHit = capHit ?? 'stderr';
          killGroup('SIGKILL');
          const remaining = Math.max(0, maxOutputBytes - (stderrBytes - chunk.length));
          stderr += chunk.subarray(0, remaining).toString('utf8');
          return;
        }
        stderr += chunk.toString('utf8');
      });

      child.on('close', (code, signal) => {
        if (capHit !== null) {
          finish({
            kind: 'output_cap',
            stream: capHit,
            stdout,
            stderr,
            pid,
            processGroup,
            signal,
          });
          return;
        }
        if (timedOut) {
          finish({ kind: 'timeout', stdout, stderr, stdoutTruncated, stderrTruncated, pid, processGroup, signal });
          return;
        }
        finish({
          kind: 'exit',
          code,
          signal,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          pid,
          processGroup,
        });
      });
    });
  }
}

function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'SPAWN_ERROR';
}
