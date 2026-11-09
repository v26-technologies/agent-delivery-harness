import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { candidateTreeSourceReader } from "./portable-inputs.ts";
import { captureScopedCheckInputs } from "./checks.ts";

type FakeChild = { lines: string[]; ended: boolean; killed: boolean; reply(bytes: Buffer, chunk?: number): Promise<void>; fail(event: "error" | "stdin-error"): void };
const fake = vi.hoisted(() => ({ children: [] as FakeChild[] }));
// `cat-file --batch` children are fakes this file answers by hand; every other command is real git.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  return { ...actual, spawn: (command: string, args: string[], options: object) => {
    if (command !== "git" || args[0] !== "cat-file" || args[1] !== "--batch") return actual.spawn(command, args, options as never);
    const child = new EventEmitter() as InstanceType<typeof EventEmitter> & { stdin: InstanceType<typeof Writable>; stdout: InstanceType<typeof PassThrough>; kill(): boolean };
    let closed = false;
    const close = () => { if (closed) return; closed = true; child.stdout.end(); queueMicrotask(() => child.emit("close", 0)); };
    const state: FakeChild = {
      lines: [], ended: false, killed: false,
      async reply(bytes, chunk = bytes.length) {
        for (let at = 0; at < bytes.length; at += chunk) { child.stdout.write(bytes.subarray(at, at + chunk)); await setImmediate(); }
      },
      fail(event) { if (event === "error") { child.emit("error", new Error("fixture spawn refused")); close(); } else child.stdin.emit("error", new Error("fixture pipe closed")); },
    };
    child.stdin = new Writable({
      write(data: Buffer, _encoding, done) { state.lines.push(...data.toString().split("\n").filter(Boolean)); done(); },
      final(done) { state.ended = true; done(); close(); },
    });
    child.stdout = new PassThrough();
    child.kill = () => { state.killed = true; close(); return true; };
    fake.children.push(state);
    return child;
  } };
});
const roots: string[] = [];
afterEach(() => { fake.children.length = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const oid = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function fixture(count = 80) {
  const root = mkdtempSync(path.join(tmpdir(), "source-batch-stream-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root }).toString().trim(); git("init", "-q");
  const paths = Array.from({ length: count }, (_, index) => `file-${String(index).padStart(3, "0")}`), objects = new Map<string, Buffer>();
  for (const file of paths) { const bytes = Buffer.from(file); objects.set(oid(bytes), bytes); writeFileSync(path.join(root, file), bytes); }
  writeFileSync(path.join(root, "file-alias"), Buffer.from(paths[0]!)); git("add", "."); const tree = git("write-tree");
  const frame = (shas: readonly string[]) => Buffer.concat(shas.map(sha => { const bytes = objects.get(sha)!; return Buffer.concat([Buffer.from(`${sha} blob ${bytes.length}\n`), bytes, Buffer.from("\n")]); }));
  return { root, paths, tree, frame };
}
async function started(count = 1) { await vi.waitFor(() => expect(fake.children).toHaveLength(count)); return fake.children[count - 1]!; }

it("answers a burst through one child whose frames arrive split at every byte, and owns cached buffers", async () => {
  const f = fixture(12), read = await candidateTreeSourceReader(f.root, f.tree);
  const pending = Promise.all([...f.paths, "file-alias"].map(file => read(file)));
  const child = await started();
  await setImmediate();
  // The alias names an object already asked for: one line serves both.
  expect(child.lines).toHaveLength(12);
  await child.reply(f.frame(child.lines), 1);
  const result = await pending;
  expect(result).toEqual([...f.paths, f.paths[0]!].map(file => Buffer.from(file)));
  await vi.waitFor(() => expect(child.ended).toBe(true));
  result[0]![0] = 0;
  expect(await read("file-alias")).toEqual(Buffer.from(f.paths[0]!));
  expect(fake.children).toHaveLength(1);
});

it("publishes each verified frame as it arrives while later reads wait, then ends the idle child", async () => {
  const f = fixture(2), read = await candidateTreeSourceReader(f.root, f.tree);
  const states: string[] = [];
  const [first, second] = f.paths.map((file, index) => read(file).then(bytes => { states[index] = "resolved"; return bytes; }));
  const child = await started(); await setImmediate();
  await child.reply(f.frame([child.lines[0]!]));
  expect(await first).toEqual(Buffer.from(f.paths[0]!));
  await setImmediate();
  expect(states[1]).toBeUndefined(); expect(child.ended).toBe(false);
  await child.reply(f.frame([child.lines[1]!]));
  expect(await second).toEqual(Buffer.from(f.paths[1]!));
  await vi.waitFor(() => expect(child.ended).toBe(true)); expect(child.killed).toBe(false);
});

it("drains the child before a scoped capture rejects, preserves the first sorted error, and closes it", async () => {
  const f = fixture(), read = await candidateTreeSourceReader(f.root, f.tree); let settled = false;
  const definition = { version: "scoped-check/1" as const, files: [...f.paths].reverse(), tests: [], memberships: [], cwd: ".", profile: "fixture", environment: [] };
  const first = new Error("earlier sorted metadata failure");
  const pending = captureScopedCheckInputs(definition, { listFiles: async () => f.paths, readFile: read, readMetadata: async file => { if (file === f.paths[0]) throw first; return read.metadata(file); }, command: ["test"], timeoutMs: 1000, runtimeDigest: "a".repeat(64), dependencyDigest: "b".repeat(64), releaseDigest: "c".repeat(64), policyDigest: "d".repeat(64), environment: {}, credentialIdentity: () => null })
    .then(() => ({ ok: true }), error => ({ ok: false, error })).finally(() => { settled = true; });
  const child = await started();
  await vi.waitFor(() => expect(child.lines.length).toBeGreaterThan(0));
  const asked = [...child.lines];
  await child.reply(f.frame(asked.slice(0, -1)));
  await setImmediate();
  // One read is still unanswered: the capture waits for it rather than abandoning the child mid-frame.
  expect(settled).toBe(false); expect(child.ended).toBe(false);
  await child.reply(f.frame(asked.slice(-1)));
  expect(await pending).toEqual({ ok: false, error: first });
  await vi.waitFor(() => expect(child.ended).toBe(true));
  expect(fake.children).toHaveLength(1);
});

it.each(["error", "stdin-error"] as const)("fails the reads a child holds on its %s and starts a new child for the next read", async event => {
  const f = fixture(2), read = await candidateTreeSourceReader(f.root, f.tree);
  const results = Promise.allSettled(f.paths.map(file => read(file)));
  const child = await started(); await setImmediate();
  child.fail(event);
  expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of await results) if (result.status === "rejected") expect(result.reason).toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  if (event === "stdin-error") expect(child.killed).toBe(true);
  const retry = read(f.paths[0]!), next = await started(2); await setImmediate();
  await next.reply(f.frame(next.lines));
  expect(await retry).toEqual(Buffer.from(f.paths[0]!));
});
