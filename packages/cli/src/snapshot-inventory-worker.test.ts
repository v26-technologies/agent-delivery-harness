import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { snapshotInventoryWorker } from "./snapshot-inventory-worker.ts";

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = (tuples: unknown[]) => sha(JSON.stringify(tuples));
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "inventory-io-"))); roots.push(root);
  return { root, put: async (file: string, contents: string) => { await mkdir(path.dirname(path.join(root,file)), { recursive: true }); await writeFile(path.join(root,file),contents); } };
}
/** Instruments the actual builtin boundary in the actual worker child. It adds
 * no request fields and has no wall-clock performance assertions. */
async function run(root: string, options: { outputs?: string[]; absentInputs?: string[]; excludeDependencies?: boolean; forbidGit?: boolean; includeSource?: boolean; probe?: boolean; fail?: string } = {}) {
  const control = await mkdtemp(path.join(tmpdir(), "inventory-probe-")); roots.push(control);
  const report = path.join(control,"report.json"), preload = path.join(control,"probe.mjs");
  if (options.probe) await writeFile(preload, `
import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const state={active:0,peak:0,started:0,finished:0,activeAtResult:null,reads:[],stats:[]};
for(const name of ['lstat','readdir','readFile','readlink','realpath']){
 const original=fs[name];fs[name]=async (...args)=>{
  state.started++;state.active++;state.peak=Math.max(state.peak,state.active);
  if(name==='readFile')state.reads.push(String(args[0]));if(name==='lstat')state.stats.push(String(args[0]));
  try{await new Promise(resolve=>setImmediate(resolve));
   if(name==='readFile' && String(args[0]).endsWith(${JSON.stringify('/'+(options.fail??'no-failure-sentinel'))}))throw Object.assign(new Error('controlled I/O failure'),{code:'EIO'});
   return await original(...args);
  }finally{state.active--;state.finished++;}
 };
}
syncBuiltinESMExports();
const write=process.stdout.write.bind(process.stdout);process.stdout.write=(...args)=>{state.activeAtResult=state.active;return write(...args);};
process.on('exit',()=>writeFileSync(${JSON.stringify(report)},JSON.stringify(state)));
`);
  const {probe,fail,...request}=options;
  let result;
  try { const value=await exec(process.execPath,[...(probe?["--import",preload]:[]),"--input-type=module","--eval",snapshotInventoryWorker],{env:{DELIVERY_SNAPSHOT_REQUEST:JSON.stringify({root,outputs:[],...request})},maxBuffer:1024*1024});result={code:0,stdout:value.stdout}; }
  catch(error) { const failure=error as {code:number;stdout:string};result={code:failure.code,stdout:failure.stdout}; }
  return {...result,value:JSON.parse(result.stdout),probe:probe?JSON.parse(await readFile(report,"utf8")):undefined};
}
it("overlaps inventory I/O with a hard eight-operation ceiling and drains late directory work",async()=>{
  const f=await fixture();
  for(let i=0;i<40;i++)await f.put(`d${String(i).padStart(2,"0")}/file.txt`,`file-${i}`);
  for(let i=0;i<256;i++)await f.put(`z-late/only/after/directories/n${String(i).padStart(3,"0")}.txt`,`late-${i}`);
  const result=await run(f.root,{probe:true,includeSource:true});
  expect(result.code).toBe(0);expect(result.probe.started).toBeGreaterThan(0);
  expect(result.probe.peak).toBeGreaterThan(1);expect(result.probe.peak).toBeLessThanOrEqual(8);
  expect(result.probe.reads).toHaveLength(296);expect(result.probe.activeAtResult).toBe(0);expect(result.probe.started).toBe(result.probe.finished);
  const tuples=[...Array.from({length:40},(_,i)=>[`d${String(i).padStart(2,"0")}/file.txt`,0,sha(`file-${i}`)]),...Array.from({length:256},(_,i)=>[`z-late/only/after/directories/n${String(i).padStart(3,"0")}.txt`,0,sha(`late-${i}`)])];
  expect(result.value).toEqual({digest:digest(tuples),sourceDigest:digest(tuples)});
});
it("bounds canonical absence and output-alias resolution I/O as well as file reads",async()=>{
  const f=await fixture();await f.put("source","bytes");
  const absentInputs=Array.from({length:64},(_,i)=>`missing/n${i}/startup.cjs`);
  const result=await run(f.root,{probe:true,absentInputs});
  expect(result.code).toBe(0);expect(result.probe.peak).toBeGreaterThan(1);expect(result.probe.peak).toBeLessThanOrEqual(8);
  expect(result.probe.started).toBe(result.probe.finished);expect(result.probe.activeAtResult).toBe(0);
});
it("preserves legacy DFS tuple bytes, executable modes, owned links and mutable output exclusions",async()=>{
  const f=await fixture();await f.put("a/child","child");await f.put("a.c","sibling");await chmod(path.join(f.root,"a.c"),0o755);
  await f.put("node_modules/pkg/data","dependency");await f.put("cache/product","mutable");await f.put(".git/config","ignored");
  await symlink("a/child",path.join(f.root,"link"));await symlink("../a",path.join(f.root,"cache","owned-link"));
  const source=[["a/child",0,sha("child")],["a.c",0o111,sha("sibling")],["link","link","a/child"]],all=[...source,["node_modules/pkg/data",0,sha("dependency")]];
  const result=await run(f.root,{outputs:["cache/"],includeSource:true,absentInputs:["missing/startup.cjs"],probe:true});
  expect(result.code).toBe(0);expect(result.value).toEqual({digest:digest(all),sourceDigest:digest(source)});
  expect((await run(f.root,{outputs:["cache/"],excludeDependencies:true})).value.digest).toBe(digest(source));
  expect((await run(f.root,{forbidGit:true})).value).toEqual({code:"check_snapshot_drift"});
});
it("settles every started I/O before reporting a failure",async()=>{
  const f=await fixture();for(let i=0;i<40;i++)await f.put(`f${String(i).padStart(2,"0")}.txt`,"bytes");
  const result=await run(f.root,{probe:true,fail:"f03.txt"});
  expect(result.code).toBe(1);expect(result.value).toEqual({code:"check_snapshot_unavailable"});
  expect(result.probe.started).toBe(result.probe.finished);expect(result.probe.activeAtResult).toBe(0);expect(result.probe.peak).toBeLessThanOrEqual(8);
});
it("does not hide escaping links or protected absence aliases inside mutable outputs",async()=>{
  const f=await fixture();await f.put("source","bytes");await mkdir(path.join(f.root,"cache"));
  await symlink("../../outside",path.join(f.root,"cache","escape"));
  expect((await run(f.root,{outputs:["cache/"],probe:true})).value).toEqual({code:"check_snapshot_escape"});
  await rm(path.join(f.root,"cache","escape"));await mkdir(path.join(f.root,"protected"));await symlink("../protected",path.join(f.root,"cache","alias"));
  expect((await run(f.root,{outputs:["cache/"],absentInputs:["protected/startup.cjs"],probe:true})).value).toEqual({code:"check_snapshot_drift"});
});
