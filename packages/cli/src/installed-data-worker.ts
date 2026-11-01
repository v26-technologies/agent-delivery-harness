/** Runs only in a bounded, killable child over one invocation-owned snapshot.
 * The parent validates descriptors first and validates/hashes these facts again.
 * No dependency package code or host preload is executed by observation.
 */
export const installedDataWorker = String.raw`
import { lstat, realpath, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const fail=(code)=>{const e=new Error(code);e.code=code;throw e;};
const input=JSON.parse(process.env.DELIVERY_INSTALLED_DATA_REQUEST);
const root=await realpath(process.cwd());
const entries=Object.create(null), resolutions=Object.create(null);
let rawBytes=0;
const safe=(value)=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!value.startsWith('/')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..');
const absolute=(value)=>{if(!safe(value))fail('installed_data_resource_unsafe');return path.join(root,value);};
async function statOne(relative){
 if(entries[relative])return entries[relative];
 if(Object.keys(entries).length>=input.limits.entries)fail('installed_data_limit_exceeded');
 let s;try{s=await lstat(absolute(relative));}catch(e){if(e.code!=='ENOENT')throw e;return entries[relative]={kind:'absent',physicalPath:relative,linkTarget:null};}
 if(s.isSymbolicLink())fail('installed_data_resource_unsafe');
 const physical=path.relative(root,await realpath(absolute(relative))).split(path.sep).join('/');
 if(physical!==relative)fail('installed_data_resource_unsafe');
 const kind=s.isFile()?'file':s.isDirectory()?'directory':'unsupported';
 if(kind==='unsupported')fail('installed_data_resource_unsafe');
 return entries[relative]={kind,physicalPath:physical,linkTarget:null};
}
async function observe(relative){
 const parts=relative.split('/');
 for(let i=1;i<parts.length;i++){
  const ancestor=await statOne(parts.slice(0,i).join('/'));
  if(ancestor.kind!=='directory'&&ancestor.kind!=='absent')fail('installed_data_resource_unsafe');
 }
 return statOne(relative);
}
async function read(relative){
 const entry=await observe(relative);if(entry.kind!=='file')fail('installed_data_resource_unsafe');
 if(entry.bytesBase64!==undefined)return;
 const handle=await open(absolute(relative),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const s=await handle.stat();if(!s.isFile())fail('installed_data_resource_unsafe');
  if(s.size>input.limits.rawBytes-rawBytes)fail('installed_data_limit_exceeded');
  const bytes=Buffer.alloc(s.size+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
  if(bytesRead!==s.size)fail('installed_data_resource_unsafe');
  rawBytes+=bytesRead;entry.bytesBase64=bytes.subarray(0,bytesRead).toString('base64');
 }finally{await handle.close();}
}
try{
 for(const r of input.requests){
  const issuer=await observe(r.issuer);if(issuer.kind!=='file')fail('installed_data_resource_unsafe');
  const require=createRequire(absolute(r.issuer));
  const paths=require.resolve.paths(r.package+'/package.json');
  const boundary=paths?.indexOf(path.join(root,'node_modules'))??-1;
  if(boundary<0)fail('installed_data_resolution_unsafe');
  const search=[];
  for(const dir of paths.slice(0,boundary+1)){
   const candidate=path.relative(root,path.join(dir,r.package)).split(path.sep).join('/');
   if(!safe(candidate))fail('installed_data_resolution_unsafe');
   const entry=await observe(candidate);search.push({path:candidate,kind:entry.kind});
   if(search.length<=boundary&&entry.kind!=='absent')fail('installed_data_resolution_unsafe');
  }
  const packageRoot='node_modules/'+r.package, manifestPath=packageRoot+'/package.json';
  await read(manifestPath);
  let resolved;try{resolved=require.resolve(r.package+'/package.json');}catch{fail('installed_data_resolution_unsafe');}
  if(resolved!==absolute(manifestPath))fail('installed_data_resolution_unsafe');
  resolutions[r.id]={mode:'require',packageRoot,manifestPath,search};
  for(const f of r.files)await read(packageRoot+'/'+f);
  for(const d of r.directories){
   const directory=packageRoot+'/'+d.path,entry=await observe(directory);
   if(entry.kind!=='directory')fail('installed_data_resource_unsafe');
   const names=await readdir(absolute(directory));if(names.length>input.limits.directoryMembers)fail('installed_data_limit_exceeded');
   entry.members=names.sort();
   for(const name of names)if(name.endsWith(d.suffix))await read(directory+'/'+name);
  }
 }
 const result=JSON.stringify({entries,resolutions});
 if(Buffer.byteLength(result)>input.limits.serializedBytes)fail('installed_data_limit_exceeded');
 process.stdout.write(result);
}catch(e){
 const allowed=['installed_data_descriptor_invalid','installed_data_resolution_unsafe','installed_data_resource_unsafe','installed_data_limit_exceeded'];
 process.stderr.write(allowed.includes(e.code)?e.code:'installed_data_resource_unsafe');process.exitCode=1;
}
`;
