import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { candidateTreeEvidenceReader, candidateTreeSourceReader } from "./portable-inputs.ts";
import { runGitCommand, type CandidateCommandRunner } from "./candidate.ts";
import { MAX_PORTABLE_ARTIFACT_BYTES } from "./portable-limits.ts";
import { captureScopedCheckInputs } from "./checks.ts";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(format = "sha1") {
  const root = mkdtempSync(path.join(tmpdir(), "native-batch-")); roots.push(root);
  const realGit = execFileSync("which", ["git"]).toString().trim();
  const git = (...args: string[]) => execFileSync(realGit, args, { cwd: root });
  git("init", "-q", `--object-format=${format}`);
  const bytes = Buffer.from([0, 255, 10, 128, 13, 0]);
  writeFileSync(path.join(root, "input"), bytes); writeFileSync(path.join(root, "alias"), bytes);
  writeFileSync(path.join(root, "empty"), ""); writeFileSync(path.join(root, "exec"), "executable"); chmodSync(path.join(root, "exec"), 0o755);
  mkdirSync(path.join(root, "dir")); writeFileSync(path.join(root, "dir/child"), "child");
  symlinkSync("input", path.join(root, "file-link")); symlinkSync("dir", path.join(root, "dir-link"));
  symlinkSync("../escape", path.join(root, "escape")); symlinkSync("cycle", path.join(root, "cycle")); symlinkSync("absent", path.join(root, "dangling"));
  git("add", "."); const initialTree = git("write-tree").toString().trim();
  const commit = git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", initialTree, "-m", "fixture").toString().trim();
  git("update-index", "--add", "--cacheinfo", `160000,${commit},gitlink`);
  const tree = git("write-tree").toString().trim();
  const transport = path.join(root, "transport"); mkdirSync(transport);
  const control = path.join(transport, "control"), trace = path.join(transport, "trace"); writeFileSync(control, "good"); writeFileSync(trace, "");
  const wrapper = `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');
const args=process.argv.slice(2),mode=fs.readFileSync(${JSON.stringify(control)},'utf8');
const input=fs.readFileSync(0);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args,input:input.toString()})+'\\n');
const r=cp.spawnSync(${JSON.stringify(realGit)},args,{input,maxBuffer:32*1024*1024});let output=r.stdout;
if(args[0]==='cat-file'&&args[1]==='--batch'){
 const end=output.indexOf(10),header=output.subarray(0,end).toString(),fields=header.split(' ');
 if(mode==='oid')output=Buffer.concat([Buffer.from('f'.repeat(fields[0].length)+' '+fields.slice(1).join(' ')+'\\n'),output.subarray(end+1)]);
 if(mode==='type')output=Buffer.concat([Buffer.from(fields[0]+' tree '+fields[2]+'\\n'),output.subarray(end+1)]);
 if(mode==='non-ascii')output[0]|=128;
 if(mode==='negative'||mode==='unsafe'||mode==='size-text')output=Buffer.concat([Buffer.from(fields[0]+' '+fields[1]+' '+({negative:'-1',unsafe:'9007199254740992','size-text':'oops'}[mode])+'\\n'),output.subarray(end+1)]);
 if(mode==='header')output=Buffer.from(header);
 if(mode==='body')output=output.subarray(0,end+2);
 if(mode==='hash')output[end+1]^=1;
 if(mode==='delimiter')output[output.length-1]=0;
 if(mode==='trailing')output=Buffer.concat([output,Buffer.from('unexpected')]);
 if(mode==='missing')output=Buffer.from(fields[0]+' missing\\n');
 if(mode==='exit')process.exitCode=7;
}
process.stdout.write(output);process.stderr.write(r.stderr);process.exitCode=process.exitCode||r.status||0;\n`;
  writeFileSync(path.join(transport, "git"), wrapper, { mode: 0o755 });
  vi.stubEnv("PATH", transport + path.delimiter + process.env["PATH"]);
  const calls = () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { args: string[]; input: string });
  return { root, git, tree, bytes, calls, mode: (mode: string) => writeFileSync(control, mode) };
}

it.each(["sha1", "sha256"])("batches native %s binary, aliases and metadata while legacy runners keep their protocol", async format => {
  const f = fixture(format), read = await candidateTreeSourceReader(f.root, f.tree);
  const legacyCalls: string[][] = [];
  const legacy: CandidateCommandRunner = async (args, options) => { legacyCalls.push([...args]); return runGitCommand(args, options); };
  const old = await candidateTreeSourceReader(f.root, f.tree, legacy);
  const names = ["input", "alias", "empty", "exec", "dir/child"];
  const actual = await Promise.all(names.map(name => read(name)));
  expect(actual).toEqual(await Promise.all(names.map(name => old(name))));
  expect(actual[0]).toEqual(f.bytes); expect(actual[2]).toEqual(Buffer.alloc(0));
  actual[0]![0] = 7; expect(await read("alias")).toEqual(f.bytes);
  expect(await read.metadata("exec")).toEqual({ mode: "100755", links: [] });
  expect(await read("file-link")).toEqual(f.bytes);
  expect(await read.metadata("file-link")).toEqual({ mode: "100644", links: [{ path: "file-link", target: "input" }] });
  expect(await read("dir-link")).toEqual(f.git("cat-file", "tree", `${f.tree}:dir`));
  expect(await read.metadata("dir-link")).toEqual({ mode: "040000", links: [{ path: "dir-link", target: "dir" }] });
  expect(await read("dir")).toBeNull(); expect(await read("absent")).toBeNull();
  await expect(read("gitlink")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  await expect(read.metadata("gitlink")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  const batches = f.calls().filter(call => call.args[1] === "--batch");
  expect(batches.length).toBeGreaterThan(0);
  expect(batches[0]!.input.trim().split("\n")).toHaveLength(4);
  expect(legacyCalls.filter(args => args[1] === "cat-file" && args[2] === "-s")).toHaveLength(4);
  expect(legacyCalls.filter(args => args[1] === "cat-file" && args[2] === "blob")).toHaveLength(4);
  expect(legacyCalls.filter(args => args[1] === "cat-file").every(args => args[2] === "-s" || args[2] === "blob")).toBe(true);
  const selected = [...names, "file-link", "dir-link"];
  const capture = (reader: typeof read) => captureScopedCheckInputs({ version: "scoped-check/1", files: selected, memberships: [], tests: ["input"], cwd: ".", profile: "fixture", environment: [] }, {
    listFiles: async () => selected, readFile: reader, readMetadata: reader.metadata, command: ["fixture"], timeoutMs: 1000,
    runtimeDigest: "a".repeat(64), dependencyDigest: "b".repeat(64), policyDigest: "c".repeat(64), releaseDigest: "d".repeat(64), environment: {}, credentialIdentity: () => null,
  });
  expect(await capture(read)).toEqual(await capture(old));
});

it("bounds native waves to eight and flushes a single request without waiting for peers", async () => {
  const f = fixture(); for (let i = 0; i < 19; i++) writeFileSync(path.join(f.root, `extra-${i}`), `unique ${i}`);
  // Keep the transport wrapper out of the pinned tree.
  f.git("add", ...Array.from({ length: 19 }, (_, i) => `extra-${i}`)); const tree = f.git("write-tree").toString().trim();
  const read = await candidateTreeSourceReader(f.root, tree);
  expect(await Promise.all(Array.from({ length: 19 }, (_, i) => read(`extra-${i}`)))).toEqual(Array.from({ length: 19 }, (_, i) => Buffer.from(`unique ${i}`)));
  expect(await read("empty")).toEqual(Buffer.alloc(0));
  const waves = f.calls().filter(call => call.args[1] === "--batch").map(call => call.input.trim().split("\n").length);
  expect(waves).toEqual([8, 8, 3, 1]);
});

it.each(["oid", "type", "non-ascii", "negative", "unsafe", "size-text", "header", "body", "hash", "delimiter", "trailing", "missing", "exit"])("rejects native batch %s faults, settles siblings and retries without cached failure", async mode => {
  const f = fixture(), read = await candidateTreeSourceReader(f.root, f.tree); f.mode(mode);
  const results = await Promise.allSettled([read("input"), read("exec")]);
  expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  f.mode("good"); expect(await read("input")).toEqual(f.bytes); expect(await read("exec")).toEqual(Buffer.from("executable"));
  expect(await (await candidateTreeSourceReader(f.root, f.tree))("input")).toEqual(f.bytes);
  expect(f.calls().filter(call => call.args[0] === "cat-file").every(call => call.args[1] === "--batch")).toBe(true);
});

it("keeps native reader instances separate while cached bytes remain independent of later transport faults", async () => {
  const f = fixture(), read = await candidateTreeSourceReader(f.root, f.tree);
  expect(await read("input")).toEqual(f.bytes); f.mode("hash");
  expect(await read("input")).toEqual(f.bytes);
  await expect((await candidateTreeSourceReader(f.root, f.tree))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
});

it("uses batching through compiled public kernel exports with the exported native runner", async () => {
  const f = fixture(), { build } = await import("esbuild");
  const bundle = path.join(f.root, "kernel.mjs");
  await build({ entryPoints: [path.resolve("packages/kernel/src/index.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const api = await import(pathToFileURL(bundle).href) as typeof import("./index.ts");
  const read = await api.candidateTreeSourceReader(f.root, f.tree, api.runGitCommand);
  expect(await read("input")).toEqual(f.bytes);
  expect(f.calls().filter(call => call.args[0] === "cat-file").map(call => call.args[1])).toEqual(["--batch"]);
});

it("passes finite stdin bytes and reports unstartable commands and stdin pipe failure", async () => {
  const value = "header\n\0tail", command = [process.execPath, "-e", "process.stdin.pipe(process.stdout)"];
  const result = await runGitCommand(command, { cwd: tmpdir(), captureBytes: true, stdin: value });
  expect(result.exitCode).toBe(0); expect(Buffer.from(result.stdoutBase64!, "base64")).toEqual(Buffer.from(value));
  expect((await runGitCommand(["/definitely-missing-v2347-command"], { cwd: tmpdir(), stdin: value })).exitCode).toBe(-1);
  const closed = await runGitCommand([process.execPath, "-e", "process.stdin.destroy();process.exit(0)"], { cwd: tmpdir(), stdin: "x".repeat(2 * 1024 * 1024) });
  expect(closed.exitCode).toBe(-1); expect(closed.stderr).not.toBe("");
});

it("preserves native source size policy, pre-body evidence refusal, and path/link refusals", async () => {
  const f = fixture(), large = Buffer.alloc(MAX_PORTABLE_ARTIFACT_BYTES + 1, 137); writeFileSync(path.join(f.root, "large"), large);
  f.git("add", "large"); const tree = f.git("write-tree").toString().trim();
  const source = await candidateTreeSourceReader(f.root, tree), evidence = await candidateTreeEvidenceReader(f.root, tree);
  expect(await source("large")).toEqual(large);
  const before = f.calls().length;
  await expect(evidence("large")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("oversized") }] });
  expect(f.calls().slice(before).map(call => call.args.slice(0, 2))).toEqual([["cat-file", "-s"]]);
  for (const name of ["../escape", "escape", "cycle"]) await expect(source(name)).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  expect(await source("dangling")).toBeNull();
});
