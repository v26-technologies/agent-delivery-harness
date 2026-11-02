import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import * as kernel from "@agent-delivery-harness/kernel";
import type { HarnessConfigInput } from "@agent-delivery-harness/kernel";
import base from "../../../harness.config.ts";
import { runCli, wireRepo, type CliRuntime } from "./index.ts";
import * as snapshots from "./check-snapshot.ts";

const observations=vi.hoisted(()=>({identities:0,sourceFiles:[] as string[],metadataFiles:[] as string[]}));
vi.mock("@agent-delivery-harness/kernel",async importOriginal=>{
  const actual=await importOriginal<typeof import("@agent-delivery-harness/kernel")>();
  return {...actual,scopedCheckIdentity:async(...args:Parameters<typeof actual.scopedCheckIdentity>)=>{observations.identities++;return actual.scopedCheckIdentity(...args);},
    candidateTreeSourceReader:async(...args:Parameters<typeof actual.candidateTreeSourceReader>)=>{
      const read=await actual.candidateTreeSourceReader(...args);
      return new Proxy(read,{apply(target,thisArg,args){observations.sourceFiles.push(String(args[0]));return Reflect.apply(target,thisArg,args);},get(target,key,receiver){if(key==="metadata")return async(file:string)=>{observations.metadataFiles.push(file);return target.metadata(file);};return Reflect.get(target,key,receiver);}});
    }};
});
const exec=promisify(execFile),roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();observations.identities=0;observations.sourceFiles=[];observations.metadataFiles=[];await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),"prepare-identity-"));roots.push(root);
 const git=async(...args:string[])=>(await exec("git",args,{cwd:root})).stdout.trim();
 await git("init","-q");await git("config","user.name","Test");await git("config","user.email","test@example.invalid");
 await writeFile(path.join(root,"harness.config.ts"),"export default {};\n");await writeFile(path.join(root,"source.txt"),"source");await writeFile(path.join(root,"lock.txt"),"locked");await writeFile(path.join(root,"broad-only.txt"),"broad consumer input");
 await git("add",".");await git("-c","commit.gpgsign=false","commit","-qm","base");await git("branch","origin/main");
 const provider={id:"check.consumer",findingCodes:[],check:{command:[process.execPath,"-e","require('fs').writeFileSync('result.json',require('fs').readFileSync('source.txt'))"] as [string,...string[]],timeoutMs:5000,outputs:["result.json"],physicalSource:{version:"physical-source/1" as const,files:["source.txt","lock.txt"],absentInputs:["startup.cjs"]},scope:{version:"scoped-check/1",files:["source.txt","broad-only.txt"],memberships:[],tests:[],cwd:".",profile:"fixture",environment:[]}}};
 const input={...base,preparationWiringPaths:["harness.config.ts"],preparationCommands:[],providers:[provider],obligations:[{...base.obligations[0]!,id:"consumer.passed",activation:{kind:"always"},providers:[provider.id],acceptedPayloadSpecs:["checks.passed/1"],humanWaiverAllowed:false,allowedResolutionKinds:["satisfied_evidence"]}],
 scopedExecution:{version:"scoped-execution/1",mechanicalProviders:[],profiles:[{id:"fixture",gitContext:"none",dependencyInputs:["lock.txt"],mutableOutputs:["result.json"],credentialIdentities:{},dependencies:{command:[process.execPath,"-e","require('fs').mkdirSync('node_modules')"] as [string,...string[]],timeoutMs:5000}}]}};
 let config=kernel.defineHarnessConfig(input as HarnessConfigInput);
 const artifactRoot=path.join(root,".git/artifacts");await mkdir(artifactRoot);
 const stdout:string[]=[],stderr:string[]=[],runtime:CliRuntime={cwd:root,env:{},stdinIsTTY:false,stdoutIsTTY:false,loadConfig:async()=>config,artifacts:kernel.createArtifactsPort({runRootBase:artifactRoot}),stdout:line=>stdout.push(line),stderr:line=>stderr.push(line)};
 return {root,git,runtime,stdout,stderr,get config(){return config;},setConfig(value:HarnessConfigInput){config=kernel.defineHarnessConfig(value);},setUnvalidatedConfig(value:HarnessConfigInput){config=value as typeof config;},run:async(command:string)=>runCli([command],runtime)};
}
it("zero mechanical prepare publishes a valid receipt without broad identity reads or setup",async()=>{
 const f=await fixture(),create=vi.spyOn(snapshots,"createCheckSnapshot");
 expect(await f.run("prepare"),f.stderr.join("\n")).toBe(0);
 expect(observations.identities).toBe(0);expect(observations.sourceFiles).not.toContain("broad-only.txt");expect(observations.metadataFiles).toContain("broad-only.txt");expect(create).not.toHaveBeenCalled();
 const wiring=await wireRepo(f.root,f.config),capture=await wiring.captureCandidate();
 expect(capture.ok).toBe(true);
 if(capture.ok)expect((await kernel.evaluatePreparationReceipt(f.root,{config:f.config,candidate:capture.candidate},wiring.storageOptions)).prepared).toBe(true);
});
it.each(["mutable-source","undeclared-output","present-absence","missing-source","missing-dependency"])("zero mechanical prepare retains structural refusal %s",async kind=>{
 const f=await fixture();
 if(kind==="mutable-source")f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(profile=>({...profile,mutableOutputs:["source.txt","result.json"]}))}});
 if(kind==="undeclared-output")f.setConfig({...f.config,providers:f.config.providers.map(provider=>({...provider,check:{...provider.check!,outputs:["other.json"]}}))});
 if(kind==="present-absence"){await writeFile(path.join(f.root,"startup.cjs"),"present");await f.git("add",".");}
 if(kind==="missing-source"){await f.git("rm","source.txt");}
 if(kind==="missing-dependency"){await f.git("rm","lock.txt");}
 expect(await f.run("prepare")).toBe(1);expect(f.stderr.join("\n")).toMatch(/source|output|input|absence|Physical/i);
 const wiring=await wireRepo(f.root,f.config),captured=await wiring.captureCandidate();
 if(captured.ok)expect((await kernel.evaluatePreparationReceipt(f.root,{config:f.config,candidate:captured.candidate})).prepared).toBe(false);
});
it.each([false,true])("nonempty mechanical execution and failure receipts remain unchanged fails=%s",async fails=>{
 const f=await fixture();
 f.setConfig({...f.config,providers:f.config.providers.map(provider=>({...provider,check:{...provider.check!,command:[process.execPath,"-e",fails?"process.exit(7)":"require('fs').writeFileSync('result.json','passed')"] as [string,...string[]]}})),scopedExecution:{...f.config.scopedExecution!,mechanicalProviders:["check.consumer"]}});
 const create=vi.spyOn(snapshots,"createCheckSnapshot");expect(await f.run("prepare")).toBe(fails?1:0);expect(observations.identities).toBeGreaterThan(0);expect(create).toHaveBeenCalledTimes(1);
 const wiring=await wireRepo(f.root,f.config),capture=await wiring.captureCandidate();if(capture.ok)expect((await kernel.evaluatePreparationReceipt(f.root,{config:f.config,candidate:capture.candidate})).prepared).toBe(!fails);
});
it("gate freshly rejects runtime drift after an identity-free prepare",async()=>{
 const f=await fixture(),control=await mkdtemp(path.join(tmpdir(),"prepare-tool-"));roots.push(control);const tool=path.join(control,"consumer");
 await writeFile(tool,`#!${process.execPath}\nrequire('fs').writeFileSync('result.json','first')\n`);await chmod(tool,0o755);
 f.setConfig({...f.config,providers:f.config.providers.map(provider=>({...provider,check:{...provider.check!,command:[tool] as [string,...string[]]}}))});
 expect(await f.run("prepare")).toBe(0);expect(observations.identities).toBe(0);
 expect(await f.run("gate"),f.stderr.join("\n")).toBe(0);
 await writeFile(tool,`#!${process.execPath}\nprocess.exit(9)\n`);
 expect(await f.run("gate")).toBe(1);expect(observations.identities).toBeGreaterThan(0);
 const history=await (await import("./index.ts")).readScopedCheckObservations({rootDir:f.root,config:f.config});expect(history.providers[0]?.attempts.map(attempt=>attempt.status)).toEqual(["passed","failed"]);
});
it("zero mechanical prepare defers unavailable execution tools until gate",async()=>{
 const f=await fixture();f.setConfig({...f.config,providers:f.config.providers.map(provider=>({...provider,check:{...provider.check!,command:[path.join(f.root,"missing-runtime")] as [string,...string[]]}}))});
 expect(await f.run("prepare"),f.stderr.join("\n")).toBe(0);expect(observations.identities).toBe(0);expect(await f.run("gate")).toBe(1);expect(f.stderr.join("\n")).toMatch(/execution tool|runtime/i);
});
it("zero mechanical prepare retains broad link metadata refusal without broad content hashing",async()=>{
 const f=await fixture();await symlink("../../outside-author-source",path.join(f.root,"broad-link"));await f.git("add","broad-link");
 f.setConfig({...f.config,providers:f.config.providers.map(provider=>({...provider,check:{...provider.check!,scope:{...provider.check!.scope!,files:[...provider.check!.scope!.files,"broad-link"]}}}))});
 expect(await f.run("prepare")).toBe(1);expect(observations.identities).toBe(0);expect(observations.sourceFiles).not.toContain("broad-only.txt");
 const wiring=await wireRepo(f.root,f.config),capture=await wiring.captureCandidate();if(capture.ok)expect((await kernel.evaluatePreparationReceipt(f.root,{config:f.config,candidate:capture.candidate},wiring.storageOptions)).prepared).toBe(false);
});
it("zero mechanical prepare permits directory and absent resolution witnesses",async()=>{
 const f=await fixture();await mkdir(path.join(f.root,"folder"));await writeFile(path.join(f.root,"folder/input.txt"),"input");await f.git("add",".");
 f.setConfig({...f.config,providers:f.config.providers.map(provider=>({...provider,check:{...provider.check!,scope:{...provider.check!.scope!,files:[...provider.check!.scope!.files,"folder","absent-lookup.ts"]}}}))});
 expect(await f.run("prepare"),f.stderr.join("\n")).toBe(0);expect(observations.identities).toBe(0);
});
it("zero mechanical prepare keeps the missing profile backstop",async()=>{
 const f=await fixture();f.setUnvalidatedConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:[]}});
 expect(await f.run("prepare")).toBe(1);expect(f.stderr.join("\n")).toMatch(/execution profile/);
});
it("zero mechanical prepare does not weaken declarative protected absence/output overlap",async()=>{
 const f=await fixture();expect(()=>f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(profile=>({...profile,mutableOutputs:["startup.cjs","result.json"]}))}})).toThrow();
 const wiring=await wireRepo(f.root,f.config),capture=await wiring.captureCandidate();if(capture.ok)expect((await kernel.evaluatePreparationReceipt(f.root,{config:f.config,candidate:capture.candidate},wiring.storageOptions)).prepared).toBe(false);
});
it.each(["linked-source","oversized-source"])("zero mechanical prepare retains real physical validation %s",async kind=>{
 const f=await fixture();
 if(kind==="linked-source"){await rm(path.join(f.root,"source.txt"));await symlink("broad-only.txt",path.join(f.root,"source.txt"));}
 else await writeFile(path.join(f.root,"source.txt"),Buffer.alloc(8*1024*1024+1,65));
 await f.git("add",".");expect(await f.run("prepare")).toBe(1);expect(f.stderr.join("\n")).toMatch(/Physical source/);expect(observations.identities).toBe(0);
 const wiring=await wireRepo(f.root,f.config),capture=await wiring.captureCandidate();if(capture.ok)expect((await kernel.evaluatePreparationReceipt(f.root,{config:f.config,candidate:capture.candidate},wiring.storageOptions)).prepared).toBe(false);
});
it.each([false,true])("preserves committed directory-link dependency inputs with mechanical execution=%s",async mechanical=>{
 const f=await fixture();await mkdir(path.join(f.root,"directory"));await writeFile(path.join(f.root,"directory/input.txt"),"dependency");await symlink("directory",path.join(f.root,"directory-link"));await f.git("add",".");
 f.setConfig({...f.config,providers:f.config.providers.map(provider=>{const {physicalSource,...check}=provider.check!;return {...provider,check:{...check,scope:{...check.scope!,tests:["directory-link"]}}};}),scopedExecution:{...f.config.scopedExecution!,mechanicalProviders:mechanical?["check.consumer"]:[],profiles:f.config.scopedExecution!.profiles.map(profile=>({...profile,gitContext:"full",dependencyInputs:["directory-link"]}))}});
 expect(await f.run("prepare"),f.stderr.join("\n")).toBe(0);expect(observations.identities).toBe(mechanical?1:0);
});
it.each([false,true])("preserves required missing-test refusal with mechanical execution=%s",async mechanical=>{
 const f=await fixture();f.setConfig({...f.config,providers:f.config.providers.map(provider=>{const {physicalSource,...check}=provider.check!;return {...provider,check:{...check,scope:{...check.scope!,tests:["missing.test.ts"]}}};}),scopedExecution:{...f.config.scopedExecution!,mechanicalProviders:mechanical?["check.consumer"]:[],profiles:f.config.scopedExecution!.profiles.map(profile=>({...profile,gitContext:"full"}))}});
 expect(await f.run("prepare")).toBe(1);expect(f.stderr.join("\n")).toContain("Required test is absent");
 const wiring=await wireRepo(f.root,f.config),capture=await wiring.captureCandidate();if(capture.ok)expect((await kernel.evaluatePreparationReceipt(f.root,{config:f.config,candidate:capture.candidate},wiring.storageOptions)).prepared).toBe(false);
});
