import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { digestCanonical, resolveRecordStorage, type HarnessConfig, type ScopedCheckAttempt } from "@agent-delivery-harness/kernel";
import { AttemptStore, type AttemptPayload } from "./scoped-attempts.ts";
import { readScopedCheckDiagnostics } from "./index.ts";
import { INTERRUPTED_CREDENTIAL_PREFIX, redactScopedOutput, scopedCommandDiagnostic, scopedDependencyDiagnostic, scopedDiagnosticFailure } from "./scoped-diagnostics.ts";
import { CheckSnapshotError } from "./check-snapshot.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "scoped-diagnostics-")); roots.push(rootDir);
  execFileSync("git", ["init", "-q"], { cwd: rootDir });
  const config = { gateId: "diagnostics", storageNamespace: "observations/", providers: ["a", "b"].map(id => ({ id, findingCodes: [], check: { command: ["true"], timeoutMs: 1000, scope: { version: "scoped-check/1", files: [], memberships: [], tests: [], cwd: ".", profile: "test", environment: [] } } })) } as Pick<HarnessConfig, "gateId" | "storageNamespace" | "providers">;
  const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace, leaf: "scoped-attempts" });
  const store = (provider: string) => new AttemptStore(path.join(storage.storageDir, digestCanonical({ gate: config.gateId, provider })));
  const input = (providerId: string) => ({ version: "scoped-attempt/1", providerId, inputDigest: "a".repeat(64), profileDigest: "b".repeat(64), origin: { runId: "run", candidate: { treeSha: "a".repeat(40), deliverableDigest: "b".repeat(64), identityToken: "tree/v1", baseRef: "origin/main", baseTipSha: "c".repeat(40), mergeBaseSha: "c".repeat(40), workspaceId: "workspace" } } }) as Omit<ScopedCheckAttempt, "attemptId" | "generation" | "status">;
  return { rootDir, config, store, input };
}
const diagnostic = { availability: "available", phase: "command", failure: { code: "check_command_failed" }, command: { exitCode: 7, outputTail: "assertion failed [REDACTED]", truncated: false } } as const;
it("returns exact requested native bindings and explicit absent, running and legacy states without writes", async () => {
  const f = await fixture(); const a = f.store("a"); const passed = await a.allocate(f.input("a"));
  await a.finish(passed, "passed", { outputs: [], log: "legacy private output", durationMs: 3 });
  const failed = await a.allocate(f.input("a"));
  await a.finish(failed, "failed", { outputs: [{ path: "private", base64: "private", sha256: "private" }], log: "private raw", diagnostic, durationMs: 10 } as AttemptPayload);
  const running = await a.allocate(f.input("a"));
  const before = await readFile(path.join(a.root, "2/terminal.json"));
  const result = await readScopedCheckDiagnostics({ ...f, attemptIds: [running.attemptId, failed.attemptId, passed.attemptId, "missing"] });
  expect(result).toEqual({ version: "scoped-check-diagnostics/1", providers: [
    { providerId: "a", attempts: [
      { ...passed, status: "passed", durationMs: 3, diagnostic: { availability: "unavailable", reason: "legacy" } },
      { ...failed, status: "failed", durationMs: 10, diagnostic },
      { ...running, diagnostic: { availability: "unavailable", reason: "running" } },
    ] }, { providerId: "b", attempts: [] },
  ], unavailableAttemptIds: ["missing"] });
  expect(JSON.stringify(result)).not.toMatch(/private|payload|outputs|admitted|applicability/);
  expect(await readFile(path.join(a.root, "2/terminal.json"))).toEqual(before);
  const only = await readScopedCheckDiagnostics({ ...f, attemptIds: [failed.attemptId] });
  expect(only.providers[0]!.attempts).toHaveLength(1);
});
it("does not create storage for absent or empty requests", async () => {
  const f = await fixture(); const before = await readdir(path.join(f.rootDir, ".git"));
  expect((await readScopedCheckDiagnostics({ ...f, attemptIds: ["missing"] })).unavailableAttemptIds).toEqual(["missing"]);
  expect((await readScopedCheckDiagnostics({ ...f, attemptIds: [] })).unavailableAttemptIds).toEqual([]);
  expect(await readdir(path.join(f.rootDir, ".git"))).toEqual(before);
  const hundred = Array.from({ length: 100 }, (_, i) => `missing-${i}`);
  expect((await readScopedCheckDiagnostics({ ...f, attemptIds: hundred })).unavailableAttemptIds).toEqual(hundred);
});
it("refuses native history filed under another configured provider", async () => {
  const f = await fixture();
  const wrongOwner = await f.store("a").allocate(f.input("b"));
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds: [wrongOwner.attemptId] })).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
it("refuses one requested identifier shared by separate provider histories", async () => {
  const f = await fixture();
  const a = await f.store("a").allocate(f.input("a"));
  const b = f.store("b"); await b.allocate(f.input("b"));
  const file = path.join(b.root, "1/running.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.attempt.attemptId = a.attemptId;
  row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds: [a.attemptId] })).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
it.each([["same", "same"], [""], ["x".repeat(129)], Array.from({ length: 101 }, (_, i) => String(i))].map(attemptIds => ({ attemptIds })))("refuses invalid explicit requests without writes", async ({ attemptIds }) => {
  const f = await fixture(); const before = await readdir(path.join(f.rootDir, ".git"));
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds })).rejects.toMatchObject({ code: "check_diagnostics_request_invalid" });
  expect(await readdir(path.join(f.rootDir, ".git"))).toEqual(before);
});
it.each([
  ["phase", "private"], ["failure", { code: "private-secret" }],
  ["command", { exitCode: 7, outputTail: "x".repeat(4001), truncated: true }],
  ["command", { exitCode: "7", outputTail: "tail", truncated: false }],
  ["command", { unavailable: "invented" }],
  ["command", { unavailable: ["not-completed"] }], ["failure", { unavailable: ["not-failed"] }],
  ["failure", { code: "check_command_failed", executionErrorCode: "private-secret" }],
  ["availability", "unavailable"], ["command", { exitCode: -1, outputTail: "tail", truncated: false }],
  ["command", { exitCode: 7, outputTail: "tail", truncated: "false" }],
] as const)("refuses malformed selected diagnostic %s even with a recomputed checksum", async (member, value) => {
  const f = await fixture(), a = f.store("a"), attempt = await a.allocate(f.input("a"));
  await a.finish(attempt, "failed", { outputs: [], diagnostic } as AttemptPayload);
  const file = path.join(a.root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.diagnostic[member] = value; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] })).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});

it.each(["ENOENT", "EACCES", "EPERM", "ABORT_ERR", "SIGKILL", "SIGTERM", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "execution_failed"])("does not mistake synthesized exit1 for a raw exit: %s", async errorCode => {
  const failure = scopedDiagnosticFailure(new CheckSnapshotError("check_command_failed", "private"), errorCode);
  expect(failure).toEqual({ code: "check_command_failed", executionErrorCode: errorCode });
  expect(scopedCommandDiagnostic({ code: 1, errorCode, stdout: "", stderr: "" }, [])).toEqual({ unavailable: ["ENOENT", "EACCES", "EPERM"].includes(errorCode) ? "not-started" : "not-completed" });
  expect(scopedCommandDiagnostic({ code: 1, errorCode, stdout: "captured secret", stderr: "" }, ["secret"])).toEqual(errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? { unavailable: "not-completed" } : { exitCode: null, outputTail: "captured [REDACTED]\n", truncated: false });
});
it("retains genuine numeric exits and handles unknown failures without arbitrary text", () => {
  expect(scopedCommandDiagnostic({ code: 1, errorCode: "1", stdout: "", stderr: "assertion" }, [])).toEqual({ exitCode: 1, outputTail: "\nassertion", truncated: false });
  expect(scopedCommandDiagnostic({ code: 7, errorCode: "7", stdout: "assertion", stderr: "stderr" }, [])).toEqual({ exitCode: 7, outputTail: "assertion\nstderr", truncated: false });
  expect(scopedCommandDiagnostic({ code: 0, stdout: "", stderr: "" }, [])).toEqual({ exitCode: 0, outputTail: "\n", truncated: false });
  expect(scopedDiagnosticFailure(new Error("private"))).toEqual({ unavailable: "unclassified" });
  expect(scopedDiagnosticFailure(new CheckSnapshotError("private-secret", "private"))).toEqual({ unavailable: "unclassified" });
  expect(scopedDiagnosticFailure(new CheckSnapshotError("check_command_failed", "private"), "private")).toEqual({ code: "check_command_failed" });
  expect(redactScopedOutput("long-secret short", ["long", "long-secret", "short"])).toBe("[REDACTED] [REDACTED]");
});
it.each(["E2BIG", "SIGHUP", "private-unknown-code"])("keeps unknown execution errors distinct from numeric exits: %s", errorCode => {
  expect(scopedCommandDiagnostic({ code: 1, errorCode, stdout: "", stderr: "" }, [])).toEqual({ unavailable: "not-completed" });
  expect(scopedCommandDiagnostic({ code: 1, errorCode, stdout: "captured secret", stderr: "" }, ["secret"])).toEqual({ exitCode: null, outputTail: "captured [REDACTED]\n", truncated: false });
  expect(scopedDiagnosticFailure(new CheckSnapshotError("check_command_failed", "private"), errorCode)).toEqual({ code: "check_command_failed" });
});

it("strips unknown diagnostic properties and ignores removed provider history", async () => {
  const f = await fixture(), a = f.store("a"), attempt = await a.allocate(f.input("a"));
  await a.finish(attempt, "failed", { outputs: [], diagnostic } as AttemptPayload);
  const file = path.join(a.root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.diagnostic.extra = "private"; row.entry.payload.diagnostic.failure.message = "secret";
  row.entry.payload.diagnostic.command.environment = "private"; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  const result = await readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] });
  expect(result.providers[0]!.attempts[0]!.diagnostic).toEqual(diagnostic);
  expect(JSON.stringify(result)).not.toMatch(/private|secret|environment|extra|message/);
  await writeFile(file, "{}");
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] })).rejects.toMatchObject({ code: "check_attempt_corrupt" });
  expect((await readScopedCheckDiagnostics({ ...f, config: { ...f.config, providers: [f.config.providers[1]!] }, attemptIds: [attempt.attemptId] })).unavailableAttemptIds).toEqual([attempt.attemptId]);
});

it.each(["stdout", "stderr"])("does not export a credential clipped by the real exec buffer on %s", async stream => {
  const {createExecPort}=await import("@agent-delivery-harness/kernel");
  const limit=1024*1024, secret="OC_BOUNDARY_TOKEN_"+"0123456789".repeat(6)+"_END";
  const prefix=secret.slice(0,-4);
  const result=await createExecPort().run({command:process.execPath,args:["-e",`require('fs').writeSync(${stream === "stdout" ? 1 : 2},'x'.repeat(${limit-prefix.length})+process.env.API_TOKEN+'z'.repeat(100));`],env:{API_TOKEN:secret},maxBuffer:limit,timeoutMs:5000});
  expect(result.errorCode).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(result[stream === "stdout" ? "stdout" : "stderr"]).toContain(prefix);
  expect(result[stream === "stdout" ? "stdout" : "stderr"]).not.toContain(secret);
  const f=await fixture(), store=f.store("a"), attempt=await store.allocate(f.input("a"));
  const command=scopedCommandDiagnostic(result,[secret]);
  await store.finish(attempt,"failed",{outputs:[],diagnostic:{availability:"available",phase:"command",failure:scopedDiagnosticFailure(new CheckSnapshotError("check_command_failed","safe"),result.errorCode),command,dependency:scopedDependencyDiagnostic(result,1,[secret])}});
  const projected=await readScopedCheckDiagnostics({...f,attemptIds:[attempt.attemptId]});
  expect(projected.providers[0]!.attempts[0]!.diagnostic).toEqual({ availability: "available", phase: "command", failure: { code: "check_command_failed", executionErrorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, command: { unavailable: "not-completed" }, dependency: {durationMs:1,executionErrorCode:"ERR_CHILD_PROCESS_STDIO_MAXBUFFER",command:{unavailable:"not-completed"}} });
  expect(JSON.stringify(projected)).not.toContain(prefix);
},10000);
it("complete credential captured below exec limit is redacted before public export", async()=>{
  const {createExecPort}=await import("@agent-delivery-harness/kernel");
  const secret="OC_COMPLETE_TOKEN_"+"q".repeat(60),limit=1024*1024;
  const result=await createExecPort().run({command:process.execPath,args:["-e",`require('fs').writeSync(1,'x'.repeat(${limit-200})+process.env.API_TOKEN);process.exit(7);`],env:{API_TOKEN:secret},maxBuffer:limit,timeoutMs:5000});
  expect(result.errorCode).toBe("7");const command=scopedCommandDiagnostic(result,[secret]);
  expect(command).toMatchObject({exitCode:7,truncated:true});expect(JSON.stringify(command)).toContain("[REDACTED]");expect(JSON.stringify(command)).not.toContain(secret);
});

// A writer that exits or is killed mid-write (macOS drops async pipe writes at
// process.exit) ends its stream inside a credential no full-value match finds.
const fragmentSecret = "SENTINEL-" + "Q".repeat(40) + "-END";
it.each([1, 2, 9, 10, fragmentSecret.length - 1])("redacts a %i-character credential prefix ending either stream", length => {
  const fragment = fragmentSecret.slice(0, length);
  expect(scopedCommandDiagnostic({ code: 7, errorCode: "7", stdout: "out " + fragment, stderr: "err" }, [fragmentSecret])).toEqual({ exitCode: 7, outputTail: "out [REDACTED]\nerr", truncated: false });
  expect(scopedCommandDiagnostic({ code: 7, errorCode: "7", stdout: "out", stderr: "err " + fragment }, [fragmentSecret])).toEqual({ exitCode: 7, outputTail: "out\nerr [REDACTED]", truncated: false });
  expect(scopedDependencyDiagnostic({ code: 7, errorCode: "7", stdout: "x".repeat(5000) + fragment, stderr: fragmentSecret + " assertion failed" }, 1, [fragmentSecret]).command).toEqual({ exitCode: 7, outputTail: "x".repeat(4000 - "[REDACTED]\n[REDACTED] assertion failed".length) + "[REDACTED]\n[REDACTED] assertion failed", truncated: true });
});
it("redacts every overlapping occurrence and only text a credential could have produced", () => {
  expect(redactScopedOutput("aXaXa", ["aXa"])).toBe("[REDACTED]");
  expect(redactScopedOutput("x aXa", ["aXa"])).toBe("x [REDACTED]");
  expect(redactScopedOutput("aXaX", ["aXa"])).toBe("[REDACTED]");
  expect(redactScopedOutput("aXa y aX", ["aXa"])).toBe("[REDACTED] y [REDACTED]");
  expect(redactScopedOutput("done\n", [fragmentSecret])).toBe("done\n");
  expect(redactScopedOutput("QQQ-END", [fragmentSecret])).toBe("QQQ-END");
  expect(redactScopedOutput("short sho", ["short", "shorter"])).toBe("[REDACTED] [REDACTED]");
  expect(redactScopedOutput("", [fragmentSecret])).toBe("");
  // The matcher falls back to the longest border on a mismatch rather than restarting.
  expect(redactScopedOutput("log aaab done", ["aab"])).toBe("log a[REDACTED] done");
  expect(redactScopedOutput("0000abc", ["000abc"])).toBe("0[REDACTED]");
  // The border table itself falls back: "aabaaa" recurs at offset 4 only through border[2] = 1.
  expect(redactScopedOutput("aabaaabaaa", ["aabaaa"])).toBe("[REDACTED]");
  // A credential nested in another declared one, merged across credentials whatever their order.
  expect(redactScopedOutput("url=postgres://u:PASS@h end", ["PASS", "postgres://u:PASS@h"])).toBe("url=[REDACTED] end");
  expect(redactScopedOutput("abcabc abc", ["abc"])).toBe("[REDACTED] [REDACTED]");
});
it.each([INTERRUPTED_CREDENTIAL_PREFIX, INTERRUPTED_CREDENTIAL_PREFIX + 1, fragmentSecret.length - 1])("redacts a %i-character credential prefix that later output interrupts", length => {
  const fragment = fragmentSecret.slice(0, length);
  expect(redactScopedOutput("out " + fragment + "\nafter", [fragmentSecret])).toBe("out [REDACTED]\nafter");
  expect(redactScopedOutput(fragment + fragment + fragmentSecret + fragment + "!", [fragmentSecret])).toBe("[REDACTED]!");
});
it("leaves a shorter interrupted run as ordinary output and masks a short credential only whole or ending the text", () => {
  expect(INTERRUPTED_CREDENTIAL_PREFIX).toBe(8);
  expect(redactScopedOutput("SENTINE is a word", [fragmentSecret])).toBe("SENTINE is a word");
  expect(redactScopedOutput("ab x abc y ab", ["abc"])).toBe("ab x [REDACTED] y [REDACTED]");
});
it("redacts a credential prefix that a byte clip leaves before an incomplete character", () => {
  const secret = "SENTINEL-éé-END", clipped = Buffer.from("out " + secret).subarray(0, "out SENTINEL-".length + 1).toString("utf8");
  expect(clipped).toBe("out SENTINEL-\uFFFD");
  expect(redactScopedOutput(clipped, [secret])).toBe("out [REDACTED]");
  expect(redactScopedOutput("out \uFFFD\uFFFD", [secret])).toBe("out \uFFFD\uFFFD");
  expect(redactScopedOutput("out SENTINEL-\uFFFD\uFFFD", [secret])).toBe("out [REDACTED]");
  // Below the interrupted-prefix length only the tail rule can mask what precedes the clip.
  const shortSecret = "SENT\u00e9-END", shortClipped = Buffer.from("out " + shortSecret).subarray(0, "out SENT".length + 1).toString("utf8");
  expect(shortClipped).toBe("out SENT\uFFFD");
  expect(redactScopedOutput(shortClipped, [shortSecret])).toBe("out [REDACTED]");
});
it("stays linear over a long replacement-character run that does not end the text", () => {
  const run = "\uFFFD".repeat(1024 * 1024), started = performance.now();
  expect(redactScopedOutput(run + "x", [fragmentSecret, "\u00e9-token"])).toBe(run + "x");
  expect(performance.now() - started).toBeLessThan(2000);
});
it("redacts a credential split across separate writes of the real exec port", async () => {
  const { createExecPort } = await import("@agent-delivery-harness/kernel");
  const secret = "SPLIT_TOKEN_" + "w".repeat(20000) + "_END";
  const program = "const s=process.env.API_TOKEN,w=t=>new Promise(r=>process.stdout.write(t,()=>setTimeout(r,2)));(async()=>{await w('x'.repeat(5000));for(let i=0;i<s.length;i+=997)await w(s.slice(i,i+997));await w(' assertion failed');process.exitCode=7})()";
  const result = await createExecPort().run({ command: process.execPath, args: ["-e", program], env: { API_TOKEN: secret }, timeoutMs: 10000 });
  expect(result.stdout).toBe("x".repeat(5000) + secret + " assertion failed");
  const command = scopedCommandDiagnostic(result, [secret]);
  expect(command).toMatchObject({ exitCode: 7, truncated: true, outputTail: expect.stringMatching(/x\[REDACTED\] assertion failed\n$/) });
  expect(JSON.stringify(command)).not.toContain("w".repeat(8));
}, 15000);
it.each(["stdout", "stderr"])("does not export a credential the real exec port captured only partially on %s", async stream => {
  const { createExecPort } = await import("@agent-delivery-harness/kernel");
  const secret = "PARTIAL_TOKEN_" + "p".repeat(30000) + "_END";
  // A blocking write delivers every byte whatever the platform's pipe chunk size; the stream itself ends mid-credential.
  const program = `require('fs').writeSync(${stream === "stdout" ? 1 : 2},'x'.repeat(20000)+process.env.API_TOKEN.slice(0,17000));process.exit(7)`;
  const result = await createExecPort().run({ command: process.execPath, args: ["-e", program], env: { API_TOKEN: secret }, timeoutMs: 10000 });
  expect(result[stream as "stdout" | "stderr"]).toBe("x".repeat(20000) + secret.slice(0, 17000));
  const command = scopedCommandDiagnostic(result, [secret]);
  expect(command).toMatchObject({ exitCode: 7, truncated: true, outputTail: expect.stringMatching(stream === "stdout" ? /x\[REDACTED\]\n$/ : /x\[REDACTED\]$/) });
  expect(JSON.stringify(command)).not.toMatch(/PARTIAL|ppp/);
}, 15000);
it("does not export a partial credential that a wrapping shell's later output follows", async () => {
  const { createExecPort } = await import("@agent-delivery-harness/kernel");
  const secret = "WRAPPED_TOKEN_" + "r".repeat(30000) + "_END";
  const script = "require('fs').writeSync(1,'x'.repeat(20000)+process.env.API_TOKEN.slice(0,17000));process.exit(7)";
  const result = await createExecPort().run({ command: "/bin/sh", args: ["-c", '"$NODE" -e "$SCRIPT"; s=$?; echo "child exited $s"; exit $s'], env: { API_TOKEN: secret, NODE: process.execPath, SCRIPT: script, PATH: "/usr/bin:/bin" }, timeoutMs: 10000 });
  expect(result.stdout).toBe("x".repeat(20000) + secret.slice(0, 17000) + "child exited 7\n");
  const command = scopedCommandDiagnostic(result, [secret]);
  expect(command).toMatchObject({ exitCode: 7, truncated: true, outputTail: expect.stringMatching(/x\[REDACTED\]child exited 7\n\n$/) });
  expect(JSON.stringify(command)).not.toMatch(/WRAPPED|rrr/);
}, 15000);

it("projects additive dependency diagnostics independently from the unstarted main command", async () => {
  const f = await fixture(), store = f.store("a"), attempt = await store.allocate(f.input("a"));
  const value = { availability: "available", phase: "snapshot-setup", failure: { code: "check_dependency_failed" }, command: { unavailable: "not-started" },
    dependency: { durationMs: 14, executionErrorCode: "SIGKILL", command: { exitCode: null, outputTail: "bounded dependency detail", truncated: false } } };
  await store.finish(attempt, "failed", { outputs: [], diagnostic: value } as AttemptPayload);
  const result = await readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] });
  expect(result.providers[0]!.attempts[0]!.diagnostic).toEqual(value);
});

it("bounds and redacts dependency output and keeps arbitrary errors out of diagnostics", () => {
  const value = scopedDependencyDiagnostic({ code: 7, errorCode: "private-unknown-error", stdout: "x".repeat(5000)+"secret", stderr: "dependency-stage:pip secret" }, 12, ["secret"]);
  expect(value).not.toHaveProperty("executionErrorCode");
  expect(value.command).toMatchObject({ exitCode: null, truncated: true, outputTail: expect.stringContaining("dependency-stage:pip [REDACTED]") });
  expect(JSON.stringify(value)).not.toContain("secret");
  if ("outputTail" in value.command) expect(value.command.outputTail).toHaveLength(4000);
});
it.each([
  { durationMs: -1, command: { unavailable: "not-started" } },
  { durationMs: "1", command: { unavailable: "not-started" } },
  { durationMs: null, command: { unavailable: "not-started" } },
  { durationMs: 1, executionErrorCode: "private", command: { unavailable: "not-started" } },
  { durationMs: 1, command: { exitCode: 1, outputTail: "x".repeat(4001), truncated: true } },
  { durationMs: 1, command: { unavailable: "not-started", exitCode: 1 } },
  null,
])("rejects malformed persisted dependency diagnostics %#", async dependency => {
  const f = await fixture(), store = f.store("a"), attempt = await store.allocate(f.input("a"));
  await store.finish(attempt, "failed", { outputs: [], diagnostic });
  const file = path.join(store.root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.diagnostic.dependency = dependency; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] })).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
it("strips unknown dependency metadata without altering its bounded public fields", async () => {
  const f = await fixture(), store = f.store("a"), attempt = await store.allocate(f.input("a"));
  const dependency = { durationMs: 0, command: { exitCode: 7, outputTail: "safe", truncated: false } };
  await store.finish(attempt, "failed", { outputs: [], diagnostic: { ...diagnostic, dependency } } as AttemptPayload);
  const file = path.join(store.root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.diagnostic.dependency.message = "private"; row.entry.payload.diagnostic.dependency.command.environment = "secret";
  row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  const result = await readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] });
  expect(result.providers[0]!.attempts[0]!.diagnostic).toEqual({ ...diagnostic, dependency });
  expect(JSON.stringify(result)).not.toMatch(/private|secret|environment|message/);
});

it.each([["ENOENT", "not-started"], ["EACCES", "not-started"], ["EPERM", "not-started"], ["ABORT_ERR", "not-completed"], ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "not-completed"], ["SIGKILL", "not-completed"], ["SIGTERM", "not-completed"], ["execution_failed", "not-completed"]] as const)("persists dependency execution cause %s through the public reader", async (errorCode, unavailable) => {
  const f = await fixture(), store = f.store("a"), attempt = await store.allocate(f.input("a"));
  const dependency = scopedDependencyDiagnostic({ code: 1, stdout: "", stderr: "", errorCode }, 73, []);
  await store.finish(attempt, "failed", { outputs: [], diagnostic: { ...diagnostic, phase: "snapshot-setup", failure: { code: "check_dependency_failed" }, command: { unavailable: "not-started" }, dependency } });
  const result = await readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] });
  expect(result.providers[0]!.attempts[0]!.diagnostic).toEqual({ availability: "available", phase: "snapshot-setup", failure: { code: "check_dependency_failed" }, command: { unavailable: "not-started" },
    dependency: { durationMs: 73, executionErrorCode: errorCode, command: { unavailable } },
  });
});
it("omits arbitrary dependency causes and preserves genuine numeric dependency exits", () => {
  expect(scopedDependencyDiagnostic({ code: 1, stdout: "", stderr: "", errorCode: "private-unknown-cause" }, 9, [])).toEqual({ durationMs: 9, command: { unavailable: "not-completed" } });
  expect(scopedDependencyDiagnostic({ code: 7, stdout: "", stderr: "", errorCode: "7" }, 9, [])).toEqual({ durationMs: 9, command: { exitCode: 7, outputTail: "\n", truncated: false } });
});

const setup = { action: "reused", snapshot: "cloned", clone: "clonefile", verification: "index", phases: [{ phase: "warm-base-wait", durationMs: 4 }, { phase: "clone", durationMs: 12 }, { phase: "pre-command-verification", durationMs: 30 }] } as const;
it("returns a recorded setup and strips its unknown properties", async () => {
  const f = await fixture(), a = f.store("a"), attempt = await a.allocate(f.input("a"));
  await a.finish(attempt, "failed", { outputs: [], diagnostic: { ...diagnostic, setup } } as AttemptPayload);
  const file = path.join(a.root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.diagnostic.setup.root = "/private/path"; row.entry.payload.diagnostic.setup.phases[0].path = "/private/path";
  row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  const result = await readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] });
  expect(result.providers[0]!.attempts[0]!.diagnostic).toEqual({ ...diagnostic, setup });
  expect(JSON.stringify(result)).not.toContain("/private/path");
});
it.each([
  ["action", "skipped"], ["snapshot", "shared"], ["clone", "cp"], ["verification", "status"], ["phases", "none"],
  ["phases", [{ phase: "command", durationMs: 1 }]], ["phases", [{ phase: "clone", durationMs: -1 }]], ["phases", [{ phase: "clone", durationMs: 1.5 }]],
  ["phases", [{ phase: "clone", durationMs: "1" }]], ["phases", Array.from({ length: 17 }, () => ({ phase: "clone", durationMs: 1 }))], ["phases", ["clone"]],
] as const)("refuses a malformed recorded setup %s %j", async (member, value) => {
  const f = await fixture(), a = f.store("a"), attempt = await a.allocate(f.input("a"));
  await a.finish(attempt, "failed", { outputs: [], diagnostic: { ...diagnostic, setup } } as AttemptPayload);
  const file = path.join(a.root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.diagnostic.setup[member] = value; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] })).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
it("refuses a recorded setup that is not an object", async () => {
  const f = await fixture(), a = f.store("a"), attempt = await a.allocate(f.input("a"));
  await a.finish(attempt, "failed", { outputs: [], diagnostic: { ...diagnostic, setup } } as AttemptPayload);
  const file = path.join(a.root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.diagnostic.setup = "reused"; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] })).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
