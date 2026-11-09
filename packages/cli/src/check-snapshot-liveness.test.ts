import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createCheckSnapshot } from "./check-snapshot.ts";
const injected = vi.hoisted(() => ({ preload: "" }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: string[], options: object) =>
    actual.spawn(command, injected.preload && command === process.execPath ? ["--import", injected.preload, ...args] : args, options) };
});
const exec = promisify(execFile);
afterEach(() => { injected.preload = ""; vi.useRealTimers(); });
it.each(["timeout", "cancel"])("awaits worker exit before cleanup after an actual stalled read: %s", async kind => {
 const root = await mkdtemp(path.join(tmpdir(), "snapshot-deadline-"));
 const git = async (...args: string[]) => (await exec("git",args,{cwd:root})).stdout.trim();
 const controller = new AbortController();
 let pending: Promise<unknown> | undefined;
 let snapshot: Awaited<ReturnType<typeof createCheckSnapshot>> | undefined;
 try {
  await git("init","-q");await writeFile(path.join(root,"file.txt"),"source");await git("add",".");
  await git("-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-qm","base");
  const headSha=await git("rev-parse","HEAD"),treeSha=await git("rev-parse","HEAD^{tree}");
  snapshot=await createCheckSnapshot({rootDir:root,candidate:{headSha,treeSha,base:{ref:"origin/main",tipSha:headSha,mergeBaseSha:headSha}},outputs:[],environment:{},signal:controller.signal});
  const marker=path.join(root,"worker-pid"), preload=path.join(root,"stall.mjs");
  await writeFile(preload,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';\nconst original=fs.readFile;fs.readFile=async (...args)=>{if(args[0]===${JSON.stringify(path.join(snapshot.rootDir,"file.txt"))}){await fs.writeFile(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);return new Promise(()=>{});}return original(...args);};syncBuiltinESMExports();`);
  injected.preload=preload;
  // Advance the parent's deadline only after the real child's read is pending.
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  const result=pending=snapshot.verify({timeoutMs:1000}).then(()=>null,error=>error);
  let pid=0;
  for(let i=0;i<200;i++) { try {pid=Number(await readFile(marker,"utf8"));break;}catch{await delay(10);} }
  expect(pid).toBeGreaterThan(0);
  expect(()=>process.kill(pid,0)).not.toThrow();
  if(kind==="timeout") await vi.advanceTimersByTimeAsync(1000); else controller.abort();
  expect(await result).toMatchObject({code:kind==="timeout"?"check_snapshot_timeout":"check_snapshot_interrupted"});
  expect(()=>process.kill(pid,0)).toThrow();
  vi.useRealTimers();
  await snapshot.cleanup();
  await expect(readFile(path.join(snapshot.rootDir,"file.txt"))).rejects.toMatchObject({code:"ENOENT"});
 } finally { controller.abort();await pending;vi.useRealTimers();injected.preload="";await snapshot?.cleanup();await rm(root,{recursive:true,force:true}); }
},10000);

it.each([process.execPath, ...(spawnSync("bun", ["--version"]).status === 0 ? ["bun"] : [])])("keeps canonical inventory bytes in a standalone bundled disposable consumer: %s", async executable => {
 const { build } = await import("esbuild");
 const { digestCanonical, sha256Hex } = await import("@agent-delivery-harness/kernel");
 const { mkdir, symlink, chmod } = await import("node:fs/promises");
 const { fileURLToPath } = await import("node:url");
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"snapshot-bundled-")));
 try {
  const consumer=path.join(root,"consumer");await mkdir(consumer);
  await mkdir(path.join(consumer,"skip"));await writeFile(path.join(consumer,"skip/ignored"),"output");
  await mkdir(path.join(consumer,"node_modules"));await writeFile(path.join(consumer,"node_modules/ignored"),"dependency");
  await writeFile(path.join(consumer,"a.txt"),"source");await chmod(path.join(consumer,"a.txt"),0o755);
  await symlink("a.txt",path.join(consumer,"link"));
  const bundle=path.join(root,"snapshot.mjs");
  const result=await build({entryPoints:[fileURLToPath(new URL("./check-snapshot.ts",import.meta.url))],outfile:bundle,bundle:true,platform:"node",format:"esm",target:"node22.6",metafile:true,logLevel:"silent"});
  // Only runtime builtins: Node's, and Bun's FFI, which the kernel loads only under Bun.
  expect(Object.values(result.metafile!.outputs).flatMap(output=>output.imports).filter(row=>!(row.path.startsWith("node:") || ["fs","path","os","crypto","util","child_process","bun:ffi"].includes(row.path)))).toEqual([]);
  const script=`const {snapshotInventory}=await import(${JSON.stringify(bundle)});console.log(await snapshotInventory(${JSON.stringify(consumer)},['skip/'],true));`;
  const output=await exec(executable,["--input-type=module","--eval",script],{cwd:consumer,env:{PATH:process.env["PATH"]}});
  expect(output.stdout.trim()).toBe(digestCanonical([["a.txt",0o111,sha256Hex("source")],["link","link","a.txt"]]));
 } finally {await rm(root,{recursive:true,force:true});}
},15000);
