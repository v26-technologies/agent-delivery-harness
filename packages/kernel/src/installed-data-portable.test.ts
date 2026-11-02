import {describe,expect,it} from 'vitest';
import {digestCanonical,sha256Hex} from './digest.ts';
import {reconstructResourceApplicability} from './installed-data-portable.ts';
import {captureInstalledDataBinding,type InstalledDataSourceTree} from './installed-data-source.ts';
import {captureInstalledDataResources,createResourceApplicabilityProjection,type InstalledDataResourceRequest} from './installed-data-resources.ts';
import {scopedCheckIdentity} from './scoped-inputs.ts';
import {capturePhysicalSource} from './physical-source.ts';
import {selectScopedCheckAttempt} from './evaluator.ts';
import type {CapturedCandidate} from './candidate.types.ts';
import {deliveryRecordPathFor,type HarnessConfig,type ProviderRegistration} from './config.ts';
import type {CandidateTreeInputReader} from './portable-inputs.ts';
const hash=(s:string)=>digestCanonical(s),sha=(s:string)=>s.repeat(40);
const baseTree=sha('a'),originalTree=sha('b'),currentTree=sha('c');
it.each(['content','mode','path'])('finite repair physical-only term fences retained attempt and resource context: %s',async term=>{
 const f=await fixture(undefined,true);
 for(const files of f.maps.values()){files.set('z-extra.bin','same bytes');files.set('z-other.bin','same bytes');}
 const resourceProvider={...f.provider,check:{...f.provider.check!,physicalSource:{...f.provider.check!.physicalSource!,files:[...f.provider.check!.physicalSource!.files,'z-extra.bin']}}};
 const {installedData:_removed,...check}=resourceProvider.check,provider={...resourceProvider,check};
 const config={...f.config,providers:[provider]},resourceConfig={...f.config,providers:[resourceProvider]},current=await f.trees(currentTree),base=await f.trees(baseTree);
 const before=await scopedCheckIdentity(config,provider,current.inventory,current.read,f.observation,f.candidate,f.readEvidence);
 const nativeBefore=await captureInstalledDataBinding(resourceConfig,resourceProvider,f.candidate,f.observation,{base,candidate:current},f.readEvidence);
 let afterProvider=provider,afterResource=resourceProvider,read=current.read;
 if(term==='content')f.maps.get(currentTree)!.set('z-extra.bin','different bytes');
 if(term==='mode')read=Object.assign(async(p:string)=>current.read(p),{metadata:async(p:string)=>({...await current.read.metadata(p),...(p==='z-extra.bin'?{mode:'100755'}:{})})});
 if(term==='path'){
  const physicalSource={...check.physicalSource!,files:check.physicalSource!.files.map(p=>p==='z-extra.bin'?'z-other.bin':p)};
  afterProvider={...provider,check:{...check,physicalSource}};afterResource={...resourceProvider,check:{...resourceProvider.check,physicalSource}};
 }
 const after=await scopedCheckIdentity({...config,providers:[afterProvider]},afterProvider,current.inventory,read,f.observation,f.candidate,f.readEvidence);
 const retained={...f.proof.origin.attempt,version:'scoped-attempt/1' as const,status:'passed' as const,inputDigest:before.inputDigest,profileDigest:before.profileDigest};
 expect(before.reusable).toBe(true);expect(after.reusable).toBe(true);
 expect(selectScopedCheckAttempt(provider.id,before.inputDigest,before.profileDigest,[retained])?.attemptId).toBe(retained.attemptId);
 expect(selectScopedCheckAttempt(provider.id,after.inputDigest,after.profileDigest,[retained])).toBeUndefined();
 const nativeAfter=await captureInstalledDataBinding({...resourceConfig,providers:[afterResource]},afterResource,f.candidate,f.observation,{base,candidate:{...current,read}},f.readEvidence);
 expect(nativeAfter.context.setupRecipeDigest).not.toBe(nativeBefore.context.setupRecipeDigest);
});
it('finite repair no-resource Git-none identity retains candidate-independent reuse',async()=>{
 const f=await fixture(undefined,true),{installedData:_removed,...check}=f.provider.check!,provider={...f.provider,check},config={...f.config,providers:[provider]},current=await f.trees(currentTree);
 const before=await scopedCheckIdentity(config,provider,current.inventory,current.read,f.observation,f.candidate,f.readEvidence);
 const after=await scopedCheckIdentity(config,provider,current.inventory,current.read,f.observation,{...f.candidate,headSha:sha('f'),treeSha:sha('e')},f.readEvidence);
 expect(after.inputDigest).toBe(before.inputDigest);expect(after.profileDigest).toBe(before.profileDigest);
});
it.each(['per-file','aggregate'])('finite repair kernel accepts exact byte limit and refuses one byte over: %s',async kind=>{
 const size=8*1024*1024,data=new Uint8Array(size),files=Array.from({length:kind==='per-file'?1:8},(_,i)=>`file-${i}.bin`);
 const read=Object.assign(async(_p:string)=>data,{metadata:async(_p:string)=>({mode:'100644',links:[]})});
 const source={version:'physical-source/1' as const,files,absentInputs:[]};
 const exact=await capturePhysicalSource(source,read);expect(exact.files.reduce((sum,file)=>sum+file.bytes.length,0)).toBe(kind==='per-file'?size:8*size);
 const overRead=Object.assign(async(p:string)=>kind==='per-file'?new Uint8Array(size+1):p==='one-extra-byte.bin'?new Uint8Array(1):data,{metadata:read.metadata});
 let rejected=false;try{await capturePhysicalSource({...source,files:kind==='per-file'?files:[...files,'one-extra-byte.bin']},overRead);}catch(error){rejected=error instanceof Error&&/byte bounds/.test(error.message);}
 expect(rejected).toBe(true);
});
function tree(bytes:Map<string,string>,linked=new Set<string>()):InstalledDataSourceTree {
 const read=Object.assign(async(p:string)=>bytes.has(p)?new TextEncoder().encode(bytes.get(p)!):null,{metadata:async(p:string)=>({mode:bytes.has(p)?'100644':null,links:linked.has(p)?[{path:p,target:'other'}]:[]})}) as CandidateTreeInputReader;
 return{inventory:[...bytes.keys()],read};
}
describe('finite physical source portable identity',()=>{
 it('reconstructs an unrelated candidate with unchanged physical authority',async()=>{
  const f=await fixture(undefined,true);
  await expect(f.reconstruct()).resolves.toHaveProperty('binding');
  const current=await f.trees(currentTree);
  const identity=await scopedCheckIdentity(f.config,f.provider,current.inventory,current.read,f.observation,f.candidate,f.readEvidence);
  expect(identity.inputDigest).not.toBe(f.identity.inputDigest);
 });
 it.each(['envelope','absence','present-absence','physical-link','physical-bytes'])('refuses changed finite authority: %s',async mode=>{
  const f=await fixture(undefined,true),physical=f.provider.check!.physicalSource!;
  if(mode==='present-absence')f.maps.get(currentTree)!.set('startup.cjs','injected');
  if(mode==='physical-link')f.links.get(currentTree)!.add('package.json');
  if(mode==='physical-bytes')f.maps.get(currentTree)!.set('package.json','changed manifest');
  if(mode==='envelope'||mode==='absence'){
   const changed={...f.provider,check:{...f.provider.check!,physicalSource:{...physical,...(mode==='envelope'?{files:[...physical.files,'root.ts']}:{absentInputs:[...physical.absentInputs,'other.cjs']})}}};
   const config={...f.config,providers:[changed]};
   await expect(reconstructResourceApplicability(config,changed,f.candidate,f.proof,f.trees,f.readEvidence)).rejects.toThrow();
  }else await expect(f.reconstruct()).rejects.toThrow();
 });
});
async function fixture(order?:'request-ids'|'files'|'directories'|'combined',finite=false){
 const bytes=new Map([['font.test.ts','test'],['reader.ts','reader'],['asset.bin','data'],['package.json','{}'],['root.ts','old']]);
 const maps=new Map([[baseTree,new Map(bytes)],[originalTree,new Map(bytes)],[currentTree,new Map([...bytes].map(([p,s])=>[p,p==='root.ts'?'unrelated change':s]))]]);
 const links=new Map([...maps.keys()].map(key=>[key,new Set<string>()]));
 const trees=async(key:string)=>{const files=maps.get(key);if(!files)throw Error('unknown immutable tree');return tree(files,links.get(key)!);};
 const release=new Map<string,string>();const readEvidence=async(p:string)=>release.has(p)?new TextEncoder().encode(release.get(p)!):null;
 const source={version:'scoped-check/1' as const,files:['reader.ts','asset.bin'],tests:['font.test.ts'],memberships:[],cwd:'.',profile:'font',environment:[]};
 const request:InstalledDataResourceRequest={version:'installed-package-data/1',id:'font',issuer:'font.test.ts',package:'font',manifest:'package.json',files:order==='files'||order==='combined'?['z.woff2','a.woff2']:['font.woff2'],directories:order==='directories'||order==='combined'?[{path:'z-fonts',suffix:'-normal.woff2'},{path:'a-fonts',suffix:'-normal.woff2'}]:[]};
 const requests=order==='request-ids'||order==='combined'?[{...request,id:'z-font'},{...request,id:'a-font'}]:[request];
 const installedData={version:'installed-data-consumer/1' as const,consumerId:'font',requests,source,guards:{'reader.ts':sha256Hex('reader'),'font.test.ts':sha256Hex('test')}};
 const provider={id:'font',findingCodes:[],check:{command:['node','test.js'],timeoutMs:1000,scope:source,outputs:['result.json'],installedData,...(finite?{physicalSource:{version:'physical-source/1',files:['font.test.ts','reader.ts','asset.bin','package.json'],absentInputs:['startup.cjs']}}:{})}} as ProviderRegistration;
 const config={deliveryRecordPath:'delivery/record.json',providers:[provider],scopedExecution:{version:'scoped-execution/1',profiles:[{id:'font',gitContext:finite?'none':'full',dependencyInputs:['package.json'],dependencies:{command:['node','setup'],timeoutMs:1000},mutableOutputs:['result.json'],credentialIdentities:{}}],mechanicalProviders:[]},obligations:[{id:'font.passed',providers:['font'],freshness:'exact_candidate',acceptedPayloadSpecs:['checks.passed/1','installed-data.applicable/1']}]} as unknown as HarnessConfig;
 const observation={version:'scoped-runtime/1' as const,runtimeDigest:hash('node'),flags:{},credentials:{}};
 const original={headSha:sha('d'),treeSha:originalTree,deliverable:{digest:hash('old'),identity:'git-tree/v1'},base:{ref:'origin/main',tipSha:baseTree,mergeBaseSha:baseTree},workspaceId:'workspace'} as unknown as CapturedCandidate;
 const candidate={...original,headSha:sha('e'),treeSha:currentTree,deliverable:{...original.deliverable,digest:hash('current')}};
 const originalSource=await trees(originalTree);
 const identity=await scopedCheckIdentity(config,provider,originalSource.inventory,originalSource.read,observation,original,readEvidence);
 const native=await captureInstalledDataBinding(config,provider,original,observation,{base:await trees(baseTree),candidate:originalSource},readEvidence);
 const capture=await captureInstalledDataResources(requests,native.context,{resolve:async()=>({mode:'require',packageRoot:'node_modules/font',manifestPath:'node_modules/font/package.json',search:[{path:'node_modules/font',kind:'directory'}]}),stat:async p=>({kind:p.endsWith('package.json')||p.endsWith('woff2')?'file':'directory',physicalPath:p,linkTarget:null}),readFile:async()=>new Uint8Array([0,255,1]),listDirectory:async()=>['z-normal.woff2','a-normal.woff2']});
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
 it.each(['request-ids','files','directories','combined'] as const)('reconstructs supported unsorted declaration %s without changing raw declaration identity',async order=>{
  const f=await fixture(order);const raw=f.provider.check!.installedData!.requests;
  expect(f.proof.origin.payload.resourceApplicability.declarationDigest).toBe(digestCanonical(f.provider.check!.installedData));
  expect(digestCanonical(raw)).not.toBe(digestCanonical(f.proof.origin.payload.resourceApplicability.capture.requests));
  const value=await f.reconstruct();expect(value.binding.declarationDigest).toBe(digestCanonical(f.provider.check!.installedData));
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

describe('retained origin scope for growing ordinary plans',()=>{
 async function growing(){
  const f=await fixture(undefined,true),proof=Object.assign(f.proof,{origin:{...f.proof.origin,payload:{...f.proof.origin.payload,resourceScope:structuredClone(f.provider.check!.scope!)}}});
  const provider={...f.provider,check:{...f.provider.check!,scope:{...f.provider.check!.scope!,files:[...f.provider.check!.scope!.files,'root.ts','new-absent.ts']}}},config={...f.config,providers:[provider]};
  return {...f,proof,provider,config,reconstruct:()=>reconstructResourceApplicability(config,provider,f.candidate,proof,f.trees,f.readEvidence)};
 }
 it('reconstructs the authenticated old scope while checking the complete current consumer',async()=>{
  const f=await growing();await expect(f.reconstruct()).resolves.toHaveProperty('binding');
  const current=await f.trees(currentTree),identity=await scopedCheckIdentity(f.config,f.provider,current.inventory,current.read,f.observation,f.candidate,f.readEvidence);
  expect(identity.inputDigest).not.toBe(f.identity.inputDigest);
 });
 it('omits only the exact configured record output from current resource definition identity',async()=>{
  const f=await growing(),baseline=await f.reconstruct(),scope=f.provider.check!.scope!;
  Object.assign(scope,{files:[...scope.files,deliveryRecordPathFor(f.config,f.candidate.deliverable.digest)]});
  expect((await f.reconstruct()).binding.definitionDigest).toBe(baseline.binding.definitionDigest);
  Object.assign(scope,{files:[...scope.files,'delivery/forged.json']});
  expect((await f.reconstruct()).binding.definitionDigest).not.toBe(baseline.binding.definitionDigest);
 });
 it.each(['missing-frame','files','absences','tests','memberships','extra-key','unsafe-path','forged-neutral','oversized','old-bytes'])('refuses altered historical authority: %s',async mode=>{
  const f=await growing(),payload=f.proof.origin.payload,scope=payload.resourceScope;
  if(mode==='missing-frame')delete (payload as {resourceScope?:unknown}).resourceScope;
  if(mode==='files')Object.assign(scope,{files:scope.files.filter(file=>file!=='asset.bin')});
  if(mode==='absences')Object.assign(scope,{files:[...scope.files,'invented-absence.ts']});
  if(mode==='tests')Object.assign(scope,{tests:[]});
  if(mode==='memberships')Object.assign(scope,{memberships:['unrelated/']});
  if(mode==='extra-key')Object.assign(scope,{extra:true});
  if(mode==='unsafe-path')Object.assign(scope,{files:['../escape']});
  if(mode==='forged-neutral')Object.assign(scope,{files:[...scope.files,'delivery/forged.json']});
  if(mode==='oversized')Object.assign(scope,{files:['x'.repeat(2*1024*1024+1)]});
  if(mode==='old-bytes')f.maps.get(originalTree)!.set('asset.bin','altered historical bytes');
  await expect(f.reconstruct()).rejects.toThrow();
 });
 it.each(['command','profile','cwd','environment','policy','source','resource'])('retained scope never substitutes changed current authority: %s',async mode=>{
  const f=await growing(),check=f.provider.check!,scope=check.scope!;
  if(mode==='command')Object.assign(check,{command:['node','different-consumer.js']});
  if(mode==='profile')Object.assign(f.config.scopedExecution!.profiles[0]!,{dependencies:{command:['node','different-setup'],timeoutMs:1000}});
  if(mode==='cwd')Object.assign(scope,{cwd:'other'});
  if(mode==='environment')Object.assign(scope,{environment:[{name:'NEW_FLAG',kind:'flag'}]});
  if(mode==='policy')Object.assign(f.config,{obligations:[{...f.config.obligations[0],freshness:'live'}]});
  if(mode==='source')f.maps.get(currentTree)!.set('asset.bin','changed current DATA');
  if(mode==='resource')Object.assign(f.proof.origin.payload.resourceApplicability.capture.context,{runtimeDigest:hash('tampered resource capture')});
  await expect(f.reconstruct()).rejects.toThrow();
 });
});
