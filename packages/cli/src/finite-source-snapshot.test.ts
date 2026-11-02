import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createCheckSnapshot, type SnapshotRequest } from "./check-snapshot.ts";

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "finite-source-")); roots.push(root);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "entry.mjs"), "export const value = 'candidate';\n"); await chmod(path.join(root, "entry.mjs"), 0o755);
  await writeFile(path.join(root, "unrelated.txt"), "excluded sentinel");
  await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
  const headSha = await git("rev-parse", "HEAD"), treeSha = await git("write-tree");
  const request = { rootDir: root, candidate: { headSha, treeSha, base: { ref: "origin/main", tipSha: headSha, mergeBaseSha: headSha } },
    gitContext: "none", outputs: ["result.json"], environment: {}, physicalSource: { version: "physical-source/1", files: ["entry.mjs"], absentInputs: ["startup.cjs"] } } as SnapshotRequest;
  return { root, git, request };
}
it.each(['file','ancestor','descendant','root'].flatMap(kind=>['direct','chained'].map(chain=>({kind,chain}))))('finite repair rejects dangling protected output alias before consumer $kind/$chain',async({kind,chain})=>{
  const f=await fixture(),target=kind==='file'?'config/startup.cjs':kind==='ancestor'?'config':kind==='root'?'.':'config/startup.cjs/child';
  const ran=path.join(f.root,'.git/consumer-ran'),outputs=['out','result.json'];
  // An owned dependency link is outside mutable outputs and excluded only from
  // source comparison. It must not mask a broken outer-output alias resolver.
  const setup=chain==='direct'?`fs.symlinkSync(${JSON.stringify(target)},'out');`:`fs.mkdirSync('node_modules');fs.symlinkSync(${JSON.stringify('../'+target)},'node_modules/relay');fs.symlinkSync('node_modules/relay','out');`;
  const input={...f.request,outputs,physicalSource:{...f.request.physicalSource!,absentInputs:['config/startup.cjs']},dependencies:{command:[process.execPath,'-e',`const fs=require('fs');${setup}`] as [string,...string[]],timeoutMs:5000}};
  let failure:unknown,snapshot:Awaited<ReturnType<typeof createCheckSnapshot>>|undefined;
  try{snapshot=await createCheckSnapshot(input);await snapshot.verify();await exec(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(ran)},'executed')`],{cwd:snapshot.rootDir});}
  catch(error){failure=error;}finally{await snapshot?.cleanup();}
  await expect(lstat(ran)).rejects.toMatchObject({code:'ENOENT'});
  expect(failure).toMatchObject({code:'check_snapshot_drift'});
});
it('finite repair rejects a dangling output alias with a missing suffix after a dependency link',async()=>{
  const f=await fixture(),input={...f.request,outputs:['out'],physicalSource:{...f.request.physicalSource!,absentInputs:['config/startup.cjs']},dependencies:{command:[process.execPath,'-e',"const fs=require('fs');fs.mkdirSync('node_modules');fs.symlinkSync('../config','node_modules/relay');fs.symlinkSync('node_modules/relay/startup.cjs','out');"] as [string,...string[]],timeoutMs:5000}};
  await expect(createCheckSnapshot(input)).rejects.toMatchObject({code:'check_snapshot_drift'});
});
it('finite repair allows a nonoverlapping dangling output alias and ordinary consumer output',async()=>{
  const f=await fixture(),input={...f.request,outputs:['out','relay','result.json'],physicalSource:{...f.request.physicalSource!,absentInputs:['config/startup.cjs']},dependencies:{command:[process.execPath,'-e',"const fs=require('fs');fs.symlinkSync('safe/missing.json','relay');fs.symlinkSync('relay','out');"] as [string,...string[]],timeoutMs:5000}};
  const snapshot=await createCheckSnapshot(input);
  try{await exec(process.execPath,['-e',"require('fs').writeFileSync('result.json','consumer passed')"],{cwd:snapshot.rootDir});await snapshot.verify();expect(await readFile(path.join(snapshot.rootDir,'result.json'),'utf8')).toBe('consumer passed');}
  finally{await snapshot.cleanup();}
});
it.each(['per-file','aggregate'] as const)('finite repair real reader accepts exact source boundary and rejects one byte over: %s',async kind=>{
  const f=await fixture(),size=8*1024*1024,files=Array.from({length:kind==='per-file'?1:8},(_,i)=>`boundary-${i}.bin`);
  for(const[index,file]of files.entries())await writeFile(path.join(f.root,file),Buffer.alloc(size,65+index));
  await f.git('add','.');const exact={...f.request,candidate:{...f.request.candidate,treeSha:await f.git('write-tree')},physicalSource:{version:'physical-source/1' as const,files,absentInputs:[]}};
  const snapshot=await createCheckSnapshot(exact);
  try{for(const[index,file]of files.entries()){const bytes=await readFile(path.join(snapshot.rootDir,file));expect(bytes.length).toBe(size);expect(bytes[0]).toBe(65+index);}await snapshot.verify();}finally{await snapshot.cleanup();}
  const over=kind==='per-file'?files:[...files,'one-extra-byte.bin'];
  await writeFile(path.join(f.root,over.at(-1)!),Buffer.alloc(kind==='per-file'?size+1:1,99));await f.git('add','.');
  let failure:unknown,unexpected:Awaited<ReturnType<typeof createCheckSnapshot>>|undefined;
  try{unexpected=await createCheckSnapshot({...exact,candidate:{...exact.candidate,treeSha:await f.git('write-tree')},physicalSource:{...exact.physicalSource,files:over}});}catch(error){failure=error;}finally{await unexpected?.cleanup();}
  expect(failure).toMatchObject({code:'check_physical_source_invalid'});
},30000);
it("finite source materializes exact candidate bytes and modes while full fallback retains the sentinel", async () => {
  const f = await fixture(); await writeFile(path.join(f.root, "entry.mjs"), "author edit");
  const snapshot = await createCheckSnapshot(f.request);
  try {
    expect(await readFile(path.join(snapshot.rootDir, "entry.mjs"), "utf8")).toBe("export const value = 'candidate';\n");
    expect((await lstat(path.join(snapshot.rootDir, "entry.mjs"))).mode & 0o111).toBe(0o111);
    await expect(lstat(path.join(snapshot.rootDir, "unrelated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(snapshot.rootDir, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await snapshot.verify();
  } finally { await snapshot.cleanup(); }
  const { physicalSource: _ignored, ...fullRequest } = f.request;
  const full = await createCheckSnapshot(fullRequest);
  try { expect(await readFile(path.join(full.rootDir, "unrelated.txt"), "utf8")).toBe("excluded sentinel"); await full.verify(); }
  finally { await full.cleanup(); }
});
it.each(['entry','ancestor'])("finite source refuses candidate internal links before setup even when their target is omitted: %s", async kind => {
  const f = await fixture();
  if(kind==='entry'){await rm(path.join(f.root, "entry.mjs")); await symlink("unrelated.txt", path.join(f.root, "entry.mjs"));}
  else{await mkdir(path.join(f.root,'target'));await writeFile(path.join(f.root,'target/entry.mjs'),'omitted target');await symlink('target',path.join(f.root,'linked'));f.request={...f.request,physicalSource:{...f.request.physicalSource!,files:['linked/entry.mjs']}};}
  await f.git("add", "."); f.request = { ...f.request, candidate: { ...f.request.candidate, treeSha: await f.git("write-tree") } };
  await expect(createCheckSnapshot(f.request)).rejects.toMatchObject({ code: "check_physical_source_invalid" });
});
it("finite source refuses a present candidate absence and cancellation before allocation",async()=>{
  const f=await fixture();await writeFile(path.join(f.root,'startup.cjs'),'present');await f.git('add','.');
  const input={...f.request,candidate:{...f.request.candidate,treeSha:await f.git('write-tree')}};
  await expect(createCheckSnapshot(input)).rejects.toMatchObject({code:'check_physical_source_invalid'});
  const controller=new AbortController();controller.abort();
  await expect(createCheckSnapshot({...f.request,signal:controller.signal})).rejects.toMatchObject({code:'check_snapshot_interrupted'});
});
it("finite source preserves binary candidate bytes",async()=>{
  const f=await fixture(),bytes=Buffer.from([0,255,128,10,0]);await writeFile(path.join(f.root,'asset.bin'),bytes);await f.git('add','.');
  const input={...f.request,candidate:{...f.request.candidate,treeSha:await f.git('write-tree')},physicalSource:{...f.request.physicalSource!,files:['entry.mjs','asset.bin']}};
  const snapshot=await createCheckSnapshot(input);
  try{expect(await readFile(path.join(snapshot.rootDir,'asset.bin'))).toEqual(bytes);await snapshot.verify();}finally{await snapshot.cleanup();}
});
it.each(['out/','out/startup.cjs'])("finite source refuses output aliases into protected absences before command: %s",async output=>{
  const f=await fixture();
  const input={...f.request,outputs:[output],physicalSource:{...f.request.physicalSource!,absentInputs:['config/startup.cjs']},dependencies:{command:[process.execPath,'-e',"const fs=require('fs');fs.mkdirSync('config');fs.symlinkSync('config','out');"] as [string,...string[]],timeoutMs:5000}};
  await expect(createCheckSnapshot(input)).rejects.toMatchObject({code:'check_snapshot_drift'});
});
it.each(["startup.cjs", "startup.cjs/", "config/", "config/startup.cjs"])("finite source refuses protected absence/output overlap %s before setup", async output => {
  const f = await fixture();
  f.request = { ...f.request, outputs: [output], physicalSource: { version: "physical-source/1", files: ["entry.mjs"], absentInputs: [output.startsWith("config") ? "config/startup.cjs" : "startup.cjs"] } };
  await expect(createCheckSnapshot(f.request)).rejects.toMatchObject({ code: "check_physical_source_invalid" });
});
it("finite source protects absent startup after setup and command while ordinary output succeeds", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot(f.request);
  try {
    await writeFile(path.join(snapshot.rootDir, "result.json"), "allowed"); await snapshot.verify();
    await writeFile(path.join(snapshot.rootDir, "startup.cjs"), "injected");
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
  const setup = await fixture(); setup.request = { ...setup.request, dependencies: { command: [process.execPath, "-e", "require('fs').writeFileSync('startup.cjs','injected')"], timeoutMs: 5000 } };
  await expect(createCheckSnapshot(setup.request)).rejects.toMatchObject({ code: "check_snapshot_drift" });
});
it("finite source refuses full Git and missing candidate inputs", async () => {
  const f = await fixture();
  await expect(createCheckSnapshot({ ...f.request, gitContext: "full" })).rejects.toMatchObject({ code: "check_physical_source_invalid" });
  await expect(createCheckSnapshot({ ...f.request, physicalSource: { version: "physical-source/1", files: ["missing.mjs"], absentInputs: [] } })).rejects.toMatchObject({ code: "check_physical_source_invalid" });
});
it.each(["startup.cjs","config/"])("finite source rejects an output-authorized setup injecting protected startup %s",async output=>{
  const f=await fixture(),absent=output==='config/'?'config/startup.cjs':'startup.cjs',ran=path.join(f.root,'.git/setup-ran');
  const input={...f.request,outputs:[output],physicalSource:{...f.request.physicalSource!,absentInputs:[absent]},dependencies:{command:[process.execPath,'-e',`const fs=require('fs');fs.mkdirSync(require('path').dirname(${JSON.stringify(absent)}),{recursive:true});fs.writeFileSync(${JSON.stringify(absent)},'injected startup');fs.writeFileSync(${JSON.stringify(ran)},'executed');`] as [string,...string[]],timeoutMs:5000}};
  let failure:unknown,snapshot:Awaited<ReturnType<typeof createCheckSnapshot>>|undefined;
  try{snapshot=await createCheckSnapshot(input);}catch(error){failure=error;}finally{await snapshot?.cleanup();}
  await expect(lstat(ran)).rejects.toMatchObject({code:'ENOENT'});
  expect(failure).toMatchObject({code:'check_physical_source_invalid'});
});
it("finite source setup and consumer observe the owned finite cwd and all dependencies remain verified", async () => {
  const f = await fixture(), observation = path.join(f.root, ".git", "physical-cwds.jsonl");
  const inspect = `const fs=require('fs');if(fs.existsSync('unrelated.txt')||fs.existsSync('.git')||fs.readFileSync('entry.mjs','utf8')!=="export const value = 'candidate';\\n"||(fs.statSync('entry.mjs').mode&73)!==73)throw Error('wrong physical tree');fs.appendFileSync(${JSON.stringify(observation)},JSON.stringify({cwd:process.cwd(),included:fs.readFileSync('entry.mjs','utf8'),excluded:fs.existsSync('unrelated.txt')})+'\\n');`;
  f.request = { ...f.request, dependencies: { command: [process.execPath, "-e", inspect + "fs.mkdirSync('node_modules/pkg',{recursive:true});fs.writeFileSync('node_modules/pkg/index.js','installed');"], timeoutMs: 5000 } };
  const snapshot = await createCheckSnapshot(f.request);
  try {
    await exec(process.execPath, ["-e", inspect + "fs.writeFileSync('result.json','allowed');"], { cwd: snapshot.rootDir, env: snapshot.environment });
    const rows = (await readFile(observation, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(2); expect(rows.every(row => row.cwd === snapshot.rootDir && !row.excluded)).toBe(true);
    await snapshot.verify();
    await writeFile(path.join(snapshot.rootDir, "node_modules/pkg/index.js"), "dependency drift");
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
});

it.each([false,true])('finite repair protects nested output directory aliases before consumer unsafe=%s',async unsafe=>{
  const f=await fixture(),ran=path.join(f.root,'.git/nested-consumer-ran');
  const destination=unsafe?'config':'safe';
  const setup=`const fs=require('fs');fs.mkdirSync('config');fs.mkdirSync('safe');fs.mkdirSync('node_modules/tree',{recursive:true});fs.symlinkSync('../../${destination}','node_modules/tree/link');fs.symlinkSync('node_modules/tree','out');`;
  const input={...f.request,outputs:['out/','result.json'],physicalSource:{...f.request.physicalSource!,absentInputs:['config/startup.cjs']},dependencies:{command:[process.execPath,'-e',setup] as [string,...string[]],timeoutMs:5000}};
  let failure:unknown,snapshot:Awaited<ReturnType<typeof createCheckSnapshot>>|undefined;
  try{
    snapshot=await createCheckSnapshot(input);await snapshot.verify();
    await exec(process.execPath,['-e',`const fs=require('fs');${unsafe?"fs.writeFileSync('out/link/startup.cjs','injected');":"if(!fs.statSync('out/link').isDirectory())throw Error('safe alias unavailable');"}fs.writeFileSync('result.json','consumer passed');fs.writeFileSync(${JSON.stringify(ran)},'executed');`],{cwd:snapshot.rootDir,env:snapshot.environment});
    if(!unsafe){await snapshot.verify();expect(await readFile(path.join(snapshot.rootDir,'result.json'),'utf8')).toBe('consumer passed');}
  }catch(error){failure=error;}finally{await snapshot?.cleanup();}
  if(unsafe){await expect(lstat(ran)).rejects.toMatchObject({code:'ENOENT'});expect(failure).toMatchObject({code:'check_snapshot_drift'});}
  else{expect(failure).toBeUndefined();expect(await readFile(ran,'utf8')).toBe('executed');}
});
