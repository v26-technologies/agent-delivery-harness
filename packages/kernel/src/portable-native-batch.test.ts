import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { candidateTreeSourceReader } from "./portable-inputs.ts";
import { captureScopedCheckInputs } from "./checks.ts";

const binary = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./candidate.ts", async importOriginal => ({ ...await importOriginal<typeof import("./candidate.ts")>(), runGitCommandBytes: binary.run }));
const roots: string[] = [];
afterEach(() => { binary.run.mockReset(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve}; }
const oid=(bytes:Buffer)=>createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function fixture(count=80) {
 const root=mkdtempSync(path.join(tmpdir(),"source-batch-pool-"));roots.push(root);
 const git=(...args:string[])=>execFileSync("git",args,{cwd:root}).toString().trim();git("init","-q");
 const paths=Array.from({length:count},(_,index)=>`file-${String(index).padStart(3,"0")}`),objects=new Map<string,Buffer>();
 for(const file of paths){const bytes=Buffer.from(file);objects.set(oid(bytes),bytes);writeFileSync(path.join(root,file),bytes);}
 writeFileSync(path.join(root,"file-alias"),Buffer.from(paths[0]!));git("add",".");const tree=git("write-tree");
 let hold=true,active=0,peak=0;const jobs:Array<{shas:string[];gate:ReturnType<typeof deferred<void>>;result?:{exitCode:number;stdout:Buffer;stderr:string}}>=[];
 const frame=(shas:string[])=>Buffer.concat(shas.map(sha=>{const bytes=objects.get(sha)!;return Buffer.concat([Buffer.from(`${sha} blob ${bytes.length}\n`),bytes,Buffer.from("\n")]);}));
 binary.run.mockImplementation(async (command:string[],options:{stdin:string})=>{
  expect(command).toEqual(["git","cat-file","--batch"]);const shas=options.stdin.trim().split("\n"),gate=deferred<void>(),job={shas,gate} as typeof jobs[number];jobs.push(job);peak=Math.max(peak,++active);
  try{if(hold)await gate.promise;return job.result??{exitCode:0,stdout:frame(shas),stderr:""};}finally{active--;}
 });
 return {root,paths,tree,objects,jobs,frame,get active(){return active;},get peak(){return peak;},release:()=>{hold=false;for(const job of jobs)job.gate.resolve();}};
}
it("feeds four native children of at most eight objects, completes a larger queue, and owns cached buffers",async()=>{
 const f=fixture(),read=await candidateTreeSourceReader(f.root,f.tree);let result:Awaited<ReturnType<typeof read>>[]=[];
 const pending=Promise.all([...f.paths,"file-alias"].map(file=>read(file)));
 try{await setImmediate();expect(f.jobs).toHaveLength(4);expect(f.active).toBe(4);expect(f.jobs.map(job=>job.shas.length)).toEqual([8,8,8,8]);}
 finally{f.release();result=await pending;}
 expect(f.peak).toBe(4);expect(f.active).toBe(0);expect(f.jobs).toHaveLength(10);expect(f.jobs.every(job=>job.shas.length<=8)).toBe(true);
 expect(result).toEqual([...f.paths,f.paths[0]!].map(file=>Buffer.from(file)));result[0]![0]=0;
 expect(await read("file-alias")).toEqual(Buffer.from(f.paths[0]!));expect(f.jobs).toHaveLength(10);
});
it("keeps one held batch private until its last frame validates, rejects all siblings, and evicts failures",async()=>{
 const f=fixture(8),read=await candidateTreeSourceReader(f.root,f.tree);f.release();
 binary.run.mockImplementationOnce(async (_command,options:{stdin:string})=>{const output=f.frame(options.stdin.trim().split("\n"));output[output.length-2]=output[output.length-2]!^1;return {exitCode:0,stdout:output,stderr:""};});
 const failed=await Promise.allSettled(f.paths.map(file=>read(file)));
 expect(failed.every(result=>result.status==="rejected")).toBe(true);for(const result of failed)if(result.status==="rejected")expect(result.reason).toMatchObject({blockers:[{code:"portable_tree_unreadable"}]});
 expect(await Promise.all(f.paths.map(file=>read(file)))).toEqual(f.paths.map(file=>Buffer.from(file)));
});
it("drains other native children before a scoped capture rejects and preserves the first sorted error",async()=>{
 const f=fixture(),read=await candidateTreeSourceReader(f.root,f.tree);let settled=false;
 const definition={version:"scoped-check/1" as const,files:[...f.paths].reverse(),tests:[],memberships:[],cwd:".",profile:"fixture",environment:[]};
 const first=new Error("earlier sorted metadata failure");
 const pending=captureScopedCheckInputs(definition,{listFiles:async()=>f.paths,readFile:read,readMetadata:async file=>{if(file===f.paths[0])throw first;return read.metadata(file);},command:["test"],timeoutMs:1000,runtimeDigest:"a".repeat(64),dependencyDigest:"b".repeat(64),releaseDigest:"c".repeat(64),policyDigest:"d".repeat(64),environment:{},credentialIdentity:()=>null}).then(()=>({ok:true}),error=>({ok:false,error})).finally(()=>{settled=true;});
 try{
  await setImmediate();expect(f.jobs).toHaveLength(4);
  f.jobs[3]!.result={exitCode:1,stdout:Buffer.alloc(0),stderr:"controlled failed later child"};f.jobs[3]!.gate.resolve();
  await setImmediate();expect(settled).toBe(false);
  f.jobs[0]!.gate.resolve();await setImmediate();expect(settled).toBe(false);
 }finally{f.release();}
 const result=await pending;expect(result).toEqual({ok:false,error:first});expect(f.active).toBe(0);
 expect(f.jobs.flatMap(job=>job.shas)).toHaveLength(32);expect(f.peak).toBe(4);

});
