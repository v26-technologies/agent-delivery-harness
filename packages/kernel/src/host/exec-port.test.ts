import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { createExecPort, groupStopped, libcGroupKill } from "./exec-port.ts";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});

it.skipIf(process.platform === "win32")("awaits asynchronous group cleanup even when close arrives first", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 2147483647, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new RangeError("negative PID unsupported"), { code: "ERR_OUT_OF_RANGE" });
  });
  let settled = false;
  const pending = createExecPort().run({ command: "fixture", args: [] });
  void pending.then(() => { settled = true; });
  try {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await pending).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(settled).toBe(true);
  } finally {
    kill.mockRestore();
    await pending;
  }
});

let gaps: number[] = [];
// V26-3313: under load, Bun 1.1.29 can fail to launch /bin/kill and throw
// synchronously from execFile. The group is still there, so the launch is
// retried within its bound; a kill that ran and failed is not.
type KillOutcome = "throw" | "eagain" | "emfile" | "enfile" | "enomem" | "ran-and-failed" | "ok";
async function cleanupWith(outcomes: KillOutcome[], groupKill?: () => Promise<((pid: number) => boolean) | null>) {
  const child = Object.assign(new EventEmitter(), {
    pid: 2147483646, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new RangeError("negative PID unsupported"), { code: "ERR_OUT_OF_RANGE" });
  });
  const launch = vi.mocked(execFile);
  launch.mockClear();
  let call = 0;
  const launchedAt: number[] = [];
  launch.mockImplementation(((_file: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
    launchedAt.push(performance.now());
    const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
    if (outcome === "throw") throw new TypeError("undefined is not an object");
    queueMicrotask(() => {
      if (outcome === "eagain" || outcome === "emfile" || outcome === "enfile" || outcome === "enomem")
        callback(Object.assign(new Error(`spawn ${outcome.toUpperCase()}`), { code: outcome.toUpperCase() }), "", "");
      else if (outcome === "ran-and-failed") callback(Object.assign(new Error("kill failed"), { code: 1 }), "", "kill: Operation not permitted");
      else callback(null, "", "");
    });
    return undefined;
  }) as unknown as typeof execFile);
  try {
    const pending = createExecPort(groupKill ? { groupKill } : {}).run({ command: "fixture", args: [] });
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    const result = await pending;
    gaps = launchedAt.slice(1).map((at, index) => at - launchedAt[index]!);
    return { result, launches: launch.mock.calls.length, killedLeader: child.kill.mock.calls.length };
  } finally {
    kill.mockRestore();
    launch.mockReset();
    launch.mockImplementation(((await vi.importActual<typeof import("node:child_process")>("node:child_process")).execFile) as typeof execFile);
  }
}

it.skipIf(process.platform === "win32")("retries a group kill whose launch fails, then keeps the leader's result", async () => {
  expect(await cleanupWith(["throw", "eagain", "throw", "ok"])).toEqual({ result: { code: 0, stdout: "", stderr: "" }, launches: 4, killedLeader: 0 });
});

it.skipIf(process.platform === "win32").each(["eagain", "emfile", "enfile", "enomem"] as const)("retries a group kill whose launch fails with %s", async (code) => {
  expect(await cleanupWith([code, "ok"])).toEqual({ result: { code: 0, stdout: "", stderr: "" }, launches: 2, killedLeader: 0 });
});

it("kills the whole group with SIGKILL through libc, and reads errno only when that fails", () => {
  const calls: number[][] = [];
  let errnoReads = 0;
  const groupKill = (rc: number, errno: number) => libcGroupKill((pid, signal) => { calls.push([pid, signal]); return rc; }, () => { errnoReads++; return errno; });
  expect(groupKill(0, 1)(4242)).toBe(true);
  expect([calls, errnoReads]).toEqual([[[-4242, 9]], 0]);
  expect(groupKill(-1, 3)(4242)).toBe(true);
  // EPERM, or any errno but ESRCH, is not stopped: the group goes on to /bin/kill.
  expect(groupKill(-1, 1)(4242)).toBe(false);
  expect(groupKill(-1, 0)(4242)).toBe(false);
  expect(errnoReads).toBe(3);
});

it.skipIf(process.platform === "win32")("fails closed when every launch within the bound fails", async () => {
  expect(await cleanupWith(["throw"])).toEqual({ result: { code: 1, stdout: "", stderr: "", errorCode: "execution_cleanup_failed" }, launches: 5, killedLeader: 1 });
  // The tries are spaced 50, 100, 250 and 500 ms apart, not issued at once.
  expect(gaps.map((gap, index) => gap >= [50, 100, 250, 500][index]! - 5)).toEqual([true, true, true, true]);
});

it("reads a libc kill as stopped only when it signalled the group or found it gone", () => {
  expect(groupStopped(0, 0)).toBe(true);
  expect(groupStopped(0, 1)).toBe(true);
  expect(groupStopped(-1, 3)).toBe(true);
  expect(groupStopped(-1, 1)).toBe(false);
  expect(groupStopped(-1, 0)).toBe(false);
});

it.skipIf(process.platform === "win32")("sends a group libc could not stop on to /bin/kill, and keeps the leader's result", async () => {
  expect(await cleanupWith(["ok"], async () => () => false)).toEqual({ result: { code: 0, stdout: "", stderr: "" }, launches: 1, killedLeader: 0 });
  // A group libc stopped launches nothing at all.
  expect(await cleanupWith(["ok"], async () => () => true)).toEqual({ result: { code: 0, stdout: "", stderr: "" }, launches: 0, killedLeader: 0 });
  // A throwing libc call falls through to the utility as well.
  expect(await cleanupWith(["ok"], async () => () => { throw new Error("ffi"); })).toEqual({ result: { code: 0, stdout: "", stderr: "" }, launches: 1, killedLeader: 0 });
});

it.skipIf(process.platform === "win32")("does not retry a kill that ran and failed", async () => {
  expect(await cleanupWith(["ran-and-failed", "ok"])).toEqual({ result: { code: 1, stdout: "", stderr: "", errorCode: "execution_cleanup_failed" }, launches: 1, killedLeader: 1 });
});

it.skipIf(process.platform === "win32").each(["timeout", "abort", "overflow", "stderr-overflow", "leader-exit", "leader-failure"])("stops an owned descendant before resolving after %s", async reason => {
  const root = await mkdtemp(path.join(tmpdir(), "exec-supervision-"));
  const pidFile = path.join(root, "pid"), activity = path.join(root, "activity");
  const descendant = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(activity)},'x'),10);setTimeout(()=>process.exit(99),5500)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});${reason.endsWith("overflow") ? `setTimeout(()=>process.${reason === "stderr-overflow" ? "stderr" : "stdout"}.write('x'.repeat(65536)),300);` : ""}${reason.startsWith("leader-") ? `setTimeout(()=>process.exit(${reason === "leader-exit" ? 0 : 7}),300)` : "setInterval(()=>{},1000);setTimeout(()=>process.exit(99),5000)"}`;
  const controller = new AbortController();
  const started = performance.now();
  const pending = createExecPort().run({ command: process.execPath, args: ["-e", parent], timeoutMs: 2000, maxBuffer: reason.endsWith("overflow") ? 1024 : 65536, signal: controller.signal });
  try {
    const deadline = Date.now() + 1500;
    while (await readFile(activity).catch(() => null) === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect((await readFile(activity)).length).toBeGreaterThan(0);
    if (reason === "abort") controller.abort();
    const result = await pending;
    expect(performance.now() - started).toBeLessThan(3500);
    expect(result.errorCode).toBe(reason === "abort" ? "ABORT_ERR" : reason.endsWith("overflow") ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : reason === "timeout" ? "SIGKILL" : reason === "leader-failure" ? "7" : undefined);
    if (reason.startsWith("leader-")) expect(result.code).toBe(reason === "leader-exit" ? 0 : 7); else expect(result.code).not.toBe(0);
    const before = await readFile(activity, "utf8");
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await readFile(activity, "utf8")).toBe(before);
  } finally {
    controller.abort();
    await pending;
    const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid > 1) try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).errno !== 3) throw error; }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);


it("preserves success, failure, missing-command and bounded output results", async () => {
  const exec = createExecPort();
  expect(await exec.run({ command: process.execPath, args: ["-e", "process.stdout.write('héllo');process.stderr.write('error')"] }))
    .toEqual({ code: 0, stdout: "héllo", stderr: "error" });
  expect(await exec.run({ command: process.execPath, args: ["-e", "process.exit(7)"] })).toMatchObject({ code: 7, errorCode: "7" });
  expect(await exec.run({ command: "missing-exec-supervision-command", args: [] })).toMatchObject({ code: 1, errorCode: "ENOENT" });
  for (const stream of ["stdout", "stderr"] as const) {
    const overflow = await exec.run({ command: process.execPath, args: ["-e", `process.${stream}.write('a'.repeat(65536))`], maxBuffer: 128 });
    expect(overflow).toMatchObject({ code: 1, errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    expect(Buffer.byteLength(overflow[stream])).toBeLessThanOrEqual(128);
  }
});

it.skipIf(process.platform === "win32")("does not launch an already-cancelled invocation", async () => {
  const launch = vi.mocked(spawn); launch.mockClear();
  const controller = new AbortController(); controller.abort();
  expect(await createExecPort().run({ command: process.execPath, args: ["-e", "process.stdout.write('launched')"], signal: controller.signal })).toMatchObject({ code: 1, errorCode: "ABORT_ERR" });
  expect(launch).not.toHaveBeenCalled();
  expect(await createExecPort().run({ command: process.execPath, args: ["-e", "process.stdout.write('positive')"] })).toMatchObject({ code: 0, stdout: "positive" });
  expect(launch).toHaveBeenCalledOnce();
});


it.skipIf(process.platform === "win32")("supervises actual Bun descendants when Bun is installed", async context => {
  // The real execFile: the module mock above loses its promisify behaviour.
  const exec = promisify((await vi.importActual<typeof import("node:child_process")>("node:child_process")).execFile);
  try { await exec("bun", ["--version"]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { context.skip(); return; } throw error; }
  const result = await exec("bun", [fileURLToPath(new URL("./fixtures/exec-port-native.ts", import.meta.url))], { timeout: 15000 });
  expect(result.stdout).toContain("native process supervision passed");
}, 20000);
