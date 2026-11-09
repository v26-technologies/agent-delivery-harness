import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_POSTURE_NETWORK_TIMEOUT_MS,
  DELIVERY_POSTURE_PATH,
  deliveryPostureRefusedOutsideRoot,
  resolveDeliveryPosture,
} from "./index.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
// Each scenario runs many real git commands, which a busy machine can make slow.
vi.setConfig({ testTimeout: 60_000 });
let originalPath: string | undefined;
beforeEach(() => { originalPath = process.env["PATH"]; });
afterEach(async () => {
  process.env["PATH"] = originalPath;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const declaration = (posture: string, reason = "The gate is still being optimized."): string =>
  `${JSON.stringify({ schemaVersion: "delivery-posture/1", posture, reason })}\n`;

/** A real bare remote, a seed that publishes to it, and a real clone of it. */
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "delivery-posture-")); dirs.push(root);
  const remote = path.join(root, "remote.git"), seed = path.join(root, "seed"), repo = path.join(root, "repo");
  const run = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, maxBuffer: 1 << 24 })).stdout.trim();
  await mkdir(remote); await run(remote, "init", "-q", "--bare", "-b", "main");
  await mkdir(seed); await run(seed, "init", "-q", "-b", "main");
  await run(seed, "config", "user.name", "Test"); await run(seed, "config", "user.email", "test@example.invalid");
  await run(seed, "remote", "add", "origin", remote);
  const publish = async (content: string | Buffer | null, branch = "main"): Promise<string> => {
    await mkdir(path.join(seed, ".agents"), { recursive: true });
    const file = path.join(seed, DELIVERY_POSTURE_PATH);
    if (content === null) await rm(file, { force: true });
    else await writeFile(file, content);
    await writeFile(path.join(seed, "touched"), `${Math.random()}\n`);
    await run(seed, "add", "-A"); await run(seed, "-c", "commit.gpgsign=false", "commit", "-qm", "publish");
    await run(seed, "push", "-qf", "origin", `HEAD:refs/heads/${branch}`);
    return run(seed, "rev-parse", "HEAD");
  };
  const first = await publish(null);
  await run(root, "clone", "-q", remote, repo);
  await run(repo, "config", "user.name", "Test"); await run(repo, "config", "user.email", "test@example.invalid");
  const git = (...args: string[]) => run(repo, ...args);
  return {
    root, remote, seed, repo, first, publish, git,
    resolve: (baseRef = "origin/main", networkTimeoutMs?: number) =>
      resolveDeliveryPosture({ rootDir: repo, baseRef, ...(networkTimeoutMs === undefined ? {} : { networkTimeoutMs }) }),
    /** Fetch the remote's tip the ordinary way: this moves the tracking ref only. */
    fetchTracking: () => git("fetch", "-q", "origin"),
    tracking: () => git("rev-parse", "refs/remotes/origin/main"),
    privateRef: () => git("rev-parse", "refs/delivery/posture/main"),
    disconnect: () => git("remote", "set-url", "origin", path.join(root, "gone.git")),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A `git` first on PATH that hangs on the named subcommands, in a process that
 * records its pid, and hands anything else to the real one. A hang is a real
 * hang: nothing here returns early unless the resolver's own bound fires.
 */
async function hangingGit(f: Fixture, subcommands: readonly string[]) {
  const real = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  const bin = path.join(f.root, "shim"); await mkdir(bin, { recursive: true });
  const pidFile = path.join(f.root, "hung.pid");
  const cases = subcommands.map(name => `  *" ${name} "*) sleep 120 & echo $! > "${pidFile}"; wait; exit 0 ;;`).join("\n");
  await writeFile(path.join(bin, "git"), `#!/bin/sh\ncase " $* " in\n${cases}\nesac\nexec "${real}" "$@"\n`);
  await chmod(path.join(bin, "git"), 0o755);
  process.env["PATH"] = `${bin}${path.delimiter}${originalPath}`;
  return { pidFile };
}

/** A killed process lingers until it's reaped, so this waits rather than samples once. */
async function expectGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} outlived the bound`);
}

/** A `git` first on PATH with one shell `case` arm of the caller's, and the real one otherwise. */
async function shimmedGit(f: Fixture, arms: string) {
  const real = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  const bin = path.join(f.root, "shim"); await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "git"), `#!/bin/sh\ncase " $* " in\n${arms}\nesac\nexec "${real}" "$@"\n`);
  await chmod(path.join(bin, "git"), 0o755);
  process.env["PATH"] = `${bin}${path.delimiter}${originalPath}`;
}

const pidIn = async (file: string): Promise<number> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim() !== "") return Number(text.trim());
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`no pid in ${file}`);
};

describe("what the base holds", () => {
  it("resolves a valid focused declaration, naming its reason, source and tip", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused", "Tuning the gate."));
    expect(await f.resolve()).toEqual({ posture: "focused", reason: "Tuning the gate.", source: "origin/main", baseTipSha: tip, code: null });
  });

  it("resolves a valid gate declaration with no code", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("gate", "Back to the gate."));
    expect(await f.resolve()).toEqual({ posture: "gate", reason: "Back to the gate.", source: "origin/main", baseTipSha: tip, code: null });
  });

  it("ignores any other member of a valid declaration", async () => {
    const f = await fixture();
    await f.publish(JSON.stringify({ schemaVersion: "delivery-posture/1", posture: "focused", reason: "r", setBy: "owner", since: "2026-11-04", other: [1] }));
    expect((await f.resolve()).posture).toBe("focused");
  });

  it("names the path and the base when no file is at the tip", async () => {
    const f = await fixture();
    const result = await f.resolve();
    expect(result).toMatchObject({ posture: "gate", code: "posture_undeclared", source: "origin/main", baseTipSha: f.first });
    expect(result.reason).toContain(DELIVERY_POSTURE_PATH);
    expect(result.reason).toContain("origin/main");
  });

  const shape = (over: Record<string, unknown>) => JSON.stringify({ schemaVersion: "delivery-posture/1", posture: "focused", reason: "r", ...over });
  const omit = (name: string) => { const value: Record<string, unknown> = { schemaVersion: "delivery-posture/1", posture: "focused", reason: "r" }; delete value[name]; return JSON.stringify(value); };
  it.each<[string, string | Buffer]>([
    ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
    ["a byte-order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(declaration("focused"))])],
    ["not JSON", "focused\n"],
    ["a JSON array", "[]\n"],
    ["a JSON string", "\"focused\"\n"],
    ["JSON null", "null\n"],
    ["a NaN constant", `{"schemaVersion":"delivery-posture/1","posture":"focused","reason":"r","x":NaN}`],
    ["a missing reason", omit("reason")],
    ["a blank reason", shape({ reason: "" })],
    ["a spaces-only reason", shape({ reason: "  \t\n" })],
    ["a reason only JavaScript trims", shape({ reason: "﻿" })],
    ["a reason only Python trims", shape({ reason: "\x1c\x1d\x1e\x1f\x85" })],
    ["a non-string reason", shape({ reason: 1 })],
    ["a missing schemaVersion", omit("schemaVersion")],
    ["a wrong schemaVersion", shape({ schemaVersion: "delivery-posture/2" })],
    ["Athena's schemaVersion", shape({ schemaVersion: "athena-delivery-posture/1" })],
    ["a missing posture", omit("posture")],
    ["an unknown posture", shape({ posture: "relaxed" })],
    ["a non-string posture", shape({ posture: ["focused"] })],
  ])("treats %s as gate with posture_malformed, reading the tip", async (_name, content) => {
    const f = await fixture();
    const tip = await f.publish(content);
    const result = await f.resolve();
    expect(result).toMatchObject({ posture: "gate", code: "posture_malformed", source: "origin/main", baseTipSha: tip });
    expect(result.reason).toContain(DELIVERY_POSTURE_PATH);
    expect(result.reason).toContain("origin/main");
  });

  it("accepts a reason a zero-width character keeps non-blank in both languages", async () => {
    const f = await fixture();
    await f.publish(declaration("focused", "​"));
    expect(await f.resolve()).toMatchObject({ posture: "focused", code: null });
  });

  it("does not read a symlink at the path, even one whose blob is a valid declaration", async () => {
    const f = await fixture();
    await mkdir(path.join(f.seed, ".agents"), { recursive: true });
    const blob = path.join(f.root, "declaration.json");
    await writeFile(blob, declaration("focused"));
    const sha = await f.git("-C", f.seed, "hash-object", "-w", blob);
    await f.git("-C", f.seed, "update-index", "--add", "--cacheinfo", `120000,${sha},${DELIVERY_POSTURE_PATH}`);
    await f.git("-C", f.seed, "-c", "commit.gpgsign=false", "commit", "-qm", "link");
    await f.git("-C", f.seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_malformed" });
  });

  it("reads an executable declaration, which is still a regular file", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.git("-C", f.seed, "update-index", "--chmod=+x", DELIVERY_POSTURE_PATH);
    await f.git("-C", f.seed, "-c", "commit.gpgsign=false", "commit", "-qm", "executable");
    await f.git("-C", f.seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    expect(await f.resolve()).toMatchObject({ posture: "focused", code: null });
  });

  it("requires a reason of a gate declaration too", async () => {
    const f = await fixture();
    await f.publish(declaration("gate", " "));
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_malformed" });
  });

  it("refuses an invalid byte inside an otherwise valid reason", async () => {
    const f = await fixture();
    await f.publish(Buffer.concat([Buffer.from(`{"schemaVersion":"delivery-posture/1","posture":"focused","reason":"r`), Buffer.from([0xff]), Buffer.from(`"}`)]));
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_malformed" });
  });

  it("does not read a tree at the path", async () => {
    const f = await fixture();
    await mkdir(path.join(f.seed, DELIVERY_POSTURE_PATH), { recursive: true });
    await writeFile(path.join(f.seed, DELIVERY_POSTURE_PATH, "inner.json"), declaration("focused"));
    await f.git("-C", f.seed, "add", "-A"); await f.git("-C", f.seed, "-c", "commit.gpgsign=false", "commit", "-qm", "tree");
    await f.git("-C", f.seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_malformed" });
  });

  it("does not read a submodule at the path", async () => {
    const f = await fixture();
    await mkdir(path.join(f.seed, ".agents"), { recursive: true });
    await f.git("-C", f.seed, "update-index", "--add", "--cacheinfo", `160000,${f.first},${DELIVERY_POSTURE_PATH}`);
    await f.git("-C", f.seed, "-c", "commit.gpgsign=false", "commit", "-qm", "submodule");
    await f.git("-C", f.seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_malformed" });
  });

  it("accepts exactly 64 KiB and refuses one byte more", async () => {
    const sized = (size: number) => {
      const head = `{"schemaVersion":"delivery-posture/1","posture":"focused","reason":"`;
      const tail = `"}`;
      return head + "r".repeat(size - head.length - tail.length) + tail;
    };
    const f = await fixture();
    await f.publish(sized(64 * 1024));
    expect(await f.resolve()).toMatchObject({ posture: "focused", code: null });
    await f.publish(sized(64 * 1024 + 1));
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_malformed" });
  });
});

describe("which base is trusted", () => {
  it("reads the full ref, so a local branch and a tag of the short name do not win", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    await f.fetchTracking();
    // A commit of `focused`, named by a local branch and a tag spelled as the base.
    const focused = await f.publish(declaration("focused"), "elsewhere");
    await f.git("fetch", "-q", "origin", "refs/heads/elsewhere");
    await f.git("branch", "origin/main", focused);
    await f.git("tag", "origin/main", focused);
    await f.git("tag", "main", focused);
    await f.git("branch", "main-local", focused);
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: null, source: "origin/main" });
  });

  it("reads the full ref offline too, so a local branch and a tag of the short name do not win", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    await f.fetchTracking();
    const focused = await f.publish(declaration("focused"), "elsewhere");
    await f.git("fetch", "-q", "origin", "refs/heads/elsewhere");
    await f.git("branch", "origin/main", focused);
    await f.git("tag", "origin/main", focused);
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: null, source: "origin/main" });
  });

  it("does not let a tag or branch named after a missing tracking ref answer for it", async () => {
    const f = await fixture();
    const focused = await f.publish(declaration("focused"), "elsewhere");
    await f.git("fetch", "-q", "origin", "refs/heads/elsewhere");
    await f.git("update-ref", "-d", "refs/remotes/origin/main");
    await f.git("tag", "refs/remotes/origin/main", focused);
    await f.git("branch", "refs/remotes/origin/main", focused);
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("does not answer from a bare repository in the candidate's tree when origin isn't configured", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    const focused = path.join(f.root, "focused.git");
    await f.git("clone", "-q", "--bare", f.remote, focused);
    const work = path.join(f.root, "focused-work");
    await f.git("clone", "-q", focused, work);
    await f.git("-C", work, "config", "user.name", "Test"); await f.git("-C", work, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(work, DELIVERY_POSTURE_PATH), declaration("focused"));
    await f.git("-C", work, "add", "-A"); await f.git("-C", work, "-c", "commit.gpgsign=false", "commit", "-qm", "self-declare");
    await f.git("-C", work, "push", "-q", "origin", "HEAD:refs/heads/main");
    await cp(focused, path.join(f.repo, "origin"), { recursive: true });
    // The control: git really does read that directory as `origin` here.
    await f.git("remote", "remove", "origin");
    expect(await f.git("ls-remote", "origin", "refs/heads/main")).toContain("refs/heads/main");

    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
    await f.git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("does not take a bare layout committed in a subdirectory for the repository", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    const pkg = path.join(f.repo, "pkg");
    await f.git("clone", "-q", "--bare", f.remote, pkg);
    await f.git("-C", pkg, "config", "remote.origin.url", ".");
    const work = path.join(f.root, "pkg-work");
    await f.git("clone", "-q", pkg, work);
    await f.git("-C", work, "config", "user.name", "Test"); await f.git("-C", work, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(work, DELIVERY_POSTURE_PATH), declaration("focused"));
    await f.git("-C", work, "add", "-A"); await f.git("-C", work, "-c", "commit.gpgsign=false", "commit", "-qm", "self-declare");
    await f.git("-C", work, "push", "-q", "origin", "HEAD:refs/heads/main");
    // The control: git really does discover that directory as the repository.
    expect((await exec("git", ["rev-parse", "--git-dir"], { cwd: pkg })).stdout.trim()).toBe(".");

    expect(await resolveDeliveryPosture({ rootDir: pkg, baseRef: "origin/main" })).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("does not read from a plain subdirectory of the repository, naming the directory", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    const nested = path.join(f.repo, "nested"); await mkdir(nested);
    // The control: the root itself reads focused.
    expect(await f.resolve()).toMatchObject({ posture: "focused", code: null, baseTipSha: tip });
    const result = await resolveDeliveryPosture({ rootDir: nested, baseRef: "origin/main" });
    expect(result).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
    expect(result.reason).toContain(nested);
    expect(deliveryPostureRefusedOutsideRoot(result)).toBe(true);
  });

  it("does not let a ref below the tracking ref's name answer for a missing one", async () => {
    const f = await fixture();
    const focused = await f.publish(declaration("focused"));
    await f.fetchTracking();
    await f.git("update-ref", "-d", "refs/remotes/origin/main");
    await f.git("update-ref", "refs/remotes/origin/main/stale", focused);
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("takes the default only from HEAD's own symref line", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    const sha = await f.tracking();
    await shimmedGit(f, `  *" ls-remote "*) printf 'ref: refs/heads/main\\trefs/heads/other\\n${sha}\\tHEAD\\n'; exit 0 ;;`);
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
  });

  it.each(["GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"])("reads the repository it's asked about, whatever %s an ancestor left set", async (name) => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    const other = await fixture();
    await other.publish(declaration("focused"));
    await other.resolve();
    process.env[name] = name === "GIT_NAMESPACE" ? "elsewhere" : name === "GIT_COMMON_DIR" ? path.join(other.repo, ".git") : path.join(other.repo, ".git/objects");
    try {
      expect(await f.resolve()).toMatchObject({ posture: "gate", code: null });
    } finally { delete process.env[name]; }
  });

  it.each(["ls-tree", "cat-file"])("gives posture_unreadable when %s fails", async (subcommand) => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await shimmedGit(f, `  *" ${subcommand} "*) exit 128 ;;`);
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("does not let a local replace ref change what the base holds", async () => {
    const f = await fixture();
    const gateTip = await f.publish(declaration("gate"));
    const focusedTip = await f.publish(declaration("focused"), "elsewhere");
    await f.publish(declaration("gate"));
    await f.git("fetch", "-q", "origin");
    const tip = await f.tracking();
    expect(gateTip).not.toBe(focusedTip);
    const blob = (branch: string) => f.git("rev-parse", `${branch}:${DELIVERY_POSTURE_PATH}`);
    await f.git("replace", await blob("refs/remotes/origin/main"), await blob("refs/remotes/origin/elsewhere"));
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: null, baseTipSha: tip });
    await f.git("replace", tip, focusedTip);
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: null, baseTipSha: tip });
  });

  it("reads the repository it's asked about, whatever GIT_DIR an ancestor left set", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    const other = await fixture();
    await other.publish(declaration("focused"));
    await other.fetchTracking();
    await other.resolve();
    process.env["GIT_DIR"] = path.join(other.repo, ".git");
    try {
      expect(await f.resolve()).toMatchObject({ posture: "gate", code: null });
    } finally { delete process.env["GIT_DIR"]; }
  });

  it("reaches a remote through what the operator's environment carries", async () => {
    // The remote's URL rewrites to the real one only through inherited GIT_CONFIG_*.
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    const tip = await f.publish(declaration("gate"));
    const alias = "reachable-only-through-env:";
    await f.git("remote", "set-url", "origin", `${alias}remote.git`);
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${f.remote}.insteadOf`, GIT_CONFIG_VALUE_0: `${alias}remote.git` });
    try {
      expect(await f.resolve()).toMatchObject({ posture: "gate", code: null, baseTipSha: tip });
    } finally {
      for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete process.env[name];
    }
  });

  it("does not take a detached remote HEAD's default from what was recorded earlier", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    await f.fetchTracking();
    await writeFile(path.join(f.remote, "HEAD"), `${tip}\n`);
    expect(await f.git("symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
  });

  it("gives the tip's posture whichever way a candidate branched", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    await f.git("checkout", "-q", "-b", "from-focused", "origin/main");
    await f.publish(declaration("gate"));
    expect((await f.resolve()).posture).toBe("gate");
    await f.fetchTracking();
    await f.git("checkout", "-q", "-b", "from-gate", "origin/main");
    await f.publish(declaration("focused"));
    expect((await f.resolve()).posture).toBe("focused");
  });

  it("ignores a declaration on the candidate", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    await f.fetchTracking();
    await f.git("checkout", "-q", "-b", "candidate", "origin/main");
    await writeFile(path.join(f.repo, DELIVERY_POSTURE_PATH), declaration("focused"));
    await f.git("add", "-A"); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "self-declare");
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: null });
  });

  it("reads the remote's new tip without moving the tracking ref", async () => {
    const f = await fixture();
    const stale = await f.tracking();
    const tip = await f.publish(declaration("focused"));
    expect(await f.resolve()).toMatchObject({ posture: "focused", baseTipSha: tip, code: null });
    expect(await f.tracking()).toBe(stale);
    expect(await f.privateRef()).toBe(tip);
  });

  it("moves a stale private ref to the remote's new tip when the fetch succeeds", async () => {
    const f = await fixture();
    const before = await f.publish(declaration("focused"));
    await f.resolve();
    expect(await f.privateRef()).toBe(before);
    const tip = await f.publish(declaration("gate"));
    expect(await f.resolve()).toMatchObject({ posture: "gate", baseTipSha: tip, code: null });
    expect(await f.privateRef()).toBe(tip);
  });

  it("follows a force-pushed base rather than holding a stale focused", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.resolve();
    await f.fetchTracking();
    await f.git("-C", f.seed, "reset", "-q", "--hard", f.first);
    const tip = await f.publish(declaration("gate"));
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: null, baseTipSha: tip });
    expect(await f.privateRef()).toBe(tip);
  });

  it("leaves FETCH_HEAD as it was, in a repository that declares nothing", async () => {
    const f = await fixture();
    await f.publish(null, "topic");
    await f.git("fetch", "-q", "origin", "refs/heads/topic");
    const before = await readFile(path.join(f.repo, ".git/FETCH_HEAD"), "utf8");
    await f.publish(null);
    expect(await f.resolve()).toMatchObject({ code: "posture_undeclared" });
    expect(await readFile(path.join(f.repo, ".git/FETCH_HEAD"), "utf8")).toBe(before);
  });

  it.each(["main", "refs/remotes/origin/main", "upstream/main", "origin/", "origin/-x"])("gives %s posture_unreadable", async (baseRef) => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    expect(await f.resolve(baseRef)).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("refuses a branch that publishes itself as its own base", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"), "self");
    await f.fetchTracking();
    expect(await f.resolve("origin/self")).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("offline, reads the default from origin/HEAD and still refuses a self-publishing branch", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"), "self");
    await f.fetchTracking();
    await f.disconnect();
    expect(await f.git("symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
    expect(await f.resolve("origin/self")).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
  });

  it("offline with origin/HEAD absent, cannot determine the default", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    await f.disconnect();
    await f.git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
  });

  it("gives posture_unreadable where there is no remote at all", async () => {
    const f = await fixture();
    await f.git("remote", "remove", "origin");
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("gives posture_unreadable outside a repository and never rejects", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "delivery-posture-none-")); dirs.push(dir);
    await expect(resolveDeliveryPosture({ rootDir: dir, baseRef: "origin/main" })).resolves.toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
    await expect(resolveDeliveryPosture({ rootDir: path.join(dir, "missing"), baseRef: "origin/main" })).resolves.toMatchObject({ posture: "gate", code: "posture_unreadable" });
  });

  it("gives posture_unreadable when git cannot be started", async () => {
    const f = await fixture();
    process.env["PATH"] = path.join(f.root, "no-such-bin");
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
  });
});

describe("a failed fetch", () => {
  it("with a fetched focused tip, resolves focused with no code", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    await f.fetchTracking();
    await f.disconnect();
    expect(await f.resolve()).toEqual({ posture: "focused", reason: "The gate is still being optimized.", source: "origin/main", baseTipSha: tip, code: null });
  });

  it.each([
    ["the private ref focused and the tracking ref gate", "focused", "gate", "tracking"],
    ["the tracking ref focused and the private ref gate", "gate", "focused", "private"],
  ])("with %s, is gate at the ref that said so", async (_name, privateSays, trackingSays, expected) => {
    const f = await fixture();
    const privateTip = await f.publish(declaration(privateSays));
    await f.resolve();
    const trackingTip = await f.publish(declaration(trackingSays));
    await f.fetchTracking();
    expect(await f.privateRef()).toBe(privateTip);
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: null, baseTipSha: expected === "tracking" ? trackingTip : privateTip });
  });

  it("with two different focused tips, is focused at the tracking ref's tip", async () => {
    const f = await fixture();
    await f.publish(declaration("focused", "older"));
    await f.resolve();
    const trackingTip = await f.publish(declaration("focused", "newer"));
    await f.fetchTracking();
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "focused", reason: "newer", code: null, baseTipSha: trackingTip });
  });

  it("with the tracking ref missing and the private ref focused, is posture_unreadable", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.resolve();
    await f.git("update-ref", "-d", "refs/remotes/origin/main");
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("with the private ref focused and the tracking ref malformed, is posture_malformed", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.resolve();
    const tip = await f.publish("not json");
    await f.fetchTracking();
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_malformed", baseTipSha: tip });
  });

  it("with the private ref focused and the tracking ref undeclared, is posture_undeclared", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.resolve();
    const tip = await f.publish(null);
    await f.fetchTracking();
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_undeclared", baseTipSha: tip });
  });

  it("with the tracking ref focused and the private ref undeclared, then malformed, carries the private ref's code", async () => {
    const f = await fixture();
    const undeclared = await f.publish(null);
    await f.resolve();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_undeclared", baseTipSha: undeclared });

    const g = await fixture();
    const malformed = await g.publish("not json");
    await g.resolve();
    await g.publish(declaration("focused"));
    await g.fetchTracking();
    await g.disconnect();
    expect(await g.resolve()).toMatchObject({ posture: "gate", code: "posture_malformed", baseTipSha: malformed });
  });

  it("with the tracking ref focused and the private ref unlistable, is posture_unreadable", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    await f.resolve();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    await f.disconnect();
    await shimmedGit(f, `  *for-each-ref*refs/delivery/posture/main*) exit 128 ;;`);
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
  });

  it("when both refs are non-focused with different codes, the tracking ref's code wins", async () => {
    const f = await fixture();
    await f.publish("not json");
    await f.resolve();
    const tip = await f.publish(null);
    await f.fetchTracking();
    await f.disconnect();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_undeclared", baseTipSha: tip });
  });
});

describe("the bound on every network call", () => {
  it("is fifteen seconds", () => {
    expect(DELIVERY_POSTURE_NETWORK_TIMEOUT_MS).toBe(15_000);
  });

  it("holds by default on a hanging fetch, with a fetched focused tip still focused", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    await f.fetchTracking();
    const { pidFile } = await hangingGit(f, ["fetch"]);
    const started = Date.now();
    const result = await f.resolve();
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ posture: "focused", code: null, baseTipSha: tip });
    expect(elapsed).toBeGreaterThanOrEqual(DELIVERY_POSTURE_NETWORK_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(DELIVERY_POSTURE_NETWORK_TIMEOUT_MS + 10_000);
    // The whole process group went, not only the immediate child.
    await expectGone(await pidIn(pidFile));
  }, 40_000);

  it("holds on a hanging ls-remote with origin/HEAD absent: posture_unreadable", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    await f.git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    await hangingGit(f, ["ls-remote"]);
    const started = Date.now();
    expect(await f.resolve("origin/main", 400)).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("holds on a hanging ls-remote with origin/HEAD naming the default and a fetched focused tip: focused", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    await f.fetchTracking();
    await hangingGit(f, ["ls-remote", "fetch"]);
    const started = Date.now();
    expect(await f.resolve("origin/main", 400)).toMatchObject({ posture: "focused", code: null, baseTipSha: tip });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("holds when a helper in its own session keeps the pipes open after git has gone", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    await f.fetchTracking();
    const pidFile = path.join(f.root, "helper.pid");
    const helper = path.join(f.root, "helper.cjs");
    await writeFile(helper, `const c=require("node:child_process").spawn("sleep",["60"],{detached:true,stdio:["ignore",1,2]});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();`);
    await shimmedGit(f, `  *" fetch "*) "${process.execPath}" "${helper}"; exit 0 ;;`);
    const started = Date.now();
    try {
      expect(await f.resolve("origin/main", 2_000)).toMatchObject({ posture: "focused", code: null, baseTipSha: tip });
      expect(Date.now() - started).toBeLessThan(12_000);
    } finally {
      process.kill(await pidIn(pidFile), "SIGKILL");
    }
  }, 30_000);

  it("bounds a local read too: a hanging git is posture_unreadable", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    await f.disconnect();
    await hangingGit(f, ["symbolic-ref"]);
    const started = Date.now();
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
    expect(Date.now() - started).toBeLessThan(DELIVERY_POSTURE_NETWORK_TIMEOUT_MS + 10_000);
  }, 40_000);

  it("stops at once on an abort, killing what it started", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    const { pidFile } = await hangingGit(f, ["ls-remote"]);
    const controller = new AbortController();
    const started = Date.now();
    const pending = resolveDeliveryPosture({ rootDir: f.repo, baseRef: "origin/main", signal: controller.signal });
    const hung = await pidIn(pidFile);
    controller.abort();
    expect(await pending).toMatchObject({ posture: "gate", code: "posture_unreadable" });
    expect(Date.now() - started).toBeLessThan(10_000);
    await expectGone(hung);
  }, 30_000);

  it("runs nothing when it's already aborted", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.fetchTracking();
    const controller = new AbortController();
    controller.abort();
    expect(await resolveDeliveryPosture({ rootDir: f.repo, baseRef: "origin/main", signal: controller.signal })).toMatchObject({ posture: "gate", code: "posture_unreadable" });
  });

  it("does not move the tracking ref or fetch tags into the repository", async () => {
    const f = await fixture();
    await f.git("-C", f.seed, "tag", "seed-tag");
    await f.git("-C", f.seed, "push", "-q", "origin", "seed-tag");
    const stale = await f.tracking();
    await f.publish(declaration("focused"));
    await f.resolve();
    expect(await f.tracking()).toBe(stale);
    expect(await f.git("tag", "--list", "seed-tag")).toBe("");
  });
});

/** A focused declaration with `extra` spliced in as further members, as raw JSON text. */
const focusedWith = (extra: string): string => `{"schemaVersion":"delivery-posture/1","posture":"focused","reason":"r",${extra}}`;

/**
 * A `git` first on PATH that behaves as one before 2.38, which has no
 * `safe.bareRepository`: it drops the resolver's `-c safe.bareRepository=explicit`
 * pair and runs the real git with no global or system config, so nothing else
 * restores the setting.
 */
async function preBareSafetyGit(dir: string): Promise<string> {
  const real = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  const bin = path.join(dir, "old-git"); await mkdir(bin, { recursive: true });
  const wrapper = path.join(bin, "git");
  await writeFile(wrapper, [
    "#!/bin/sh",
    "first=1; pending=0",
    "for arg do",
    "  if [ \"$first\" = 1 ]; then set --; first=0; fi",
    "  if [ \"$pending\" = 1 ]; then",
    "    pending=0",
    "    if [ \"$arg\" = safe.bareRepository=explicit ]; then continue; fi",
    "    set -- \"$@\" -c",
    "  fi",
    "  if [ \"$arg\" = -c ]; then pending=1; continue; fi",
    "  set -- \"$@\" \"$arg\"",
    "done",
    "if [ \"$pending\" = 1 ]; then set -- \"$@\" -c; fi",
    `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 exec "${real}" "$@"`,
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  return wrapper;
}

/** A second, unrelated published repository whose base declares focused: what a nested route would answer from. */
async function focusedElsewhere() {
  const other = await fixture();
  const tip = await other.publish(declaration("focused", "Declared by another repository."));
  return { other, tip };
}

const refusedAtRoot = (result: Awaited<ReturnType<typeof resolveDeliveryPosture>>, dir: string) => {
  expect(result).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  expect(result.reason).toContain(dir);
  expect(deliveryPostureRefusedOutsideRoot(result)).toBe(true);
};

describe("which directory is read", () => {
  it("does not read from a real nested repository whose origin declares focused", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    const { other } = await focusedElsewhere();
    const nested = path.join(f.repo, "vendor", "nested");
    await mkdir(path.dirname(nested), { recursive: true });
    await f.git("clone", "-q", other.remote, nested);
    // The controls: the root reads focused, and git takes the nested directory as a work tree's root.
    expect(await f.resolve()).toMatchObject({ posture: "focused", code: null });
    expect(await realpath((await exec("git", ["rev-parse", "--show-toplevel"], { cwd: nested })).stdout.trim())).toBe(await realpath(nested));
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: nested, baseRef: "origin/main" }), nested);
  });

  it("does not read from an initialised submodule whose origin declares focused", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    const { other } = await focusedElsewhere();
    await f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", other.remote, "sub");
    await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "a submodule");
    const sub = path.join(f.repo, "sub");
    expect(await f.resolve()).toMatchObject({ posture: "focused", code: null });
    expect(await f.git("-C", sub, "rev-parse", "--show-superproject-working-tree")).not.toBe("");
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: sub, baseRef: "origin/main" }), sub);
  });

  it("refuses a submodule for being one, even where the enclosing work tree is not seen", async () => {
    // Every real submodule's git directory differs from its superproject's, so the nested rule refuses it too.
    // This answers the enclosing check with false, so only the submodule rule stands between it and focused.
    const f = await fixture();
    await f.publish(declaration("focused"));
    const { other } = await focusedElsewhere();
    await f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", other.remote, "sub");
    await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "a submodule");
    const sub = path.join(f.repo, "sub");
    await shimmedGit(f, `  *" rev-parse --is-inside-work-tree "*) echo false; exit 0 ;;`);
    // The control: under the shim, the enclosing work tree is not seen.
    expect((await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: f.repo })).stdout.trim()).toBe("false");
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: sub, baseRef: "origin/main" }), sub);
  });

  it("does not read through an untracked gitfile pointing at a repository that declares focused", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    const { other } = await focusedElsewhere();
    await other.git("fetch", "-q", "origin");
    const pkg = path.join(f.repo, "pkg"); await mkdir(pkg);
    await writeFile(path.join(pkg, ".git"), `gitdir: ${path.join(other.repo, ".git")}\n`);
    expect(await f.resolve()).toMatchObject({ posture: "focused", code: null });
    // The control: from there, git answers as the other repository, whose base declares focused.
    expect(await realpath((await exec("git", ["rev-parse", "--show-toplevel"], { cwd: pkg })).stdout.trim())).toBe(await realpath(pkg));
    expect((await exec("git", ["config", "--get", "remote.origin.url"], { cwd: pkg })).stdout.trim()).toBe(other.remote);
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: pkg, baseRef: "origin/main" }), pkg);
  });

  it.each([
    ["a bare layout git refuses to open", "bare"],
    ["a gitfile pointing nowhere", "broken"],
  ])("does not read from a real nested repository under %s inside the root", async (_name, kind) => {
    // From such a directory git fails rather than say it is in a work tree, so its answer hides the root's.
    const f = await fixture();
    await f.publish(declaration("focused"));
    const { other } = await focusedElsewhere();
    const holder = path.join(f.repo, kind);
    if (kind === "bare") await f.git("clone", "-q", "--bare", other.remote, holder);
    else { await mkdir(holder); await writeFile(path.join(holder, ".git"), `gitdir: ${path.join(f.root, "nowhere")}\n`); }
    const nested = path.join(holder, "nested");
    await f.git("clone", "-q", other.remote, nested);
    // The control: from the nested repository's parent, git fails.
    await expect(exec("git", ["-c", "safe.bareRepository=explicit", "rev-parse", "--is-inside-work-tree"], { cwd: holder })).rejects.toThrow();
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: nested, baseRef: "origin/main" }), nested);
  });

  it.each([
    ["a bare layout git refuses to open", "bare"],
    ["a gitfile pointing nowhere", "broken"],
  ])("does not read from a real nested repository whose only enclosing layout is its parent, %s", async (_name, kind) => {
    // No work tree holds the parent, so nothing above it refuses: the parent's own place in the walk decides.
    const { other } = await focusedElsewhere();
    const outside = await mkdtemp(path.join(tmpdir(), "delivery-posture-holder-")); dirs.push(outside);
    const holder = path.join(outside, kind);
    if (kind === "bare") await exec("git", ["clone", "-q", "--bare", other.remote, holder]);
    else { await mkdir(holder); await writeFile(path.join(holder, ".git"), `gitdir: ${path.join(outside, "nowhere")}\n`); }
    const nested = path.join(holder, "nested");
    await exec("git", ["clone", "-q", other.remote, nested]);
    // The controls: git fails from the parent, and nothing above the parent is in a work tree.
    await expect(exec("git", ["-c", "safe.bareRepository=explicit", "rev-parse", "--is-inside-work-tree"], { cwd: holder })).rejects.toThrow();
    expect((await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: outside }).catch(() => ({ stdout: "no repository" }))).stdout.trim()).not.toBe("true");
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: nested, baseRef: "origin/main" }), nested);
  });

  it("does not read from a linked worktree of a real nested repository", async () => {
    // Its parent is the nested clone, which shares its git directory: only the root above encloses it with another.
    const f = await fixture();
    await f.publish(declaration("focused"));
    const { other } = await focusedElsewhere();
    const nested = path.join(f.repo, "vendor", "nested");
    await mkdir(path.dirname(nested), { recursive: true });
    await f.git("clone", "-q", other.remote, nested);
    const linked = path.join(nested, ".wt");
    await f.git("-C", nested, "worktree", "add", "-q", "--detach", linked);
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: nested, baseRef: "origin/main" }), nested);
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: linked, baseRef: "origin/main" }), linked);
  });

  it("refuses when the probe of the parent's work tree times out", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    const lane = path.join(f.repo, ".orchestration", "lanes", "V26-0003");
    await f.git("worktree", "add", "-q", "--detach", lane);
    // The control: unhindered, the nested worktree reads focused.
    expect(await resolveDeliveryPosture({ rootDir: lane, baseRef: "origin/main" })).toMatchObject({ posture: "focused", code: null });
    const { pidFile } = await hangingGit(f, ["rev-parse --is-inside-work-tree"]);
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: lane, baseRef: "origin/main" }), lane);
    await expectGone(await pidIn(pidFile));
  });

  /** A bare clone of a focused base on its own, in a temporary directory no work tree holds. */
  async function standaloneBare() {
    const { other, tip } = await focusedElsewhere();
    const holder = await mkdtemp(path.join(tmpdir(), "delivery-posture-bare-")); dirs.push(holder);
    const bare = path.join(holder, "standalone.git");
    await exec("git", ["clone", "-q", "--bare", other.remote, bare]);
    await exec("git", ["--git-dir", bare, "update-ref", "refs/remotes/origin/main", tip]);
    return { holder, bare, tip };
  }

  it("does not read a standalone bare repository under a git with no safe.bareRepository", async () => {
    const { holder, bare } = await standaloneBare();
    const wrapper = await preBareSafetyGit(holder);
    // The controls: under the wrapper, the resolver's own invocation reads the bare repository's base, and
    // the parent is in no work tree.
    await exec(wrapper, ["-c", "safe.bareRepository=explicit", "rev-parse", "--verify", "refs/remotes/origin/main"], { cwd: bare });
    expect((await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: holder }).catch(() => ({ stdout: "no repository" }))).stdout.trim()).not.toBe("true");
    process.env["PATH"] = `${path.dirname(wrapper)}${path.delimiter}${originalPath}`;
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: bare, baseRef: "origin/main" }), bare);
  });

  it("does not read a standalone bare repository under this git either, by git's own refusal", async () => {
    const { bare } = await standaloneBare();
    await expect(exec("git", ["-c", "safe.bareRepository=explicit", "rev-parse", "--verify", "refs/remotes/origin/main"], { cwd: bare })).rejects.toThrow();
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: bare, baseRef: "origin/main" }), bare);
  });

  it.each([["this git", false], ["a git with no safe.bareRepository", true]])("does not read a bare repository embedded in the tree, under %s", async (_name, old) => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    const { other } = await focusedElsewhere();
    const pkg = path.join(f.repo, "pkg");
    await f.git("clone", "-q", "--bare", other.remote, pkg);
    if (old) process.env["PATH"] = `${path.dirname(await preBareSafetyGit(f.root))}${path.delimiter}${originalPath}`;
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: pkg, baseRef: "origin/main" }), pkg);
  });

  /** A nested lane worktree, which reads focused when nothing fails, and the main checkout above it. */
  async function nestedLane(f: Fixture) {
    await f.publish(declaration("focused"));
    const lane = path.join(f.repo, ".orchestration", "lanes", "V26-0004");
    await f.git("worktree", "add", "-q", "--detach", lane);
    expect(await resolveDeliveryPosture({ rootDir: lane, baseRef: "origin/main" })).toMatchObject({ posture: "focused", code: null });
    return { lane, main: await realpath(f.repo) };
  }

  it.each([["the directory's own", "lane"], ["the enclosing main checkout's", "main"]])("refuses when %s git common directory does not read", async (_name, which) => {
    const f = await fixture();
    const { lane, main } = await nestedLane(f);
    const where = which === "lane" ? await realpath(lane) : main;
    await shimmedGit(f, `  *" rev-parse --git-common-dir "*) if [ "$(pwd -P)" = "${where}" ]; then exit 128; fi ;;`);
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: lane, baseRef: "origin/main" }), lane);
  });

  it("refuses a clone with no repository above it when its own git common directory does not read", async () => {
    // Nothing above the clone could refuse it instead, so only the directory's own probe stands between it and a read.
    const f = await fixture();
    await f.publish(declaration("focused"));
    const where = await realpath(f.repo);
    await shimmedGit(f, `  *" rev-parse --git-common-dir "*) if [ "$(pwd -P)" = "${where}" ]; then exit 128; fi ;;`);
    refusedAtRoot(await f.resolve(), f.repo);
  });

  it("refuses when git fails to name the work tree, whatever it printed", async () => {
    // git prints the directory itself and still fails, so only the exit code tells the answer apart.
    const f = await fixture();
    await f.publish(declaration("focused"));
    const where = await realpath(f.repo);
    await shimmedGit(f, `  *" rev-parse --show-toplevel "*) echo "${where}"; exit 128 ;;`);
    const result = await f.resolve();
    refusedAtRoot(result, f.repo);
    expect(result.reason).toContain("it is not in a work tree");
  });

  it("refuses when git cannot say whether the directory is a submodule's", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await shimmedGit(f, `  *" rev-parse --show-superproject-working-tree "*) exit 128 ;;`);
    refusedAtRoot(await f.resolve(), f.repo);
  });

  it("compares the git common directories as the file system resolves them", async () => {
    // git prints the enclosing main checkout's common directory through a symlink to it, so only the
    // canonical paths are equal.
    const f = await fixture();
    const { lane, main } = await nestedLane(f);
    const alias = path.join(f.root, "alias-of-git-dir");
    await symlink(path.join(main, ".git"), alias);
    await shimmedGit(f, `  *" rev-parse --git-common-dir "*) if [ "$(pwd -P)" = "${main}" ]; then echo "${alias}"; exit 0; fi ;;`);
    expect(await resolveDeliveryPosture({ rootDir: lane, baseRef: "origin/main" })).toMatchObject({ posture: "focused", code: null });
  });

  /** The ways one root is named: as made, and through a symlink to it, as macOS reaches temporary folders through `/var`. */
  async function namings(dir: string, holder: string): Promise<readonly string[]> {
    const link = path.join(holder, `link-${path.basename(dir)}-${Math.random().toString(36).slice(2)}`);
    await symlink(dir, link);
    expect(await realpath(link)).not.toBe(link);
    return [dir, link];
  }

  it("reads a normal clone from its root, however the root is named", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    for (const rootDir of await namings(f.repo, f.root)) {
      expect(await resolveDeliveryPosture({ rootDir, baseRef: "origin/main" }), rootDir).toEqual({ posture: "focused", reason: "The gate is still being optimized.", source: "origin/main", baseTipSha: tip, code: null });
    }
  });

  it("reads a linked worktree outside its main checkout from its root, however the root is named", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    const linked = path.join(f.root, "linked");
    await f.git("worktree", "add", "-q", "--detach", linked);
    for (const rootDir of await namings(linked, f.root)) {
      expect(await resolveDeliveryPosture({ rootDir, baseRef: "origin/main" }), rootDir).toMatchObject({ posture: "focused", code: null, baseTipSha: tip });
    }
  });

  it("reads a linked worktree nested under its main checkout from its root, however the root is named", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    const lane = path.join(f.repo, ".orchestration", "lanes", "V26-0001");
    await f.git("worktree", "add", "-q", "--detach", lane);
    // The control: its parent is inside the main checkout's work tree.
    expect((await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path.dirname(lane) })).stdout.trim()).toBe("true");
    for (const rootDir of await namings(lane, f.root)) {
      expect(await resolveDeliveryPosture({ rootDir, baseRef: "origin/main" }), rootDir).toMatchObject({ posture: "focused", code: null, baseTipSha: tip });
    }
  });

  it("reads a linked worktree inside its own bare repository from its root, however the root is named", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    const bare = path.join(f.root, "project.git");
    await exec("git", ["clone", "-q", "--bare", f.remote, bare]);
    await exec("git", ["--git-dir", bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await exec("git", ["--git-dir", bare, "fetch", "-q", "origin"]);
    await exec("git", ["--git-dir", bare, "remote", "set-head", "origin", "main"]);
    const linked = path.join(bare, "main");
    await exec("git", ["--git-dir", bare, "worktree", "add", "-q", "--detach", linked]);
    // The control: from inside the bare repository, git told to honour only an explicit one refuses.
    await expect(exec("git", ["-c", "safe.bareRepository=explicit", "rev-parse", "--git-common-dir"], { cwd: bare })).rejects.toThrow();
    for (const rootDir of await namings(linked, f.root)) {
      expect(await resolveDeliveryPosture({ rootDir, baseRef: "origin/main" }), rootDir).toMatchObject({ posture: "focused", code: null, baseTipSha: tip });
    }
  });

  it("reads the root's own declaration with a nested worktree, a nested repository and a submodule beside it", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("gate", "The root's own."));
    const { other } = await focusedElsewhere();
    await f.git("clone", "-q", other.remote, path.join(f.repo, "nested"));
    await f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", other.remote, "sub");
    await f.git("worktree", "add", "-q", "--detach", path.join(f.repo, ".orchestration", "lanes", "V26-0002"));
    expect(await f.resolve()).toEqual({ posture: "gate", reason: "The root's own.", source: "origin/main", baseTipSha: tip, code: null });
  });

  it("names the directory and refuses one that does not exist", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    const gone = path.join(f.root, "gone");
    refusedAtRoot(await resolveDeliveryPosture({ rootDir: gone, baseRef: "origin/main" }), gone);
  });

  it("leaves every other refusal unmarked", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    expect(deliveryPostureRefusedOutsideRoot(await f.resolve("main"))).toBe(false);
    await f.disconnect();
    await f.git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const offline = await f.resolve();
    expect(offline).toMatchObject({ posture: "gate", code: "posture_unreadable" });
    expect(deliveryPostureRefusedOutsideRoot(offline)).toBe(false);
    expect(deliveryPostureRefusedOutsideRoot({ ...offline })).toBe(false);
  });
});

describe("what the fetch leaves alone", () => {
  /** Two loose objects under `objects/17/`, which is what git samples to decide that auto maintenance is due. */
  async function dueForMaintenance(f: Fixture): Promise<void> {
    const found: string[] = [];
    for (let i = 0; found.length < 2; i += 1) {
      const content = `loose ${i}\n`;
      const sha = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
      if (sha.startsWith("17")) found.push(content);
    }
    for (const [index, content] of found.entries()) {
      const file = path.join(f.root, `loose-${index}`); await writeFile(file, content);
      await f.git("hash-object", "-w", file);
    }
    await f.git("config", "gc.auto", "1");
    await f.git("config", "gc.autoDetach", "false");
    await f.git("config", "maintenance.autoDetach", "false");
    // Newer git's automatic maintenance can leave out the gc task, whose check runs the pre-auto-gc hook, so turn it on.
    await f.git("config", "maintenance.gc.enabled", "true");
  }

  it("runs no auto maintenance", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await dueForMaintenance(f);
    const marker = path.join(f.root, "maintenance-ran");
    const hook = path.join(f.repo, ".git", "hooks", "pre-auto-gc");
    await writeFile(hook, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`); await chmod(hook, 0o755);
    // The control: a fetch that leaves maintenance on reaches the hook.
    await f.git("fetch", "-q", "origin");
    expect(existsSync(marker)).toBe(true);
    await rm(marker);
    await f.publish(declaration("focused"));
    expect(await f.resolve()).toMatchObject({ posture: "focused", code: null });
    expect(existsSync(marker)).toBe(false);
  });

  it("fetches no submodule", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    const { other } = await focusedElsewhere();
    await f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", other.remote, "sub");
    await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "a submodule");
    const sub = path.join(f.repo, "sub");
    await f.git("-C", sub, "config", "protocol.file.allow", "always");
    await f.git("config", "fetch.recurseSubmodules", "true");
    const before = await f.git("-C", sub, "rev-parse", "refs/remotes/origin/main");
    await other.publish(declaration("gate"));
    // The tracking ref is still at the clone's undeclared tip, so a failed fetch would read posture_undeclared.
    expect(await f.resolve()).toMatchObject({ posture: "focused", code: null, baseTipSha: tip });
    expect(await f.git("-C", sub, "rev-parse", "refs/remotes/origin/main")).toBe(before);
    // The control: the same fetch with recursion left on moves the submodule's ref.
    await f.git("fetch", "--no-tags", "--refmap=", "--no-write-fetch-head", "--no-auto-maintenance", "origin", "+refs/heads/main:refs/delivery/posture/main");
    expect(await f.git("-C", sub, "rev-parse", "refs/remotes/origin/main")).not.toBe(before);
  });
});

describe("each read's own guard", () => {
  it.each([["its size", "cat-file -s"], ["its content", "cat-file blob"]])("gives posture_unreadable when only reading %s fails", async (_name, pattern) => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await shimmedGit(f, `  *" ${pattern} "*) exit 128 ;;`);
    expect(await f.resolve()).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback", baseTipSha: null });
  });

  it("reads origin's URL from the repository it's asked about, whatever GIT_DIR an ancestor left set", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    await f.git("remote", "remove", "origin");
    const { other } = await focusedElsewhere();
    process.env["GIT_DIR"] = path.join(other.repo, ".git");
    try {
      const result = await f.resolve();
      expect(result).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
      expect(result.reason).toContain("origin is not a configured remote");
    } finally { delete process.env["GIT_DIR"]; }
  });
});

describe("how deep a declaration may nest", () => {
  const nestArrays = (depth: number, name = "deep") => `"${name}":${"[".repeat(depth - 1)}${"]".repeat(depth - 1)}`;
  const nestObjects = (depth: number, name = "deep") => `"${name}":${`{"k":`.repeat(depth - 2)}{}${"}".repeat(depth - 2)}`;
  /** Depth reached by alternating an object and an array under the top-level object, so neither kind alone is deep. */
  const nestAlternating = (depth: number, name = "deep") => {
    let open = "", close = "";
    for (let level = 2; level <= depth; level += 1) {
      if (level % 2 === 0) { open += `{"k":`; close = `}${close}`; } else { open += "["; close = `]${close}`; }
    }
    return `"${name}":${open}1${close}`;
  };
  const siblings = (count: number, value: string) => Array.from({ length: count }, (_, i) => `"s${i}":${value}`).join(",");
  const deepest = (): string => {
    const head = `{"schemaVersion":"delivery-posture/1","posture":"focused","reason":"r","deep":`;
    const levels = Math.floor((64 * 1024 - head.length - 1) / 2);
    return `${head}${"[".repeat(levels)}${"]".repeat(levels)}}`;
  };
  it.each<[string, string, "focused" | "malformed"]>([
    ["one member nested 64 deep", focusedWith(nestArrays(64)), "focused"],
    ["one member nested 65 deep", focusedWith(nestArrays(65)), "malformed"],
    ["one member nested 1500 deep", focusedWith(nestArrays(1500)), "malformed"],
    ["the deepest nesting 64 KiB can hold", deepest(), "malformed"],
    ["65 sibling arrays at depth 2", focusedWith(siblings(65, "[]")), "focused"],
    ["65 sibling objects at depth 2", focusedWith(siblings(65, "{}")), "focused"],
    ["objects then arrays, each 64 deep", focusedWith(`${nestObjects(64, "objects")},${nestArrays(64, "arrays")}`), "focused"],
    ["one member nesting objects 65 deep", focusedWith(nestObjects(65)), "malformed"],
    ["one member alternating objects and arrays to 65 deep", focusedWith(nestAlternating(65)), "malformed"],
    ["one member alternating objects and arrays to 64 deep", focusedWith(nestAlternating(64)), "focused"],
    ["a string holding 65 [", focusedWith(`"text":"${"[".repeat(65)}"`), "focused"],
    ["a string holding closing brackets at depth 64", focusedWith(`"deep":${"[".repeat(63)}"${"]}".repeat(65)}"${"]".repeat(63)}`), "focused"],
    ["a string holding an escaped quote then 65 [", focusedWith(`"text":"\\"${"[".repeat(65)}"`), "focused"],
    ["a string ending in an escaped backslash, then a member 65 deep", focusedWith(`"text":"r\\\\",${nestArrays(65)}`), "malformed"],
  ])("reads %s as the bound says", async (_name, text, expected) => {
    const f = await fixture();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    const tip = await f.publish(text);
    const result = await f.resolve();
    if (expected === "focused") expect(result).toMatchObject({ posture: "focused", code: null, baseTipSha: tip });
    else {
      expect(result).toMatchObject({ posture: "gate", code: "posture_malformed", source: "origin/main", baseTipSha: tip });
      expect(result.reason).toContain("nests deeper than 64 levels");
    }
  });

  it("measures the vectors' depth as the bound counts it", () => {
    /** The greatest number of arrays and objects open at once, from the parsed value. */
    const depthOf = (node: unknown, at = 1): number => node === null || typeof node !== "object" ? at - 1
      : Math.max(at, ...Object.values(node as object).map(child => depthOf(child, at + 1)));
    expect(depthOf(JSON.parse(focusedWith(nestArrays(64))))).toBe(64);
    expect(depthOf(JSON.parse(focusedWith(nestArrays(65))))).toBe(65);
    expect(depthOf(JSON.parse(focusedWith(`${nestObjects(64, "objects")},${nestArrays(64, "arrays")}`)))).toBe(64);
    expect(depthOf(JSON.parse(focusedWith(siblings(65, "{}"))))).toBe(2);
    expect(depthOf(JSON.parse(focusedWith(siblings(65, "[]"))))).toBe(2);
    expect(depthOf(JSON.parse(focusedWith(nestObjects(65))))).toBe(65);
    expect(depthOf(JSON.parse(focusedWith(nestAlternating(65))))).toBe(65);
    expect(depthOf(JSON.parse(focusedWith(nestAlternating(64))))).toBe(64);
    expect(depthOf(JSON.parse(focusedWith(`"deep":${"[".repeat(63)}"x"${"]".repeat(63)}`)))).toBe(64);
  });
});
