import { describe, expect, it } from "vitest";
import { digestCanonical, sha256Hex, type CandidateTreeInputReader, type HarnessConfig, type ProviderRegistration } from "@agent-delivery-harness/kernel";
import { captureInstalledDataBinding } from "./scoped-installed-data.ts";
const issuer="packages/app/font.test.ts", data="packages/app/cedi.woff2";
function fixture(){
 const files={[issuer]:"guarded reader",[data]:"DATA","package.json":"manifest","bun.lock":"lock"};
 const make=(values:Record<string,string>)=>{
  const read=Object.assign(async(file:string)=>Object.hasOwn(values,file)?new TextEncoder().encode(values[file]):null,{metadata:async(file:string)=>({mode:Object.hasOwn(values,file)?"100644":null,links:[]})}) as CandidateTreeInputReader;
  return {inventory:Object.keys(values),read};
 };
 const scope={version:"scoped-check/1" as const,files:[issuer,data],tests:[issuer],memberships:[],cwd:".",profile:"full",environment:[]};
 const declaration={version:"installed-data-consumer/1" as const,consumerId:"font",requests:[{version:"installed-package-data/1" as const,id:"font",issuer,package:"@fonts/demo",manifest:"package.json" as const,files:["wght.css"],directories:[]}],source:scope,guards:{[issuer]:sha256Hex(files[issuer])}};
 const provider={id:"check.font",findingCodes:[],check:{command:["node","font-runner"],timeoutMs:1000,scope,installedData:declaration}} as ProviderRegistration;
 const config={providers:[provider],obligations:[],scopedExecution:{version:"scoped-execution/1",mechanicalProviders:[],profiles:[{id:"full",gitContext:"full",dependencyInputs:["package.json","bun.lock"],mutableOutputs:[],credentialIdentities:{},dependencies:{command:["node","setup"],timeoutMs:1000}}]}} as unknown as HarnessConfig;
 const candidate={base:{ref:"origin/main",tipSha:"a".repeat(40),mergeBaseSha:"a".repeat(40)}};
 const observation={version:"scoped-runtime/1" as const,runtimeDigest:digestCanonical("node"),flags:{},credentials:{}};
 const capture=(base=files,current=files,owner=provider,cfg=config)=>captureInstalledDataBinding(cfg,owner,candidate,observation,{base:make(base),candidate:make(current)},async()=>null);
 return {files,make,scope,declaration,provider,config,candidate,observation,capture};
}
describe("native installed data source binding",()=>{
 it("binds both source snapshots and DATA separately from guarded executable code",async()=>{
  const f=fixture(),baseline=await f.capture();
  const changed=await f.capture(f.files,{...f.files,[data]:"changed DATA"});
  expect(changed.sourceApplicabilityDigest).not.toBe(baseline.sourceApplicabilityDigest);
  expect(changed.declarationDigest).toBe(baseline.declarationDigest);
  expect(changed.context).toEqual(baseline.context);
  expect(await f.capture({...f.files,[data]:"changed base DATA"},f.files)).not.toMatchObject({sourceApplicabilityDigest:baseline.sourceApplicabilityDigest});
 });
 it("refuses stale/missing executable guards on either snapshot before resource setup",async()=>{
  const f=fixture();for(const side of ["base","candidate"]){
   const changed={...f.files,[issuer]:"new unqualified IO"};
   await expect(f.capture(side==="base"?changed:f.files,side==="candidate"?changed:f.files)).rejects.toMatchObject({code:"installed_data_source_unqualified"});
  }
 });
 it("binds actual dependency bytes, recipe, base and runtime without importing a host installation",async()=>{
  const f=fixture(),a=await f.capture(),deps=await f.capture(f.files,{...f.files,"bun.lock":"new dependency"});
  expect(deps.context.dependencyDigest).not.toBe(a.context.dependencyDigest);
  const moved=await captureInstalledDataBinding(f.config,f.provider,{base:{...f.candidate.base,tipSha:"b".repeat(40)}},f.observation,{base:f.make(f.files),candidate:f.make(f.files)},async()=>null);
  expect(moved.sourceApplicabilityDigest).not.toBe(a.sourceApplicabilityDigest);
  const runtime=await captureInstalledDataBinding(f.config,f.provider,f.candidate,{...f.observation,runtimeDigest:digestCanonical("other node")},{base:f.make(f.files),candidate:f.make(f.files)},async()=>null);
  expect(runtime.context.runtimeDigest).not.toBe(a.context.runtimeDigest);
 });
});
