import { execFile, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "manual" as "manual" | "record" | "replay",
  child: undefined as ChildProcessWithoutNullStreams | undefined,
  environment: undefined as NodeJS.ProcessEnv | undefined,
  now: 0, rows: [] as string[], next: 0,
}));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: string[], options: SpawnOptions) => {
    if (state.mode === "record") {
      const child = actual.spawn(command, args, options);
      let text = "";
      child.stdout!.on("data", bytes => { text += bytes.toString(); });
      child.on("close", () => state.rows.push(text));
      return child;
    }
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    }) as unknown as ChildProcessWithoutNullStreams;
    state.child = child; state.environment = options.env;
    if (state.mode === "replay") queueMicrotask(() => {
      state.now += 110;
      child.stdout.emit("data", Buffer.from(state.rows[state.next++]!));
      child.emit("close", 0);
    });
    return child;
  } };
});
import { createCheckSnapshot, snapshotInventory } from "./check-snapshot.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); state.mode = "manual"; });
const valid = JSON.stringify({ digest: "a".repeat(64) });
const finish = (stdout = valid, code: number | null = 0) => {
  state.child!.stdout.emit("data", Buffer.from(stdout)); state.child!.emit("close", code);
};

it.each([
  ["nonzero", valid, 1], ["invalid JSON", "not json", 0],
  ["invalid digest", JSON.stringify({ digest: "bad" }), 0],
  ["oversize", valid + " ".repeat(65537), 0], ["spawn error", valid, 0],
] as const)("refuses %s and waits for child close", async (kind, stdout, code) => {
  let settled = false;
  const result = snapshotInventory("/tmp", []).catch(error => error).finally(() => { settled = true; });
  if (kind === "spawn error") state.child!.emit("error", new Error("cannot spawn"));
  state.child!.stdout.emit("data", Buffer.from(stdout));
  await Promise.resolve(); expect(settled).toBe(false);
  if (kind === "oversize") expect(state.child!.kill).toHaveBeenCalledWith("SIGKILL");
  state.child!.emit("close", code);
  expect(await result).toMatchObject({ code: "check_snapshot_unavailable" });
});

it.each(["timeout", "abort"])("awaits close after %s before rejecting", async kind => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController(); let settled = false;
  const result = snapshotInventory("/tmp", [], false, performance.now() + 1000, controller.signal)
    .catch(error => error).finally(() => { settled = true; });
  if (kind === "abort") controller.abort(); else await vi.advanceTimersByTimeAsync(1001);
  expect(state.child!.kill).toHaveBeenCalledWith("SIGKILL");
  await Promise.resolve(); expect(settled).toBe(false);
  finish(valid, null);
  expect(await result).toMatchObject({ code: kind === "abort" ? "check_snapshot_interrupted" : "check_snapshot_timeout" });
});

it("excludes ambient credentials and preloads from the inventory worker", async () => {
  vi.stubEnv("NODE_OPTIONS", "--require untrusted"); vi.stubEnv("REVIEW_SECRET", "private-value");
  try {
    const result = snapshotInventory("/tmp", ["out/"]);
    expect(Object.keys(state.environment!).sort()).toEqual(["DELIVERY_SNAPSHOT_REQUEST", "PATH"]);
    expect(JSON.parse(state.environment!["DELIVERY_SNAPSHOT_REQUEST"]!)).toMatchObject({ root: "/tmp", outputs: ["out/"] });
    finish(); expect(await result).toBe("a".repeat(64));
  } finally { vi.unstubAllEnvs(); }
});

it("rejects late successful output even when the timeout callback has not run", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const result = snapshotInventory("/tmp", [], false, 200).catch(error => error);
  clock.mockReturnValue(201); finish();
  expect(await result).toMatchObject({ code: "check_snapshot_timeout" });
});

it("shares one deadline across inventories and Git reads, and checks mutable output links", async () => {
  const exec = promisify(execFile), root = await mkdtemp(path.join(tmpdir(), "snapshot-shared-deadline-"));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  let snapshot: Awaited<ReturnType<typeof createCheckSnapshot>> | undefined;
  try {
    state.mode = "record";
    await git("init", "-q"); await writeFile(path.join(root, "file"), "source"); await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const headSha = await git("rev-parse", "HEAD"), treeSha = await git("rev-parse", "HEAD^{tree}");
    snapshot = await createCheckSnapshot({ rootDir: root, candidate: { headSha, treeSha, base: { ref: "origin/main", tipSha: headSha, mergeBaseSha: headSha } }, outputs: ["out/"], environment: {} });
    for (const timeoutMs of [0, -1, NaN, Infinity, 300001]) {
      await expect(snapshot.verify({ timeoutMs })).rejects.toMatchObject({ code: "check_snapshot_timeout" });
    }
    state.rows = []; await snapshot.verify(); expect(state.rows).toHaveLength(3);
    const identities = state.rows[2]!;
    state.mode = "replay";
    for (const malformed of [identities.trim().split("\n").slice(0, 2).join("\n"), identities + "extra\n"]) {
      state.rows[2] = malformed; state.next = 0;
      await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
    }
    state.rows[2] = identities;
    state.mode = "replay"; state.now = 0; state.next = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => state.now);
    // Every child succeeds within 110ms; together they exceed the 300ms budget.
    await expect(snapshot.verify({ timeoutMs: 300 })).rejects.toMatchObject({ code: "check_snapshot_timeout" });
    expect(state.next).toBe(3); clock.mockRestore(); state.mode = "record";
    await mkdir(path.join(snapshot.rootDir, "out"));
    await symlink(root, path.join(snapshot.rootDir, "out", "escape"));
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_escape" });
  } finally { vi.restoreAllMocks(); state.mode = "record"; await snapshot?.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 15000);
