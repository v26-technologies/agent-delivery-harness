import {describe,expect,it} from 'vitest';
import {digestCanonical,sha256Hex} from './digest.ts';
import {reconstructResourceApplicability} from './installed-data-portable.ts';
import {captureInstalledDataBinding,type InstalledDataSourceTree} from './installed-data-source.ts';
import {captureInstalledDataResources,createResourceApplicabilityProjection} from './installed-data-resources.ts';
import {scopedCheckIdentity} from './scoped-inputs.ts';
import type {CapturedCandidate} from './candidate.types.ts';
import type {HarnessConfig,ProviderRegistration} from './config.ts';
import type {CandidateTreeInputReader} from './portable-inputs.ts';
const hash=(s:string)=>digestCanonical(s),sha=(s:string)=>s.repeat(40);
const baseTree=sha('a'),originalTree=sha('b'),currentTree=sha('c');
function tree(bytes:Map<string,string>,linked=new Set<string>()):InstalledDataSourceTree {
 const read=Object.assign(async(p:string)=>bytes.has(p)?new TextEncoder().encode(bytes.get(p)!):null,{metadata:async(p:string)=>({mode:bytes.has(p)?'100644':null,links:linked.has(p)?[{path:p,target:'other'}]:[]})}) as CandidateTreeInputReader;
 return{inventory:[...bytes.keys()],read};
}
async function fixture(){
 const bytes=new Map([['font.test.ts','test'],['reader.ts','reader'],['asset.bin','data'],['package.json','{}'],['root.ts','old']]);
 const maps=new Map([[baseTree,new Map(bytes)],[originalTree,new Map(bytes)],[currentTree,new Map([...bytes].map(([p,s])=>[p,p==='root.ts'?'unrelated change':s]))]]);
 const links=new Map([...maps.keys()].map(key=>[key,new Set<string>()]));
 const trees=async(key:string)=>{const files=maps.get(key);if(!files)throw Error('unknown immutable tree');return tree(files,links.get(key)!);};
 const release=new Map<string,string>();const readEvidence=async(p:string)=>release.has(p)?new TextEncoder().encode(release.get(p)!):null;
 const source={version:'scoped-check/1' as const,files:['reader.ts','asset.bin'],tests:['font.test.ts'],memberships:[],cwd:'.',profile:'font',environment:[]};
 const request={version:'installed-package-data/1' as const,id:'font',issuer:'font.test.ts',package:'font',manifest:'package.json' as const,files:['font.woff2'],directories:[]};
 const installedData={version:'installed-data-consumer/1' as const,consumerId:'font',requests:[request],source,guards:{'reader.ts':sha256Hex('reader'),'font.test.ts':sha256Hex('test')}};
 const provider={id:'font',findingCodes:[],check:{command:['node','test.js'],timeoutMs:1000,scope:source,outputs:['result.json'],installedData}} as ProviderRegistration;
 const config={deliveryRecordPath:'delivery/record.json',providers:[provider],scopedExecution:{version:'scoped-execution/1',profiles:[{id:'font',gitContext:'full',dependencyInputs:['package.json'],dependencies:{command:['node','setup'],timeoutMs:1000},mutableOutputs:['result.json'],credentialIdentities:{}}],mechanicalProviders:[]},obligations:[{id:'font.passed',providers:['font'],freshness:'exact_candidate',acceptedPayloadSpecs:['checks.passed/1','installed-data.applicable/1']}]} as unknown as HarnessConfig;
 const observation={version:'scoped-runtime/1' as const,runtimeDigest:hash('node'),flags:{},credentials:{}};
 const original={headSha:sha('d'),treeSha:originalTree,deliverable:{digest:hash('old'),identity:'git-tree/v1'},base:{ref:'origin/main',tipSha:baseTree,mergeBaseSha:baseTree},workspaceId:'workspace'} as unknown as CapturedCandidate;
 const candidate={...original,headSha:sha('e'),treeSha:currentTree,deliverable:{...original.deliverable,digest:hash('current')}};
 const originalSource=await trees(originalTree);
 const identity=await scopedCheckIdentity(config,provider,originalSource.inventory,originalSource.read,observation,original,readEvidence);
 const native=await captureInstalledDataBinding(config,provider,original,observation,{base:await trees(baseTree),candidate:originalSource},readEvidence);
 const capture=await captureInstalledDataResources([request],native.context,{resolve:async()=>({mode:'require',packageRoot:'node_modules/font',manifestPath:'node_modules/font/package.json',search:[{path:'node_modules/font',kind:'directory'}]}),stat:async p=>({kind:p.endsWith('package.json')||p.endsWith('woff2')?'file':'directory',physicalPath:p,linkTarget:null}),readFile:async()=>new Uint8Array([0,255,1]),listDirectory:async()=>[]});
 const origin={providerId:provider.id,runId:'run-1',attemptId:'attempt-1',generation:1,inputDigest:identity.inputDigest,profileDigest:identity.profileDigest,source:{headSha:original.headSha,treeSha:originalTree},status:'passed' as const,superseded:false};
 const projection=createResourceApplicabilityProjection({origin,consumerId:installedData.consumerId,declarationDigest:native.declarationDigest,sourceApplicabilityDigest:native.sourceApplicabilityDigest,capture});
 const proof={version:'installed-data-proof/1',observation,origin:{executionHeadSha:original.headSha,attempt:{version:'scoped-attempt/1',providerId:provider.id,attemptId:origin.attemptId,generation:origin.generation,inputDigest:origin.inputDigest,profileDigest:origin.profileDigest,status:'passed',origin:{runId:origin.runId,candidate:{treeSha:originalTree,deliverableDigest:original.deliverable.digest,identityToken:original.deliverable.identity,baseRef:original.base.ref,baseTipSha:original.base.tipSha,mergeBaseSha:original.base.mergeBaseSha,workspaceId:original.workspaceId}}},payload:{resourceApplicability:projection,outputs:[{path:'result.json',base64:Buffer.from('passed').toString('base64'),sha256:sha256Hex('passed')}],diagnostic:{availability:'available',phase:'complete',command:{exitCode:0},failure:{unavailable:'not-failed'}}}}};
 return{maps,links,trees,release,readEvidence,provider,config,observation,original,candidate,identity,proof,reconstruct:()=>reconstructResourceApplicability(config,provider,candidate,proof,trees,readEvidence)};
}
describe('portable installed resource reconstruction',()=>{
 it('reconstructs current applicability after unrelated commit while original full-Git attempt identity is stale',async()=>{
  const f=await fixture();const current=await f.trees(currentTree);const identity=await scopedCheckIdentity(f.config,f.provider,current.inventory,current.read,f.observation,f.candidate,f.readEvidence);
  expect(identity.inputDigest).not.toBe(f.identity.inputDigest);expect(identity.profileDigest).not.toBe(f.identity.profileDigest);
  const value=await f.reconstruct();expect(value.binding.version).toBe('installed-data-binding/1');expect(value.binding.originDigest).toBe(digestCanonical(f.proof.origin.payload.resourceApplicability.origin));expect(value.binding.captureDigest).toBe(f.proof.origin.payload.resourceApplicability.capture.digest);expect(value).not.toHaveProperty('checks');
 });
 it.each(['head','tree','input','profile','run','generation','attempt','version','missing-projection','extra-proof'])('refuses malformed or substituted origin %s',async mode=>{
  const f=await fixture();const row=f.proof.origin;
  if(mode==='head')row.executionHeadSha=sha('f');if(mode==='tree')row.attempt.origin.candidate.treeSha=sha('f');if(mode==='input')row.attempt.inputDigest=hash('other');if(mode==='profile')row.attempt.profileDigest=hash('other');if(mode==='run')row.attempt.origin.runId='other';if(mode==='generation')row.attempt.generation=2;if(mode==='attempt')row.attempt.attemptId='other';if(mode==='version')row.attempt.version='unknown';if(mode==='missing-projection')delete(row.payload as {resourceApplicability?:unknown}).resourceApplicability;if(mode==='extra-proof')Object.assign(f.proof,{extra:true});
  await expect(f.reconstruct()).rejects.toThrow();
 });
 it.each(['failed','running','interrupted','exit','phase','failure','outputs'])('refuses nonpassed diagnostics and altered output bytes: %s',async mode=>{
  const f=await fixture();if(['failed','running','interrupted'].includes(mode))f.proof.origin.attempt.status=mode;
  if(mode==='exit')f.proof.origin.payload.diagnostic.command.exitCode=1;if(mode==='phase')f.proof.origin.payload.diagnostic.phase='command';if(mode==='failure')f.proof.origin.payload.diagnostic.failure.unavailable='failed';if(mode==='outputs')f.proof.origin.payload.outputs[0]!.base64=Buffer.from('altered').toString('base64');
  await expect(f.reconstruct()).rejects.toThrow();
 });
 it.each(['data','guard','base-guard','link','base','dependency','runtime','release','policy','declaration','request','capture-context'])('refuses changed current authority: %s',async mode=>{
  const f=await fixture();const check=f.provider.check!,declaration=check.installedData!;
  if(mode==='data')f.maps.get(currentTree)!.set('asset.bin','changed');if(mode==='guard')f.maps.get(currentTree)!.set('reader.ts','changed');if(mode==='base-guard')f.maps.get(baseTree)!.set('reader.ts','changed');if(mode==='link')f.links.get(currentTree)!.add('asset.bin');if(mode==='base')f.candidate.base={...f.candidate.base,tipSha:sha('f')};if(mode==='dependency')f.maps.get(currentTree)!.set('package.json','changed');if(mode==='runtime')f.observation.runtimeDigest=hash('changed');
  if(mode==='release')f.release.set('.agent-skills/active.json',JSON.stringify({release:{releaseId:'other',profile:'linear',archiveSha256:hash('archive'),metadataSha256:hash('metadata')}}));
  if(mode==='policy')Object.assign(f.config,{obligations:[{...f.config.obligations[0],freshness:'live'}]});if(mode==='declaration')Object.assign(declaration,{consumerId:'other'});if(mode==='request')Object.assign(declaration,{requests:[{...declaration.requests[0],files:['other.woff2']}]});
  if(mode==='capture-context'){
   const p=f.proof.origin.payload.resourceApplicability;Object.assign(p.capture.context,{runtimeDigest:hash('other')});const {digest:old,...body}=p.capture;Object.assign(p.capture,{digest:digestCanonical(body)});const{digest:previous,...projection}=p;Object.assign(p,{digest:digestCanonical(projection)});
  }
  await expect(f.reconstruct()).rejects.toThrow();
 });
 it('refuses an original executable guard mismatch even with self-consistent recomputed origin identity',async()=>{
  const f=await fixture();f.maps.get(originalTree)!.set('reader.ts','unguarded original executable');const original=await f.trees(originalTree);
  const changed=await scopedCheckIdentity(f.config,f.provider,original.inventory,original.read,f.observation,f.original,f.readEvidence);
  f.proof.origin.attempt.inputDigest=changed.inputDigest;f.proof.origin.attempt.profileDigest=changed.profileDigest;
  const p=f.proof.origin.payload.resourceApplicability;Object.assign(p.origin,{inputDigest:changed.inputDigest,profileDigest:changed.profileDigest});const{digest,...body}=p;Object.assign(p,{digest:digestCanonical(body)});
  await expect(f.reconstruct()).rejects.toThrow();
 });
});
