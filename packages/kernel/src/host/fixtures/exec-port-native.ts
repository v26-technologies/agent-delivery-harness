/** Executed directly by the Bun compatibility sensor, never imported as a test. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createExecPort, nativeGroupKill } from "../exec-port.ts";

// V26-3313: Bun on darwin and linux signals the group through libc, launching
// nothing. A grandchild in the group dies with it; a gone group counts as stopped.
if (process.platform === "darwin" || process.platform === "linux") {
  const native = await nativeGroupKill();
  assert.ok(native, "Bun resolves libc kill for process groups");
  const leader = spawn("/bin/sh", ["-c", "sleep 30 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = Number(await new Promise<string>(resolve => leader.stdout!.once("data", chunk => resolve(String(chunk).trim()))));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(grandchild), "the grandchild runs before the group is signalled");
  const exited = new Promise(resolve => leader.once("exit", resolve));
  assert.equal(native(leader.pid!), true);
  await exited;
  for (const deadline = Date.now() + 2000; alive(grandchild) && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(grandchild), false, "the group kill reaches the grandchild");
  assert.equal(native(leader.pid!), true, "a group that is already gone counts as stopped");
}

// Synchronous process launches inside one child's exit callback can strand a
// sibling's pipe/exit notifications under Bun 1.1.29. Serial cleanup probes do
// not exercise that event-loop boundary.
const expected = Array.from({ length: 34 }, (_, index) => `out-${index}`);
const concurrent = await Promise.all(expected.map(out => createExecPort().run({
  command: "/bin/sh", args: ["-c", 'printf %s "$1"', "exec-probe", out], timeoutMs: 1000,
})));
assert.deepEqual(concurrent.map(result => result.code), expected.map(() => 0));
assert.deepEqual(concurrent.map(result => result.stdout), expected);

for (const reason of ["timeout", "abort", "overflow", "stderr-overflow", "leader-exit", "leader-failure"]) {
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
    assert.ok((await readFile(activity)).length > 0);
    if (reason === "abort") controller.abort();
    const result = await pending;
    assert.ok(performance.now() - started < 3500, "supervision must finish before fixture self-exit safety timers");
    assert.equal(result.errorCode, reason === "abort" ? "ABORT_ERR" : reason.endsWith("overflow") ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : reason === "timeout" ? "SIGKILL" : reason === "leader-failure" ? "7" : undefined);
    if (reason.startsWith("leader-")) assert.equal(result.code, reason === "leader-exit" ? 0 : 7); else assert.notEqual(result.code, 0);
    const before = await readFile(activity, "utf8");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await readFile(activity, "utf8"), before);
  } finally {
    controller.abort();
    await pending;
    const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid > 1) try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).errno !== 3) throw error; }
    await rm(root, { recursive: true, force: true });
  }
}
console.log("native process supervision passed");
