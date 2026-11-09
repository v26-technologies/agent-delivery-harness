import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { candidateTreeEvidenceReader, candidateTreeSourceReader } from "./portable-inputs.ts";
import { runGitCommand, runGitCommandBytes, type CandidateCommandRunner } from "./candidate.ts";
import { MAX_PORTABLE_ARTIFACT_BYTES } from "./portable-limits.ts";
import { captureScopedCheckInputs } from "./checks.ts";

const roots: string[] = [];
// Observe real process launches without wrapping the native command runner.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
  // A streaming stand-in for git: it relays a long-lived `cat-file --batch` frame by frame and corrupts the first
  // frame each child answers in the selected mode. Every other command runs to completion as before.
  const wrapper = `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');
const args=process.argv.slice(2),mode=fs.readFileSync(${JSON.stringify(control)},'utf8'),trace=${JSON.stringify(trace)};
if(!(args[0]==='cat-file'&&args[1]==='--batch')){
 const input=fs.readFileSync(0);fs.appendFileSync(trace,JSON.stringify({args,input:input.toString()})+'\\n');
 const r=cp.spawnSync(${JSON.stringify(realGit)},args,{input,maxBuffer:32*1024*1024});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status||0;
}else{
 const inputs=trace+'.'+process.pid;fs.writeFileSync(inputs,'');fs.appendFileSync(trace,JSON.stringify({args,inputs})+'\\n');
 const git=cp.spawn(${JSON.stringify(realGit)},args,{stdio:['pipe','pipe','inherit']});
 process.stdin.on('data',d=>{fs.appendFileSync(inputs,d);git.stdin.write(d);});process.stdin.on('end',()=>git.stdin.end());
 const released=()=>mode!=='hold'||fs.existsSync(${JSON.stringify(control + ".release")});
 let buffered=Buffer.alloc(0),frames=[],index=0,sent=0,stopped=false;
 const emit=frame=>{
  const end=frame.indexOf(10),header=frame.subarray(0,end).toString(),fields=header.split(' ');let out=frame;
  if(index++===0){
   if(mode==='oid')out=Buffer.concat([Buffer.from('f'.repeat(fields[0].length)+' '+fields.slice(1).join(' ')+'\\n'),frame.subarray(end+1)]);
   if(mode==='type')out=Buffer.concat([Buffer.from(fields[0]+' tree '+fields[2]+'\\n'),frame.subarray(end+1)]);
   if(mode==='non-ascii'){out=Buffer.from(frame);out[0]|=128;}
   if(mode==='negative'||mode==='unsafe'||mode==='size-text')out=Buffer.concat([Buffer.from(fields[0]+' '+fields[1]+' '+({negative:'-1',unsafe:'9007199254740992','size-text':'oops'}[mode])+'\\n'),frame.subarray(end+1)]);
   if(mode==='header')out=Buffer.from(header);
   if(mode==='body')out=frame.subarray(0,end+2);
   if(mode==='hash'){out=Buffer.from(frame);out[end+1]^=1;}
   if(mode==='delimiter'){out=Buffer.from(frame);out[out.length-1]=0;}
   if(mode==='trailing')out=Buffer.concat([frame,Buffer.from('unexpected')]);
   if(mode==='missing')out=Buffer.from(fields[0]+' missing\\n');
   if(mode==='swap'){frames.push(frame);return;}
  }
  if(mode==='swap'&&index===2)out=Buffer.concat([frame,frames.shift()]);
  if(stopped)return;
  if(mode==='exit'&&++sent===1){stopped=true;return process.stdout.write(out,()=>process.exit(7));}
  process.stdout.write(out);
 };
 const flush=()=>{
  if(!released())return setTimeout(flush,10);
  for(;;){
   const end=buffered.indexOf(10);if(end<0)return;
   const header=buffered.subarray(0,end).toString(),size=/ missing$/.test(header)?-1:Number(header.split(' ')[2]);
   const length=size<0?end+1:end+size+2;if(buffered.length<length)return;
   emit(buffered.subarray(0,length));buffered=buffered.subarray(length);
  }
 };
 git.stdout.on('data',d=>{buffered=Buffer.concat([buffered,d]);flush();});
 git.on('close',code=>{flush();process.exitCode=code||0;});
}\n`;
  writeFileSync(path.join(transport, "git"), wrapper, { mode: 0o755 });
  vi.stubEnv("PATH", transport + path.delimiter + process.env["PATH"]);
  const calls = () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => {
    const call = JSON.parse(line) as { args: string[]; input?: string; inputs?: string };
    return { args: call.args, input: call.inputs === undefined ? call.input! : readFileSync(call.inputs, "utf8") };
  });
  return { root, git, tree, bytes, calls, mode: (mode: string) => writeFileSync(control, mode), release: () => writeFileSync(control + ".release", "") };
}

/** The `cat-file --batch` children this file's readers started, and those still running. */
const batchChildren = () => vi.mocked(spawn).mock.calls.map((call, index) => ({ call, child: vi.mocked(spawn).mock.results[index]!.value as ReturnType<typeof spawn> }))
  .filter(({ call }) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "cat-file" && call[1][1] === "--batch").map(({ child }) => child);
const running = () => batchChildren().filter(child => child.exitCode === null && child.signalCode === null);
async function allClosed() { await vi.waitFor(() => expect(running()).toHaveLength(0), { timeout: 5000, interval: 10 }); }

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

it("keeps native binary batches out of UTF8 and base64 text transport", async () => {
  const f = fixture(), read = await candidateTreeSourceReader(f.root, f.tree);
  const original = Buffer.prototype.toString;
  const bodyEncodings: (BufferEncoding | undefined)[] = [];
  const text = vi.spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, ...args: unknown[]) {
    const [encoding, start, end] = args as [BufferEncoding?, number?, number?];
    if (this.length >= f.bytes.length && this.includes(f.bytes)) bodyEncodings.push(encoding);
    return original.call(this, encoding, start, end);
  });
  let bytes: Uint8Array | null;
  try { bytes = await read("input"); } finally { text.mockRestore(); }
  expect(bytes!).toEqual(f.bytes);
  expect(bodyEncodings).toEqual([]);
});

it("answers a burst through one long-lived child and closes it once no read waits", async () => {
  const f = fixture(); for (let i = 0; i < 67; i++) writeFileSync(path.join(f.root, `extra-${i}`), `unique ${i}`);
  // Keep the transport wrapper out of the pinned tree.
  f.git("add", ...Array.from({ length: 67 }, (_, i) => `extra-${i}`)); const tree = f.git("write-tree").toString().trim();
  const read = await candidateTreeSourceReader(f.root, tree);
  expect(await Promise.all(Array.from({ length: 67 }, (_, i) => read(`extra-${i}`)))).toEqual(Array.from({ length: 67 }, (_, i) => Buffer.from(`unique ${i}`)));
  await allClosed();
  // A read after the burst starts a new child rather than waiting on a closed one.
  expect(await read("empty")).toEqual(Buffer.alloc(0));
  await allClosed();
  const children = f.calls().filter(call => call.args[1] === "--batch").map(call => call.input.trim().split("\n").length);
  expect(children).toEqual([67, 1]);
});

it("pipelines a read issued while the child is held into the same child", async () => {
  const f = fixture(); f.mode("hold");
  const read = await candidateTreeSourceReader(f.root, f.tree), first = read("input");
  let second: ReturnType<typeof read> | undefined;
  try {
    await vi.waitFor(() => expect(f.calls().filter(call => call.args[1] === "--batch")).toHaveLength(1), { timeout: 5000, interval: 10 });
    second = read("exec");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(batchChildren()).toHaveLength(1);
    expect(running()).toHaveLength(1);
  } finally {
    f.release(); await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
  expect(await first).toEqual(f.bytes); expect(await second).toEqual(Buffer.from("executable"));
  expect(batchChildren()).toHaveLength(1);
  await allClosed();
}, 15000);

// A fault in the first frame ends the child and fails every read it holds; a missing object fails only its own
// read; a fault after a verified frame leaves that frame published.
const faults: Record<string, ["fulfilled" | "rejected", "fulfilled" | "rejected"]> = {
  oid: ["rejected", "rejected"], type: ["rejected", "rejected"], "non-ascii": ["rejected", "rejected"], negative: ["rejected", "rejected"],
  unsafe: ["rejected", "rejected"], "size-text": ["rejected", "rejected"], header: ["rejected", "rejected"], body: ["rejected", "rejected"],
  hash: ["rejected", "rejected"], delimiter: ["rejected", "rejected"], swap: ["rejected", "rejected"],
  missing: ["rejected", "fulfilled"], trailing: ["fulfilled", "rejected"], exit: ["fulfilled", "rejected"],
};
it.each(Object.keys(faults))("answers native batch %s faults frame by frame, closes the child and retries without cached failure", async mode => {
  const f = fixture(), read = await candidateTreeSourceReader(f.root, f.tree); f.mode(mode);
  const results = await Promise.allSettled([read("input"), read("exec")]);
  expect(results.map(result => result.status)).toEqual(faults[mode]);
  for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  if (results[0]!.status === "fulfilled") expect(results[0]!.value).toEqual(f.bytes);
  if (results[1]!.status === "fulfilled") expect(results[1]!.value).toEqual(Buffer.from("executable"));
  if (mode === "missing") expect(results[0]).toMatchObject({ reason: { blockers: [{ summary: expect.stringContaining("missing") }] } });
  await allClosed();
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
  expect(api).not.toHaveProperty("runGitCommandBytes");
  const read = await api.candidateTreeSourceReader(f.root, f.tree, api.runGitCommand);
  expect(await read("input")).toEqual(f.bytes);
  expect(f.calls().filter(call => call.args[0] === "cat-file").map(call => call.args[1])).toEqual(["--batch"]);
});

it("drains exact binary chunks internally while preserving public text and base64 results", async () => {
  const command = [process.execPath, "-e", "process.stdout.write(Buffer.from([0,255,128]));setTimeout(()=>{process.stdout.write(Buffer.from([10,195,169]));process.stderr.write('complete')},20)"];
  const expected = Buffer.from([0, 255, 128, 10, 195, 169]);
  const binary = await runGitCommandBytes(command, { cwd: tmpdir() });
  expect(binary).toEqual({ exitCode: 0, stdout: expected, stderr: "complete" });
  const publicResult = await runGitCommand(command, { cwd: tmpdir(), captureBytes: true });
  expect(publicResult).toEqual({ exitCode: 0, stdout: expected.toString("utf8"), stdoutBase64: expected.toString("base64"), stderr: "complete" });
  expect(await runGitCommandBytes([], { cwd: tmpdir() })).toEqual({ exitCode: -1, stdout: Buffer.alloc(0), stderr: "no command was given" });
  expect(await runGitCommandBytes(["/definitely-missing-v2347-command"], { cwd: tmpdir() })).toMatchObject({ exitCode: -1, stdout: Buffer.alloc(0) });
  const closed = await runGitCommandBytes([process.execPath, "-e", "process.stdin.destroy();process.exit(0)"], { cwd: tmpdir(), stdin: "x".repeat(2 * 1024 * 1024) });
  expect(closed.exitCode).toBe(-1); expect(closed.stderr).not.toBe("");
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
  // A deep toEqual over 2 MiB takes seconds of vitest time on its own; compare the bytes directly.
  const read = await source("large");
  expect(read?.length).toBe(large.length); expect(Buffer.from(read!).equals(large)).toBe(true);
  const before = f.calls().length;
  await expect(evidence("large")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("oversized") }] });
  expect(f.calls().slice(before).map(call => call.args.slice(0, 2))).toEqual([["cat-file", "-s"]]);
  for (const name of ["../escape", "escape", "cycle"]) await expect(source(name)).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  expect(await source("dangling")).toBeNull();
});
