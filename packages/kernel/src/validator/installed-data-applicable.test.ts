import {validateManifest,type ManifestValidationContext} from './envelope.ts';
import {describe,expect,it} from 'vitest';
import {createCollector} from './grammar.ts';
import {validateInstalledDataApplicable} from './installed-data-applicable.ts';
import {createResourceApplicabilityBinding,isResourceApplicabilityBinding} from '../installed-data-evidence.ts';
import {captureInstalledDataResources,createResourceApplicabilityProjection} from '../installed-data-resources.ts';
import {digestCanonical,sha256Hex} from '../digest.ts';
const hash=(s:string)=>digestCanonical(s);
const source={version:'scoped-check/1' as const,files:[],tests:['font.test.ts'],memberships:[],cwd:'.',profile:'font',environment:[]};
const request={version:'installed-package-data/1' as const,id:'font',issuer:'font.test.ts',package:'font',manifest:'package.json' as const,files:['font.woff2'],directories:[]};
const installedData={version:'installed-data-consumer/1' as const,consumerId:'font',requests:[request],source,guards:{'font.test.ts':hash('reader')}};
function fixture(){
 const provider={id:'font',runId:'run-1',finalPassId:'pass-1'};
 const binding={version:'installed-data-binding/1' as const,candidateDigest:hash('candidate'),definitionDigest:hash('definition'),declarationDigest:hash('declaration'),sourceApplicabilityDigest:hash('source'),captureDigest:hash('capture'),originDigest:hash('origin')};
 const payload={verdict:'applicable',binding};const text=JSON.stringify({providerId:provider.id,runId:provider.runId,finalPassId:provider.finalPassId,...payload});
 const context={config:{providers:[{id:provider.id,findingCodes:[],check:{command:['node'] as [string],timeoutMs:1000,scope:source,installedData}}]},prepared:true,currentCandidate:{},resourceBindings:{font:binding},artifactContents:new Map([['resource-result.json',text]])};
 const artifacts=[{path:'resource-result.json',role:'resource-result',sha256:sha256Hex(text),index:0}];return{provider,payload,context,artifacts};
}
describe('installed-data.applicable/1',()=>{
 it('accepts only a named opted-in consumer with independently expected native binding and exact result artifact',()=>{const f=fixture(),c=createCollector();validateInstalledDataApplicable(f.payload,'/payload',f.provider,f.artifacts,f.context,c);expect(c.list()).toEqual([]);});
 it.each(['missing-expected','stale','no-opt-in','bad-version','extra-field','wrong-verdict','missing-artifact','wrong-role','wrong-run','artifact-extra','artifact-binding'])('refuses %s',mode=>{
  const f=fixture(),c=createCollector();let payload:Record<string,unknown>=f.payload;
  if(mode==='missing-expected')f.context.resourceBindings={} as typeof f.context.resourceBindings;
  if(mode==='stale')payload={...payload,binding:{...f.payload.binding,sourceApplicabilityDigest:hash('other')}};
  if(mode==='no-opt-in')delete (f.context.config.providers[0]!.check as {installedData?:unknown}).installedData;
  if(mode==='bad-version')payload={...payload,binding:{...f.payload.binding,version:'unknown'}};
  if(mode==='extra-field')payload={...payload,exitCode:0};
  if(mode==='wrong-verdict')payload={...payload,verdict:'green'};
  if(mode==='missing-artifact')f.context.artifactContents.clear();
  if(mode==='wrong-role')f.artifacts[0]!.role='check-result';
  if(mode==='wrong-run')f.provider.runId='other';
  if(mode==='artifact-extra')f.context.artifactContents.set('resource-result.json',JSON.stringify({providerId:f.provider.id,runId:f.provider.runId,finalPassId:f.provider.finalPassId,...payload,extra:true}));
  if(mode==='artifact-binding')f.context.artifactContents.set('resource-result.json',JSON.stringify({providerId:f.provider.id,runId:f.provider.runId,finalPassId:f.provider.finalPassId,...payload,binding:{...f.payload.binding,originDigest:hash('other')}}));
  validateInstalledDataApplicable(payload,'/payload',f.provider,f.artifacts,f.context,c);expect(c.list().length).toBeGreaterThan(0);
 });
 it('dispatches the explicit applicability payload through the envelope and refuses absent native context',()=>{
  const f=fixture();
  const candidate={vcs:'git',treeSha:'a'.repeat(40),headSha:'b'.repeat(40),deliverable:{digest:'c'.repeat(64),identity:'git-tree/v1'},base:{ref:'origin/main',tipSha:'d'.repeat(40),mergeBaseSha:'d'.repeat(40)},workspaceId:'workspace'};
  const manifest={spec:'delivery-evidence/1',provider:f.provider,candidate,runHistory:[{preparedTreeSha:candidate.treeSha,evaluatedInPassId:f.provider.finalPassId}],artifacts:f.artifacts.map(({index,...artifact})=>artifact),attestation:{level:'self',signatures:[]},recordedAt:'2026-11-01T00:00:00Z',claims:[{obligation:'font.passed',payloadSpec:'installed-data.applicable/1',payload:f.payload}]};
  const context={...f.context,currentCandidate:candidate,config:{...f.context.config,acceptedEnvelopeSpecs:['delivery-evidence/1'],identityVersions:['git-tree/v1'],obligations:[{id:'font.passed',providers:['font'],acceptedPayloadSpecs:['checks.passed/1','installed-data.applicable/1']}]}} as unknown as ManifestValidationContext;
  const valid=validateManifest(manifest,context);expect(valid,JSON.stringify(valid)).toMatchObject({ok:true});
  expect(validateManifest(manifest,{...context,resourceBindings:{}}).ok).toBe(false);
 });
 it('constructs a resource-only binding only with native-confirmed passed origin and matching current capture',async()=>{
  const context={setupRecipeDigest:hash('setup'),dependencyDigest:hash('deps'),runtimeDigest:hash('node'),releaseDigest:hash('release'),policyDigest:hash('policy')};
  const capture=await captureInstalledDataResources([request],context,{resolve:async()=>({mode:'require',packageRoot:'node_modules/font',manifestPath:'node_modules/font/package.json',search:[{path:'node_modules/font',kind:'directory'}]}),stat:async p=>({kind:p.endsWith('package.json')||p.endsWith('woff2')?'file':'directory',physicalPath:p,linkTarget:null}),readFile:async()=>new Uint8Array([1]),listDirectory:async()=>[]});
  const origin={providerId:'font',runId:'run-1',attemptId:'attempt-1',generation:1,inputDigest:hash('input'),profileDigest:hash('profile'),source:{headSha:'a'.repeat(40),treeSha:'b'.repeat(40)},status:'passed' as const,superseded:false};
  const projection=createResourceApplicabilityProjection({origin,consumerId:'font',declarationDigest:hash('declaration'),sourceApplicabilityDigest:hash('source'),capture});
  const input={candidateDigest:hash('candidate'),definitionDigest:hash('definition'),declarationDigest:projection.declarationDigest,sourceApplicabilityDigest:projection.sourceApplicabilityDigest,capture,projection,originAttempt:origin};
  const binding=createResourceApplicabilityBinding(input);expect(isResourceApplicabilityBinding(binding)).toBe(true);expect(binding.originDigest).toBe(digestCanonical(origin));expect(binding.captureDigest).toBe(capture.digest);expect(binding).not.toHaveProperty('checks');
  for(const patch of [{candidateDigest:'BAD'},{sourceApplicabilityDigest:hash('changed')},{originAttempt:{...origin,status:'failed' as const}},{originAttempt:{...origin,superseded:true}},{capture:{...capture,digest:hash('changed')}}])expect(()=>createResourceApplicabilityBinding({...input,...patch})).toThrow();
 });
});
