import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestCanonical } from "@agent-delivery-harness/kernel";
import { captureOwnedInstalledDataResources } from "./installed-data-resources.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
const context = { setupRecipeDigest:digestCanonical("setup"), dependencyDigest:digestCanonical("deps"), runtimeDigest:digestCanonical("node"), releaseDigest:digestCanonical("release"), policyDigest:digestCanonical("policy") };
const request = {version:"installed-package-data/1" as const,id:"font",issuer:"packages/app/font.test.ts",package:"@fonts/demo",manifest:"package.json" as const,files:["wght.css"],directories:[{path:"files",suffix:"-normal.woff2"}]};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(),"installed-data-observer-")); roots.push(root);
  const pkg = path.join(root,"node_modules/@fonts/demo");
  await mkdir(path.join(pkg,"files"),{recursive:true}); await mkdir(path.join(root,"packages/app"),{recursive:true});
  await writeFile(path.join(root,request.issuer),"export {};\n");
  await writeFile(path.join(pkg,"package.json"),JSON.stringify({name:request.package,exports:{"./package.json":"./package.json"}}));
  await writeFile(path.join(pkg,"wght.css"),"unicode-range: U+20AD-20C0;");
  await writeFile(path.join(pkg,"files/a-normal.woff2"),new Uint8Array([0,255,1,128]));
  await writeFile(path.join(pkg,"files/a-italic.woff2"),"unselected");
  let verifications = 0;
  const snapshot = {rootDir:root, verify:async()=>{verifications++;}};
  return {root,pkg,snapshot,count:()=>verifications};
}
describe("owned installed-data observation",()=>{
  it("captures public package resolution, complete directory names and exact binary bytes between verification fences",async()=>{
    const f=await fixture(); const value=await captureOwnedInstalledDataResources(f.snapshot,[request],context);
    expect(f.count()).toBe(2);
    expect(value.resources[0].resolution.search.map((row:any)=>row.path)).toEqual(["packages/app/node_modules/@fonts/demo","packages/node_modules/@fonts/demo","node_modules/@fonts/demo"]);
    const entries=value.resources[0].entries;
    expect(entries.find((row:any)=>row.path.endsWith("/files")).members).toEqual(["a-italic.woff2","a-normal.woff2"]);
    expect(entries.find((row:any)=>row.path.endsWith("a-normal.woff2")).bytesBase64).toBe("AP8BgA==");
    expect(entries.some((row:any)=>row.path.endsWith("a-italic.woff2"))).toBe(false);
    expect(JSON.stringify(value)).not.toContain(f.root);
  });
  it("changes the resource digest for actual byte and matching directory membership changes",async()=>{
    const f=await fixture();const first=await captureOwnedInstalledDataResources(f.snapshot,[request],context);
    await writeFile(path.join(f.pkg,"wght.css"),"changed");const bytes=await captureOwnedInstalledDataResources(f.snapshot,[request],context);
    expect(bytes.digest).not.toBe(first.digest);
    await writeFile(path.join(f.pkg,"files/b-normal.woff2"),"added");const names=await captureOwnedInstalledDataResources(f.snapshot,[request],context);
    expect(names.digest).not.toBe(bytes.digest);
    expect(names.resources[0].entries.find((row:any)=>row.path.endsWith("/files")).members).toContain("b-normal.woff2");
  });
  it("refuses closer packages, unexported manifests and resource links without observing an author installation",async()=>{
    for(const mode of ["closer","exports","link"]){
      const f=await fixture();
      if(mode==="closer"){
        const shadow=path.join(f.root,"packages/app/node_modules/@fonts/demo");await mkdir(shadow,{recursive:true});await writeFile(path.join(shadow,"package.json"),JSON.stringify({name:request.package,exports:{"./package.json":"./package.json"}}));
      }else if(mode==="exports")await writeFile(path.join(f.pkg,"package.json"),JSON.stringify({name:request.package,exports:{".":"./index.js"}}));
      else {await rm(path.join(f.pkg,"wght.css"));await symlink(path.join(f.pkg,"files/a-normal.woff2"),path.join(f.pkg,"wght.css"));}
      await expect(captureOwnedInstalledDataResources(f.snapshot,[request],context)).rejects.toMatchObject({name:"InstalledDataResourceError"});
    }
  });
  it("starts no observation after cancellation or with an unbounded deadline",async()=>{
    const f=await fixture(), controller=new AbortController();controller.abort();
    await expect(captureOwnedInstalledDataResources(f.snapshot,[request],context,{signal:controller.signal})).rejects.toMatchObject({code:"installed_data_resource_unsafe"});
    for(const timeoutMs of [0,-1,NaN,Infinity,60_001])await expect(captureOwnedInstalledDataResources(f.snapshot,[request],context,{timeoutMs})).rejects.toMatchObject({code:"installed_data_descriptor_invalid"});
    expect(f.count()).toBe(0);
  });
  it("refuses malformed requests before launching observation and does not bypass a failed native verification fence",async()=>{
    const f=await fixture();await expect(captureOwnedInstalledDataResources(f.snapshot,[{...request,files:["../outside"]}],context)).rejects.toMatchObject({code:"installed_data_descriptor_invalid"});expect(f.count()).toBe(0);
    let calls=0;const damaged={rootDir:f.root,verify:async()=>{if(++calls===2)throw new Error("native snapshot drift");}};
    await expect(captureOwnedInstalledDataResources(damaged,[request],context)).rejects.toThrow("native snapshot drift");expect(calls).toBe(2);
    expect(await readFile(path.join(f.pkg,"wght.css"),"utf8")).toContain("unicode-range");
  });
});
