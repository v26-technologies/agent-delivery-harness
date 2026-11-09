/**
 * The ONE seam through which the managed modules run external commands.
 *
 * Everything the product launches — git plumbing for candidate identity and
 * worktree-scoped configuration, the trusted-base sensor — goes through this
 * port, so a test can wrap it and the walking-skeleton scenario can assert
 * the complete launch inventory: no `codex`, no `claude`, no agent runtime,
 * no daemon. POSIX launches own a process group so timeout/cancellation also stops
 * descendants. Every launch remains referenced and awaited; there is no
 * product-owned background execution. Windows retains direct-child semantics.
 */
import { execFile, spawn } from "node:child_process";

export interface ExecInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Absent inherits the ambient environment; present replaces it entirely. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly signal?: AbortSignal;
}

export interface ExecOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
}

export interface ExecPort {
  run(invocation: ExecInvocation): Promise<ExecOutcome>;
}

/** Foreground supervision; process-group isolation never unrefs a launch.
 * `groupKill` replaces the libc resolver, for tests of the fallback path. */
export function createExecPort(options: { readonly groupKill?: () => Promise<NativeGroupKill | null> } = {}): ExecPort {
  return {
    run(invocation) {
      if (process.platform !== "win32") return runProcessGroup(invocation, options.groupKill ?? nativeGroupKill);
      return new Promise<ExecOutcome>((resolve) => {
        execFile(
          invocation.command,
          [...invocation.args],
          {
            cwd: invocation.cwd,
            ...(invocation.env === undefined ? {} : { env: { ...invocation.env } }),
            encoding: "utf8",
            maxBuffer: invocation.maxBuffer ?? 16 * 1024 * 1024,
            ...(invocation.timeoutMs === undefined ? {} : { timeout: invocation.timeoutMs, killSignal: "SIGKILL" as const }),
            ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
          },
          (error, stdout, stderr) => {
            const code =
              error === null
                ? 0
                : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
                  ? ((error as unknown as { code: number }).code)
                  : 1;
            resolve({ code, stdout, stderr,
              ...(error === null ? {} : { errorCode: String(error.code ?? error.signal ?? "execution_failed") }),
            });
          },
        );
      });
    },
  };
}

const ESRCH = 3; // The same value on darwin and linux.

/** libc kill(2) on a whole group, for Bun on darwin and linux only: true when
 * the group was signalled or is already gone (ESRCH). Any other result is
 * false, so the caller still kills the group by other means. Resolved once;
 * null where bun:ffi is absent or cannot load libc. */
export type NativeGroupKill = (pid: number) => boolean;

/** A libc kill(2) result on a group: signalled (0), or already gone (ESRCH).
 * Anything else, EPERM included, leaves the group for /bin/kill. */
export function groupStopped(rc: number, errno: number): boolean {
  return rc === 0 || errno === ESRCH;
}

/** The group kill over libc's kill(2) and errno: SIGKILL to the whole group.
 * errno is read by a second call; a value changed in between only sends a
 * stopped group on to /bin/kill, which reports it gone. */
export function libcGroupKill(kill: (pid: number, signal: number) => number, readErrno: () => number): NativeGroupKill {
  return (pid: number) => kill(-pid, 9) === 0 || groupStopped(-1, readErrno());
}
let nativeGroupKillOnce: Promise<NativeGroupKill | null> | undefined;
export function nativeGroupKill(): Promise<NativeGroupKill | null> {
  return nativeGroupKillOnce ??= (async () => {
    if (!("Bun" in globalThis) || (process.platform !== "darwin" && process.platform !== "linux")) return null;
    try {
      const ffiModule = "bun:ffi";
      const { dlopen, FFIType, read } = await import(ffiModule) as BunFfi;
      const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
      const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
        kill: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        [errnoSymbol]: { args: [], returns: FFIType.ptr },
      });
      const kill = libc.symbols["kill"] as (pid: number, signal: number) => number;
      const errno = libc.symbols[errnoSymbol] as () => unknown;
      return libcGroupKill(kill, () => read.i32(errno(), 0));
    } catch {
      return null;
    }
  })();
}
type BunFfi = {
  dlopen: (path: string, symbols: Record<string, { args: unknown[]; returns: unknown }>) => { symbols: Record<string, unknown> };
  FFIType: { i32: unknown; ptr: unknown };
  read: { i32: (pointer: unknown, offset: number) => number };
};

/** Launch failures, not a kill that ran and failed: the group is still there. */
const LAUNCH_FAILURES = new Set(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"]);
const UTILITY_RETRY_DELAYS_MS = [0, 50, 100, 250, 500];

/** /bin/kill on a whole group. A launch that fails under load (Bun 1.1.29 can
 * throw synchronously from execFile when the spawn itself fails) is retried
 * within about a second; a kill that ran and failed is not, and neither is a
 * launch that fails every time. */
async function killGroupWithUtility(pid: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      // Await the bounded utility asynchronously: a synchronous launch in
      // an exit callback can lose sibling completion events in Bun 1.1.29.
      await new Promise<void>((resolve, reject) => {
        execFile("/bin/kill", ["-KILL", "--", `-${pid}`], {
          timeout: 1000, maxBuffer: 16 * 1024,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        }, (error, _stdout, stderr) => {
          if (error && !stderr.includes("No such process")) reject(Object.assign(error, { launched: typeof error.code !== "string" || !LAUNCH_FAILURES.has(error.code) }));
          else resolve();
        });
      });
      return;
    } catch (error) {
      // A synchronous throw never launched; a callback error launched unless its code says otherwise.
      if ((error as { launched?: boolean }).launched === true || attempt + 1 >= UTILITY_RETRY_DELAYS_MS.length) throw error;
      await new Promise(resolve => setTimeout(resolve, UTILITY_RETRY_DELAYS_MS[attempt + 1]));
    }
  }
}

/** A dedicated POSIX session gives this invocation exclusive signal ownership. */
function runProcessGroup(invocation: ExecInvocation, groupKill: () => Promise<NativeGroupKill | null>): Promise<ExecOutcome> {
  if (invocation.signal?.aborted) return Promise.resolve({ code: 1, stdout: "", stderr: "", errorCode: "ABORT_ERR" });
  return new Promise(resolve => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      ...(invocation.env === undefined ? {} : { env: { ...invocation.env } }),
      detached: true, // A new process group, still referenced and fully awaited.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const limit = invocation.maxBuffer ?? 16 * 1024 * 1024;
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let errorCode: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanup: Promise<void> | undefined;
    const stopGroup = () => cleanup ??= (async () => {
      if (child.pid === undefined) return;
      try {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ERR_OUT_OF_RANGE") throw error;
          // Older Bun rejects negative PIDs even for a group it created. libc
          // signals the group without launching anything; otherwise the
          // bounded utility does.
          const native = await groupKill();
          let stopped = false;
          try { stopped = native?.(child.pid) === true; } catch { /* falls through to the utility */ }
          if (!stopped) await killGroupWithUtility(child.pid);
        }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).errno !== 3) {
          errorCode ??= "execution_cleanup_failed";
          child.kill("SIGKILL");
        }
      }
    })();
    const stop = (reason: string) => { errorCode ??= reason; stopGroup(); };
    const abort = () => stop("ABORT_ERR");
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, limit - sizes[stream]);
        if (remaining > 0) output[stream].push(chunk.subarray(0, remaining));
        sizes[stream] += chunk.length;
        if (sizes[stream] > limit) stop("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      });
    }
    child.once("error", (error: NodeJS.ErrnoException) => { errorCode ??= error.code ?? "execution_failed"; });
    // A successful leader must not leave background descendants holding pipes
    // or mutating the caller's execution tree after the invocation completes.
    child.once("exit", stopGroup);
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      invocation.signal?.removeEventListener("abort", abort);
      await cleanup;
      resolve({ code: errorCode === undefined ? code ?? 1 : 1,
        stdout: Buffer.concat(output.stdout).toString("utf8"), stderr: Buffer.concat(output.stderr).toString("utf8"),
        ...(errorCode !== undefined ? { errorCode } : code === 0 ? {} : { errorCode: String(signal ?? code ?? "execution_failed") }),
      });
    });
    if (invocation.timeoutMs !== undefined && invocation.timeoutMs > 0) timer = setTimeout(() => stop("SIGKILL"), invocation.timeoutMs);
    invocation.signal?.addEventListener("abort", abort, { once: true });
    if (invocation.signal?.aborted) abort();
  });
}
