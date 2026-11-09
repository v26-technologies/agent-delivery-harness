import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import adopter from "../../../harness.config.ts";
import { captureGitCandidate, evaluateCandidateActivation, computePreparationFingerprint, withDeliverableIdentity, defineHarnessConfig, collectLiveProviderResults } from "@agent-delivery-harness/kernel";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive:true,force:true}))); });
const provider = `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.kind==='negotiate')console.log(JSON.stringify({kind:'negotiation',outcome:'supported',selectedVersion:'delivery-provider-rails/1',supportedVersions:['delivery-provider-rails/1']}));
 if(m.kind==='request'){fs.appendFileSync('.git/calls',m.requestId+'\\n');fs.writeFileSync('.git/payload',JSON.stringify(m.payload));
 if(fs.existsSync('.git/change'))fs.appendFileSync('source.ts','changed');
 console.log(JSON.stringify({kind:'terminal',version:m.version,requestId:m.requestId,sequence:1,summary:'observed',outcome:fs.existsSync('.git/fail')?'failed':'success'}));}});`;
async function fixture() {
 const dir=await mkdtemp(path.join(tmpdir(),'live-verification-'));dirs.push(dir);
 const git=async(...args:string[])=>(await exec('git',args,{cwd:dir})).stdout.trim();
 await git('init','-q');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
 await writeFile(path.join(dir,'source.ts'),'export const a=1;');await writeFile(path.join(dir,'harness.config.ts'),'export default {};');
 await git('add','.');await git('-c','commit.gpgsign=false','commit','-qm','base');await git('branch','origin/main');
 const config=defineHarnessConfig({...adopter,preparationCommands:[],preparationWiringPaths:['harness.config.ts'],
 providers:[{id:'live.sensor',findingCodes:[],command:[process.execPath,'-e',provider]}],
 obligations:[{...adopter.obligations[0]!,id:'live.current',freshness:'live',providers:['live.sensor'],activation:{kind:'always'},humanWaiverAllowed:false,allowedResolutionKinds:['satisfied_live_fact','not_applicable']}]});
 const capture=await captureGitCandidate({rootDir:dir,config,workspaceId:'test-workspace',computeIdentity:withDeliverableIdentity()});
 if(!capture.ok)throw new Error(JSON.stringify(capture));
 const input={rootDir:dir,config,candidate:capture.candidate,projection:await evaluateCandidateActivation({rootDir:dir,config,candidate:capture.candidate}),evidenceContext:{preparationFingerprint:await computePreparationFingerprint(dir,config),release:null},env:process.env};
 return{dir,git,input};
}
it('runs an actual provider anew for each verification and supplies exact candidate context',async()=>{
 const f=await fixture();const first=await collectLiveProviderResults(f.input);const second=await collectLiveProviderResults(f.input);
 expect(first.blockers).toEqual([]);expect(second.blockers).toEqual([]);
 expect(first.liveResults[0]?.status).toBe('green');expect(first.liveResults[0]?.runId).not.toBe(second.liveResults[0]?.runId);
 expect((await readFile(path.join(f.dir,'.git/calls'),'utf8')).trim().split('\n')).toHaveLength(2);
 expect(JSON.parse(await readFile(path.join(f.dir,'.git/payload'),'utf8')).candidate.treeSha).toBe(f.input.candidate.treeSha);
});
it('does not reuse the previous green observation when the provider now fails',async()=>{
 const f=await fixture();expect((await collectLiveProviderResults(f.input)).liveResults[0]?.status).toBe('green');
 await writeFile(path.join(f.dir,'.git/fail'),'fail');const result=await collectLiveProviderResults(f.input);
 expect(result.liveResults.every(result=>result.status!=='green')).toBe(true);expect(result.blockers.length).toBeGreaterThan(0);
});
it.each(['different head','dirty workspace','changed during provider'])('blocks %s',async(mode)=>{
 const f=await fixture();
 if(mode==='different head')await f.git('-c','commit.gpgsign=false','commit','--allow-empty','-qm','other');
 if(mode==='dirty workspace')await writeFile(path.join(f.dir,'source.ts'),'different');
 if(mode==='changed during provider')await writeFile(path.join(f.dir,'.git/change'),'change');
 const result=await collectLiveProviderResults(f.input);expect(result.liveResults).toEqual([]);expect(result.blockers.length).toBeGreaterThan(0);
});
it('cancellation cannot supply a live result',async()=>{
 const f=await fixture();const abort=new AbortController();abort.abort();
 const result=await collectLiveProviderResults({...f.input,signal:abort.signal});expect(result.liveResults).toEqual([]);expect(result.blockers.length).toBeGreaterThan(0);
});

it('refuses wiring or release that differs from the target evidence inputs',async()=>{
 const f=await fixture();const result=await collectLiveProviderResults({...f.input,evidenceContext:{...f.input.evidenceContext,preparationFingerprint:'0'.repeat(64)}});
 expect(result.liveResults).toEqual([]);expect(result.blockers.map(b=>b.code)).toContain('live_provider_wiring_mismatch');
});
it('does not run inactive live providers or fabricate an absent command result',async()=>{
 const f=await fixture();const inactive=defineHarnessConfig({...f.input.config,obligations:f.input.config.obligations.map(o=>({...o,activation:{kind:'relevant_change' as const}}))});
 expect(await collectLiveProviderResults({...f.input,config:inactive})).toEqual({liveResults:[],blockers:[]});
 const missing=defineHarnessConfig({...f.input.config,providers:[{id:'live.sensor',findingCodes:[]}]});
 const result=await collectLiveProviderResults({...f.input,config:missing,evidenceContext:{release:null,preparationFingerprint:await computePreparationFingerprint(f.dir,missing)}});
 expect(result.liveResults).toEqual([]);
});
it.skipIf(process.platform==='win32')('hands verify\'s live provider exactly its declared, vouched descriptor (V26-3314)',{timeout:60000},async()=>{
 // A parent holding a marker pipe on fd 3, vouched by identity, collects live
 // results through a provider that does not declare fd 3 and one that does.
 const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('./fixtures/live-descriptors-parent.ts',import.meta.url))],{cwd:process.cwd(),stdio:['ignore','pipe','pipe','pipe']});
 let out='',err='';child.stdout!.on('data',c=>{out+=c;});child.stderr!.on('data',c=>{err+=c;});
 (child.stdio[3] as NodeJS.WritableStream).end('marker');
 const code=await new Promise(resolve=>child.once('close',resolve));
 expect({code,err}).toEqual({code:0,err:''});
 const [undeclared,declared]=JSON.parse(out) as {status:string|null;held:string|null;stated:string|null}[];
 expect(undeclared).toEqual({status:'green',held:null,stated:null});
 expect(declared).toMatchObject({status:'green',held:'marker'});
 expect(declared!.stated).toMatch(/^3:\d+:\d+$/);
});
