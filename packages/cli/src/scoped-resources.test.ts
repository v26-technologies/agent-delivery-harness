import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactsPort, defineHarnessConfig, digestCanonical, type HarnessConfigInput, type InstalledDataResourceContext } from "@agent-delivery-harness/kernel";
import base from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";
import { ScopedChecks } from "./scoped-checks.ts";
import * as snapshots from "./check-snapshot.ts";
const exec = promisify(execFile), roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
const resourceContext:InstalledDataResourceContext={setupRecipeDigest:digestCanonical('setup'),dependencyDigest:digestCanonical('deps'),runtimeDigest:digestCanonical('node'),releaseDigest:digestCanonical('release'),policyDigest:digestCanonical('policy')};
const request={version:'installed-package-data/1' as const,id:'font',issuer:'packages/app/font.test.ts',package:'@fonts/demo',manifest:'package.json' as const,files:['wght.css'],directories:[{path:'files',suffix:'-normal.woff2'}]};
async function fixture() {
  const dir=await mkdtemp(path.join(tmpdir(),'scoped-resource-cli-'));roots.push(dir);
  const git=async(...args:string[])=>(await exec('git',args,{cwd:dir})).stdout.trim();
  await git('init','-q');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
  await mkdir(path.join(dir,'packages/app'),{recursive:true});await writeFile(path.join(dir,request.issuer),'export {};\n');await writeFile(path.join(dir,'harness.config.ts'),'export default {};\n');
  await git('add','.');await git('-c','commit.gpgsign=false','commit','-qm','base');await git('branch','origin/main');
  const setupCount=path.join(dir,'.git/setup-count'),commandCount=path.join(dir,'.git/command-count');
  const setup=`const fs=require('fs');const root='node_modules/@fonts/demo';fs.mkdirSync(root+'/files',{recursive:true});fs.writeFileSync(root+'/package.json',JSON.stringify({name:'@fonts/demo',exports:{'./package.json':'./package.json'}}));fs.writeFileSync(root+'/wght.css','font-css');fs.writeFileSync(root+'/files/a-normal.woff2',Buffer.from([0,255,1]));fs.appendFileSync(${JSON.stringify(setupCount)},${JSON.stringify('setup\n')});`;
  const provider={id:'check.font',findingCodes:[],check:{command:[process.execPath,'-e',`const fs=require('fs');fs.appendFileSync(${JSON.stringify(commandCount)},${JSON.stringify('command\n')});fs.writeFileSync('result.json','{}');`],timeoutMs:5000,outputs:['result.json'],scope:{version:'scoped-check/1',files:[request.issuer],memberships:[],tests:[],cwd:'.',profile:'fixture',environment:[]}}};
  const config=defineHarnessConfig({...base,preparationWiringPaths:['harness.config.ts'],preparationCommands:[],providers:[provider],obligations:[{...base.obligations[0]!,id:'font.passed',activation:{kind:'always'},providers:[provider.id],acceptedPayloadSpecs:['checks.passed/1'],humanWaiverAllowed:false,allowedResolutionKinds:['satisfied_evidence']}],scopedExecution:{version:'scoped-execution/1',mechanicalProviders:[provider.id],profiles:[{id:'fixture',gitContext:'full',dependencyInputs:[],mutableOutputs:['result.json'],credentialIdentities:{},dependencies:{command:[process.execPath,'-e',setup],timeoutMs:5000}}]}} as unknown as HarnessConfigInput);
  const artifacts=path.join(dir,'.git/artifacts');await mkdir(artifacts);const errors:string[]=[];
  const runtime:CliRuntime={cwd:dir,env:{PATH:process.env['PATH']!},stdinIsTTY:false,stdoutIsTTY:false,stdout:()=>{},stderr:s=>errors.push(s),loadConfig:async()=>config,artifacts:createArtifactsPort({runRootBase:artifacts})};
  return {dir,config,runtime,errors,setupCount,commandCount};
}
async function duringCreation(hook:(session:ScopedChecks)=>Promise<void>) {
  const create=ScopedChecks.create;let hookFailure:unknown;
  vi.spyOn(ScopedChecks,'create').mockImplementation(async(...args)=>{
    const session=await create(...args);
    try {await hook(session!);}catch(error){hookFailure=error;throw error;}
    return session;
  });
  return ()=>{if(hookFailure)throw hookFailure;};
}
describe('native scoped installed resources',()=>{
  it('captures without a command or attempt, then executes using the same one-setup serial snapshot',async()=>{
    const f=await fixture();const createSnapshot=snapshots.createCheckSnapshot;const snapshotRoots:string[]=[];
    vi.spyOn(snapshots,'createCheckSnapshot').mockImplementation(async input=>{const s=await createSnapshot(input);snapshotRoots.push(s.rootDir);return s;});
    let active:ScopedChecks|undefined;
    const verifyHook=await duringCreation(async session=>{
      active=session;
      const [facts,second]=await Promise.all([session.captureInstalledData('check.font',[request],resourceContext),session.captureInstalledData('check.font',[request],resourceContext)]);
      expect(second.digest).toBe(facts.digest);
      expect(facts.resources[0]!.entries.find(e=>e.path.endsWith('a-normal.woff2'))?.bytesBase64).toBe('AP8B');
      expect((await session.plan()).checks['check.font']!.attempts).toHaveLength(0);
      expect(await readFile(f.setupCount,'utf8')).toBe('setup\n');
      await expect(access(f.commandCount)).rejects.toMatchObject({code:'ENOENT'});
    });
    const code=await runCli(['prepare'],f.runtime);verifyHook();expect(code,f.errors.join('\n')).toBe(0);
    expect(await readFile(f.setupCount,'utf8')).toBe('setup\n');expect(await readFile(f.commandCount,'utf8')).toBe('command\n');
    expect(snapshotRoots).toHaveLength(1);await expect(access(snapshotRoots[0]!)).rejects.toMatchObject({code:'ENOENT'});
    await expect(active!.captureInstalledData('check.font',[request],resourceContext)).rejects.toMatchObject({code:'installed_data_capture_closed'});
  },30000);
  it('closes execution capture phase and drains an already accepted capture before the real command',async()=>{
    const f=await fixture();let capture:ReturnType<ScopedChecks['captureInstalledData']>|undefined;let finished=false;
    const execute=ScopedChecks.prototype.execute;
    vi.spyOn(ScopedChecks.prototype,'execute').mockImplementation(async function(this:ScopedChecks,...args){
      const running=execute.apply(this,args);
      expect(finished).toBe(false);
      await expect(this.captureInstalledData('check.font',[request],resourceContext)).rejects.toMatchObject({code:'installed_data_capture_closed'});
      await expect(access(f.commandCount)).rejects.toMatchObject({code:'ENOENT'});
      await running;expect(finished).toBe(true);
    });
    const verifyHook=await duringCreation(async session=>{
      capture=session.captureInstalledData('check.font',[request],resourceContext);
      void capture.then(()=>{finished=true;},()=>{});
    });
    const code=await runCli(['prepare'],f.runtime);verifyHook();expect(code,f.errors.join('\n')).toBe(0);
    expect((await capture!).version).toBe('installed-data-capture/1');
    expect(await readFile(f.setupCount,'utf8')).toBe('setup\n');expect(await readFile(f.commandCount,'utf8')).toBe('command\n');
  },30000);
  it('cleanup drains accepted native capture before releasing its snapshot and refuses later captures',async()=>{
    const f=await fixture();const createSnapshot=snapshots.createCheckSnapshot;let snapshotRoot:string|undefined;
    vi.spyOn(snapshots,'createCheckSnapshot').mockImplementation(async input=>{const snapshot=await createSnapshot(input);snapshotRoot=snapshot.rootDir;return snapshot;});
    const verifyHook=await duringCreation(async session=>{
      const accepted=session.captureInstalledData('check.font',[request],resourceContext);
      const cleaned=session.cleanup();
      await expect(session.captureInstalledData('check.font',[request],resourceContext)).rejects.toMatchObject({code:'installed_data_capture_closed'});
      const facts=await accepted;await cleaned;
      expect(facts.version).toBe('installed-data-capture/1');await expect(access(snapshotRoot!)).rejects.toMatchObject({code:'ENOENT'});
      expect((await session.plan()).checks['check.font']!.attempts).toHaveLength(0);
      await expect(access(f.commandCount)).rejects.toMatchObject({code:'ENOENT'});
      throw Error('expected fixture stop after capture cleanup');
    });
    expect(await runCli(['prepare'],f.runtime)).toBe(1);expect(()=>verifyHook()).toThrow('expected fixture stop after capture cleanup');
    expect(await readFile(f.setupCount,'utf8')).toBe('setup\n');
  },30000);
  it('refuses an unknown/unscoped provider and a missing profile before any setup',async()=>{
    const f=await fixture();
    const verifyHook=await duringCreation(async session=>{
      await expect(session.captureInstalledData('missing',[request],resourceContext)).rejects.toMatchObject({code:'scoped_executor_required'});
      const originalContext=session.context;
      try {
        const provider=originalContext.config.providers[0]!;
        Object.defineProperty(session,'context',{value:{...originalContext,config:{...originalContext.config,providers:[{...provider,check:{...provider.check!,scope:undefined}}]}}});
        await expect(session.captureInstalledData('check.font',[request],resourceContext)).rejects.toMatchObject({code:'scoped_executor_required'});
        Object.defineProperty(session,'context',{value:{...originalContext,config:{...originalContext.config,scopedExecution:{...originalContext.config.scopedExecution!,profiles:[]}}}});
        await expect(session.captureInstalledData('check.font',[request],resourceContext)).rejects.toMatchObject({code:'scoped_executor_required'});
      } finally {Object.defineProperty(session,'context',{value:originalContext});}
      await expect(access(f.setupCount)).rejects.toMatchObject({code:'ENOENT'});
    });
    const code=await runCli(['prepare'],f.runtime);verifyHook();expect(code,f.errors.join('\n')).toBe(0);
  },30000);
  it('refuses resource drift without returning facts or allocating a check attempt and releases damaged snapshots',async()=>{
    const f=await fixture();const createSnapshot=snapshots.createCheckSnapshot;const snapshotRoots:string[]=[];
    vi.spyOn(snapshots,'createCheckSnapshot').mockImplementation(async input=>{const s=await createSnapshot(input);snapshotRoots.push(s.rootDir);return s;});
    const verifyHook=await duringCreation(async session=>{
      await session.captureInstalledData('check.font',[request],resourceContext);
      await writeFile(path.join(snapshotRoots[0]!,'node_modules/@fonts/demo/wght.css'),'drift');
      await expect(session.captureInstalledData('check.font',[request],resourceContext)).rejects.toMatchObject({code:'check_snapshot_drift'});
      expect((await session.plan()).checks['check.font']!.attempts).toHaveLength(0);
      await expect(access(snapshotRoots[0]!)).rejects.toMatchObject({code:'ENOENT'});
      await expect(access(f.commandCount)).rejects.toMatchObject({code:'ENOENT'});
      // Avoid making this a command retry sensor: stop after the proving capture refusal.
      throw new Error('expected fixture stop after resource refusal');
    });
    expect(await runCli(['prepare'],f.runtime)).toBe(1);
    expect(()=>verifyHook()).toThrow('expected fixture stop after resource refusal');
    expect(await readFile(f.setupCount,'utf8')).toBe('setup\n');
  },30000);
});
