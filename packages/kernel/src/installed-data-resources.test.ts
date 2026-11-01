import { describe, expect, it } from "vitest";
import { normalizeInstalledDataResourceRequests, captureInstalledDataResources, createResourceApplicabilityProjection, matchResourceApplicabilityProjection, validateInstalledDataResourceCapture, type InstalledDataResourcePorts, type InstalledDataResourceRequest } from "./installed-data-resources.ts";
import { digestCanonical } from "./digest.ts";
const hash = (s: string) => digestCanonical(s);
const context = { setupRecipeDigest:hash('setup'), dependencyDigest:hash('deps'), runtimeDigest:hash('node'), releaseDigest:hash('release'), policyDigest:hash('policy') };
const root = 'node_modules/@fonts/demo';
const request: InstalledDataResourceRequest = {version:'installed-package-data/1',id:'font',issuer:'packages/app/font.test.ts',package:'@fonts/demo',manifest:'package.json',files:['wght.css'],directories:[{path:'files',suffix:'-normal.woff2'}]};
function fixture() {
  const files = new Map<string,Uint8Array>(Object.entries({[root+'/package.json']:JSON.stringify({name:'@fonts/demo',exports:{'./package.json':'./package.json'}}),[root+'/wght.css']:'css',[root+'/files/a-normal.woff2']:'font',[root+'/files/a-italic.woff2']:'italic'}).map(([p,s])=>[p,new TextEncoder().encode(s)]));
  const dirs = new Set(['node_modules','node_modules/@fonts',root,root+'/files','packages','packages/app']);
  const kinds = new Map<string,string>();
  const ports: InstalledDataResourcePorts = {
    resolve:async()=>({mode:'require',packageRoot:root,manifestPath:root+'/package.json',search:['packages/app/node_modules/@fonts/demo','packages/node_modules/@fonts/demo',root].map(path=>({path,kind:path===root?'directory':'absent'}))}),
    stat:async(path)=>({kind:(kinds.get(path)??(files.has(path)?'file':dirs.has(path)?'directory':'absent')) as 'file',physicalPath:path,linkTarget:null}),
    readFile:async(path)=>{const value=files.get(path);if(!value)throw Error('missing');return value;},
    listDirectory:async(path)=>[...files.keys()].filter(p=>p.startsWith(path+'/')&&!p.slice(path.length+1).includes('/')).map(p=>p.slice(path.length+1)).reverse(),
  };
  return {files,dirs,kinds,ports};
}
const origin = {providerId:'unit',runId:'run-1',attemptId:'attempt-1',generation:1,inputDigest:hash('input'),profileDigest:hash('profile'),source:{headSha:'a'.repeat(40),treeSha:'b'.repeat(40)},status:'passed' as const,superseded:false};
async function captured() {return captureInstalledDataResources([request],context,fixture().ports);}
describe('installed package data kernel',()=>{
  it('captures exact bytes, complete sorted membership and ordered resolution absences',async()=>{
    const f=fixture();const value=await captureInstalledDataResources([request],context,f.ports);
    expect(validateInstalledDataResourceCapture(value)).toEqual(value);
    const entries=value.resources[0]!.entries;
    expect(entries.find(e=>e.path===root+'/files')?.members).toEqual(['a-italic.woff2','a-normal.woff2']);
    expect(entries.find(e=>e.path===root+'/files/a-normal.woff2')?.bytesBase64).toBe(Buffer.from('font').toString('base64'));
    expect(entries.some(e=>e.path.endsWith('a-italic.woff2'))).toBe(false);
    expect(value).toEqual(await captureInstalledDataResources([request],context,f.ports));
  });
  it('normalizes declarations before native child observation',()=>{
    expect(normalizeInstalledDataResourceRequests([request])).toEqual([request]);
    expect(()=>normalizeInstalledDataResourceRequests([{...request,files:['../outside']}])).toThrow();
  });
  it('refuses malformed declarations before touching ports',async()=>{
    for(const patch of [{issuer:'../test.ts'},{issuer:'node_modules/test.ts'},{package:'demo/escape'},{files:['../secret']},{directories:[{path:'files',suffix:'*.woff2'}]}]) {
      await expect(captureInstalledDataResources([{...request,...patch}],context,{...fixture().ports,resolve:async()=>{throw Error('port called');}})).rejects.toMatchObject({code:'installed_data_descriptor_invalid'});
    }
    await expect(captureInstalledDataResources([request,request],context,fixture().ports)).rejects.toMatchObject({code:'installed_data_descriptor_invalid'});
  });
  it('refuses closer installs, incomplete search, missing resources, links and unsafe physical paths',async()=>{
    for(const mode of ['closer','search','missing','link','escape','kind']) {
      const f=fixture(); if(mode==='missing')f.files.delete(root+'/wght.css');
      if(mode==='link')f.kinds.set(root+'/files','symlink');
      if(mode==='kind')f.kinds.set(root+'/wght.css','unsupported');
      const resolve=f.ports.resolve; const stat=f.ports.stat;
      const ports={...f.ports,resolve:async(r:InstalledDataResourceRequest)=>{const v=await resolve(r);return mode==='search'?{...v,search:v.search.slice(1)}:mode==='closer'?{...v,packageRoot:'packages/app/node_modules/@fonts/demo'}:v;},stat:async(p:string)=>({...await stat(p),...(mode==='escape'&&p===root+'/wght.css'?{physicalPath:'../outside'}:{})})};
      await expect(captureInstalledDataResources([request],context,ports)).rejects.toMatchObject({name:'InstalledDataResourceError'});
    }
  });
  it('portable validation refuses byte tamper and dropped files or directory members even with refreshed outer digest',async()=>{
    const c=await captured();
    for(const mutate of [(v:any)=>v.resources[0].entries.find((e:any)=>e.path===root+'/wght.css').bytesBase64='Yg==',(v:any)=>v.resources[0].entries.splice(v.resources[0].entries.findIndex((e:any)=>e.path===root+'/wght.css'),1),(v:any)=>v.resources[0].entries.find((e:any)=>e.path===root+'/files').members.push('new-normal.woff2')]) {
      const v=structuredClone(c);mutate(v);const {digest,...body}=v;v.digest=digestCanonical(body);expect(()=>validateInstalledDataResourceCapture(v)).toThrow();
    }
  });
  it('refuses bounded count/bytes rather than truncating',async()=>{
    const f=fixture();f.files.set(root+'/wght.css',new Uint8Array(1024*1024+1));
    await expect(captureInstalledDataResources([request],context,f.ports)).rejects.toMatchObject({code:'installed_data_limit_exceeded'});
  });
  it('binds manifest, CSS, font and directory add/delete/rename changes',async()=>{
    const capture=await captured();
    const p=createResourceApplicabilityProjection({origin,consumerId:'font-test',declarationDigest:hash('decl'),sourceApplicabilityDigest:hash('source'),capture});
    for(const change of ['manifest','css','font','add','delete','rename']) {
      const f=fixture();
      const names:Record<string,string>={manifest:root+'/package.json',css:root+'/wght.css',font:root+'/files/a-normal.woff2'};
      if(names[change]) f.files.set(names[change]!,new TextEncoder().encode('changed'));
      if(change==='add')f.files.set(root+'/files/new-normal.woff2',new Uint8Array([1]));
      if(change==='delete'||change==='rename')f.files.delete(root+'/files/a-normal.woff2');
      if(change==='rename')f.files.set(root+'/files/renamed-normal.woff2',new Uint8Array([1]));
      const current=await captureInstalledDataResources([request],context,f.ports);
      expect(current.digest).not.toBe(capture.digest);
      expect(matchResourceApplicabilityProjection(p,{consumerId:p.consumerId,declarationDigest:p.declarationDigest,sourceApplicabilityDigest:p.sourceApplicabilityDigest,capture:current,originAttempt:origin}).applicable).toBe(false);
    }
  });
  it('refuses nearer package presence, ancestor links, missing manifests and failed native resolution',async()=>{
    for(const path of ['packages/app/node_modules/@fonts/demo','node_modules','node_modules/@fonts',root+'/package.json']) {
      const f=fixture();
      if(path.endsWith('package.json'))f.files.delete(path); else f.kinds.set(path,path==='packages/app/node_modules/@fonts/demo'?'directory':'symlink');
      await expect(captureInstalledDataResources([request],context,f.ports)).rejects.toMatchObject({name:'InstalledDataResourceError'});
    }
    await expect(captureInstalledDataResources([request],context,{...fixture().ports,resolve:async()=>{throw Error('ERR_PACKAGE_PATH_NOT_EXPORTED');}})).rejects.toMatchObject({code:'installed_data_capture_invalid'});
  });
  it('rejects overlarge directory and serialized captures without truncation',async()=>{
    const f=fixture();
    await expect(captureInstalledDataResources([request],context,{...f.ports,listDirectory:async()=>Array.from({length:1025},(_,i)=>'entry'+i)})).rejects.toMatchObject({code:'installed_data_limit_exceeded'});
    const big={...request,directories:['one','two','three'].map(path=>({path,suffix:'.woff2'}))};
    for(const d of big.directories)f.dirs.add(root+'/'+d.path);
    await expect(captureInstalledDataResources([big],context,{...f.ports,listDirectory:async()=>Array.from({length:1024},(_,i)=>String(i).padStart(4,'0')+'a'.repeat(796))})).rejects.toMatchObject({code:'installed_data_limit_exceeded'});
  });
  it('rejects extra fields, malformed portable bytes and malformed projection without granting applicability',async()=>{
    const capture=await captured();
    for(const modify of [(v:any)=>v.ambient='author path',(v:any)=>v.context.runtimeDigest='BAD',(v:any)=>v.resources[0].entries[0].kind='symlink']) {
      const v=structuredClone(capture);modify(v);expect(()=>validateInstalledDataResourceCapture(v)).toThrow();
    }
    const p=createResourceApplicabilityProjection({origin,consumerId:'font-test',declarationDigest:hash('decl'),sourceApplicabilityDigest:hash('source'),capture});
    const c={consumerId:p.consumerId,declarationDigest:p.declarationDigest,sourceApplicabilityDigest:p.sourceApplicabilityDigest,capture,originAttempt:origin};
    expect(matchResourceApplicabilityProjection({...p,digest:hash('tamper')},c).applicable).toBe(false);
    expect(matchResourceApplicabilityProjection({...p,checks:{passed:true}},c).applicable).toBe(false);
  });
  it('matches resource applicability independently of original full-Git identity and requires native origin confirmation',async()=>{
    const capture=await captured();const p=createResourceApplicabilityProjection({origin,consumerId:'font-test',declarationDigest:hash('decl'),sourceApplicabilityDigest:hash('source'),capture});
    const current={consumerId:p.consumerId,declarationDigest:p.declarationDigest,sourceApplicabilityDigest:p.sourceApplicabilityDigest,capture,originAttempt:origin};
    expect(matchResourceApplicabilityProjection(p,current)).toEqual({applicable:true,reasons:[]});
    expect(p.origin.source).toEqual(origin.source);
    expect(p).not.toHaveProperty('checks');
    for(const patch of [{consumerId:'other'},{sourceApplicabilityDigest:hash('changed')},{declarationDigest:hash('decl2')},{originAttempt:null},{originAttempt:{...origin,status:'failed' as const}},{originAttempt:{...origin,superseded:true}},{originAttempt:{...origin,generation:2}}])expect(matchResourceApplicabilityProjection(p,{...current,...patch}).applicable).toBe(false);
    for(const key of Object.keys(context)) {
      const other=await captureInstalledDataResources([request],{...context,[key]:hash('changed')},fixture().ports);
      expect(matchResourceApplicabilityProjection(p,{...current,capture:other}).applicable).toBe(false);
    }
    for(const status of ['failed','cancelled','interrupted'] as const)expect(()=>createResourceApplicabilityProjection({origin:{...origin,status},consumerId:'font-test',declarationDigest:hash('decl'),sourceApplicabilityDigest:hash('source'),capture})).toThrow();
  });
});
