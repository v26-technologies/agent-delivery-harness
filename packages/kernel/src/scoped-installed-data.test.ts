import { expect,it } from 'vitest';
import { scopedCheckIdentity } from './scoped-inputs.ts';
import { captureScopedCheckInputs } from './checks.ts';
import { digestCanonical } from './digest.ts';
import type { HarnessConfig,ProviderRegistration } from './config.ts';
import type { CandidateTreeInputReader } from './portable-inputs.ts';
const scope={version:'scoped-check/1' as const,files:['reader.ts'],tests:['font.test.ts'],memberships:[],cwd:'.',profile:'fixture',environment:[]};
const declaration={version:'installed-data-consumer/1' as const,consumerId:'font',requests:[{version:'installed-package-data/1' as const,id:'font',issuer:'font.test.ts',package:'font',manifest:'package.json' as const,files:['font.woff2'],directories:[]}],source:scope,guards:{'reader.ts':'a'.repeat(64),'font.test.ts':'b'.repeat(64)}};
const profile={id:'fixture',gitContext:'full' as const,dependencyInputs:[],mutableOutputs:[],credentialIdentities:{}};
const observation={version:'scoped-runtime/1' as const,runtimeDigest:'a'.repeat(64),flags:{},credentials:{}};
const candidate={headSha:'a'.repeat(40),treeSha:'b'.repeat(40),base:{ref:'origin/main',tipSha:'c'.repeat(40),mergeBaseSha:'c'.repeat(40)},deliverable:{digest:'d'.repeat(64),identity:'git-tree/v1'}};
const reader=Object.assign(async(p:string)=>['reader.ts','font.test.ts'].includes(p)?new TextEncoder().encode('source'):null,{metadata:async()=>({mode:'100644',links:[]})}) as CandidateTreeInputReader;
function identity(installedData?:typeof declaration,change:Partial<typeof candidate>={}) {
  const provider={id:'font',findingCodes:[],check:{command:['node','test.js'],timeoutMs:5000,scope,...(installedData?{installedData}:{})}} as ProviderRegistration;
  const config={deliveryRecordPath:'delivery/record.json',scopedExecution:{version:'scoped-execution/1',profiles:[profile],mechanicalProviders:[]},obligations:[]} as unknown as HarnessConfig;
  return scopedCheckIdentity(config,provider,['reader.ts','font.test.ts'],reader,observation,{...candidate,...change});
}
it('installed consumer identity binds declaration and guards while full-Git HEAD tree base still invalidate',async()=>{
  const a=await identity(declaration);for(const d of [{...declaration,consumerId:'other'},{...declaration,guards:{...declaration.guards,'reader.ts':'e'.repeat(64)}},{...declaration,requests:[{...declaration.requests[0]!,files:['other.woff2']}]}]){
    const b=await identity(d);expect(b.inputDigest).not.toBe(a.inputDigest);expect(b.profileDigest).not.toBe(a.profileDigest);
  }
  for(const change of [{headSha:'e'.repeat(40)},{treeSha:'e'.repeat(40)},{base:{...candidate.base,tipSha:'e'.repeat(40)}}]){const b=await identity(declaration,change);expect(b.inputDigest).not.toBe(a.inputDigest);expect(b.profileDigest).not.toBe(a.profileDigest);}
});
it('installed consumer field-absent identity retains the original byte formula',async()=>{
  const actual=await identity();const runtimeDigest=digestCanonical({runtime:observation.runtimeDigest,base:candidate.base,headSha:candidate.headSha,treeSha:candidate.treeSha});const dependencyDigest=digestCanonical({inputs:[],setup:null}),releaseDigest=digestCanonical(null),policyDigest=digestCanonical([]);
  const expected=await captureScopedCheckInputs(scope,{listFiles:async()=>['reader.ts','font.test.ts'],readFile:reader,readMetadata:reader.metadata,command:['node','test.js'],timeoutMs:5000,runtimeDigest,dependencyDigest,releaseDigest,policyDigest,environment:{},credentialIdentity:()=>null});
  expect(actual).toEqual({...expected,profileDigest:digestCanonical({profile,runtimeDigest,dependencyDigest,releaseDigest,policyDigest})});
});
