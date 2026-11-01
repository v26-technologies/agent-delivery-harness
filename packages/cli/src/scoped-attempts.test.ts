import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AttemptStore } from "./scoped-attempts.ts";
import type { ScopedCheckAttempt } from "@agent-delivery-harness/kernel";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const input = { version: "scoped-attempt/1", providerId: "check.a", inputDigest: "a".repeat(64), profileDigest: "b".repeat(64), origin: { candidate: { treeSha: "a".repeat(40), deliverableDigest: "b".repeat(64), identityToken: "git-tree/v1", baseRef: "origin/main", baseTipSha: "c".repeat(40), mergeBaseSha: "c".repeat(40), workspaceId: "workspace" }, runId: "run" } } as Omit<ScopedCheckAttempt, "attemptId" | "generation" | "status">;
it("allocates concurrent generations before execution, retaining failed and running attempts ahead of old success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scoped-attempt-test-")); dirs.push(root);
  const store = new AttemptStore(root);
  const [a, b] = await Promise.all([store.allocate(input), store.allocate(input)]);
  expect(new Set([a.generation, b.generation])).toEqual(new Set([1, 2]));
  const old = a.generation < b.generation ? a : b, latest = old === a ? b : a;
  await store.finish(old, "passed", { outputs: [] });
  expect((await store.read()).map(a => a.attempt.status)).toEqual(["passed", "running"]);
  await store.finish(latest, "failed", { outputs: [] });
  expect((await store.read()).map(a => a.attempt.status)).toEqual(["passed", "failed"]);
  await expect(store.finish(latest, "passed", { outputs: [] })).rejects.toThrow();
});
it("refuses corrupt attempt storage rather than treating it as no evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scoped-attempt-test-")); dirs.push(root);
  const store = new AttemptStore(root); await store.allocate(input);
  await writeFile(path.join(root, "1", "running.json"), "{}");
  await expect(store.read()).rejects.toThrow();
});
it("rejects a meaningful payload edit even when the attempt shape stays valid", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "scoped-attempt-test-")); dirs.push(root);
  const store = new AttemptStore(root); await store.allocate(input);
  const file = path.join(root, "1/running.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.attempt.inputDigest = "c".repeat(64); await writeFile(file, JSON.stringify(row));
  await expect(store.read()).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
it.each(["version", "providerId", "attemptId", "generation", "inputDigest", "profileDigest", "origin.runId", ...["treeSha", "deliverableDigest", "identityToken", "baseRef", "baseTipSha", "mergeBaseSha", "workspaceId"].map(k => `origin.candidate.${k}`)])("rejects terminal %s drift with a recomputed checksum", async member => {
  const { readFile } = await import("node:fs/promises");
  const { digestCanonical } = await import("@agent-delivery-harness/kernel");
  const root = await mkdtemp(path.join(tmpdir(), "scoped-attempt-test-")); dirs.push(root);
  const store = new AttemptStore(root), attempt = await store.allocate(input);
  await store.finish(attempt, "passed", { outputs: [] });
  const file = path.join(root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  const keys = member.split("."), last = keys.pop()!;
  const target = keys.reduce((obj, key) => obj[key], row.entry.attempt);
  target[last] = member === "generation" ? 2 : "different";
  row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(store.read()).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});

const executionHeadSha = "d".repeat(40);
async function projectionFor(attempt:ScopedCheckAttempt) {
  const { captureInstalledDataResources, createResourceApplicabilityProjection, digestCanonical } = await import("@agent-delivery-harness/kernel");
  const bytes=new TextEncoder().encode('{}');
  const capture=await captureInstalledDataResources([{version:'installed-package-data/1',id:'font',issuer:'font.test.ts',package:'font',manifest:'package.json',files:['font.woff2'],directories:[]}],{setupRecipeDigest:digestCanonical('setup'),dependencyDigest:digestCanonical('deps'),runtimeDigest:digestCanonical('node'),releaseDigest:digestCanonical('release'),policyDigest:digestCanonical('policy')},{
    resolve:async()=>({mode:'require',packageRoot:'node_modules/font',manifestPath:'node_modules/font/package.json',search:[{path:'node_modules/font',kind:'directory'}]}),
    stat:async p=>({kind:p.endsWith('package.json')||p.endsWith('font.woff2')?'file':'directory',physicalPath:p,linkTarget:null}),readFile:async()=>bytes,listDirectory:async()=>[],
  });
  return createResourceApplicabilityProjection({origin:{providerId:attempt.providerId,runId:attempt.origin.runId,attemptId:attempt.attemptId,generation:attempt.generation,inputDigest:attempt.inputDigest,profileDigest:attempt.profileDigest,source:{headSha:executionHeadSha,treeSha:attempt.origin.candidate.treeSha},status:'passed',superseded:false},consumerId:'font-consumer',declarationDigest:digestCanonical('request'),sourceApplicabilityDigest:digestCanonical('source'),capture});
}
async function resourceStore() {
  const root=await mkdtemp(path.join(tmpdir(),'scoped-resource-attempt-'));dirs.push(root);return new AttemptStore(root);
}
it('resource applicability retains allocator HEAD and successful projection while preserving older history',async()=>{
  const store=await resourceStore();const attempt=await store.allocate(input,{executionHeadSha});
  expect((await store.read())[0]?.executionHeadSha).toBe(executionHeadSha);
  const projection=await projectionFor(attempt);await store.finish(attempt,'passed',{outputs:[],resourceApplicability:projection});
  await store.allocate(input);
  const rows=await store.read();expect(rows[0]?.executionHeadSha).toBe(executionHeadSha);expect(rows[0]?.payload?.resourceApplicability).toEqual(projection);expect(rows[1]?.attempt.status).toBe('running');
});
it('resource applicability cannot seed from failed interrupted or legacy missing-HEAD attempts',async()=>{
  for(const status of ['failed','interrupted'] as const){
    const store=await resourceStore();const attempt=await store.allocate(input,{executionHeadSha});
    await expect(store.finish(attempt,status,{outputs:[],resourceApplicability:await projectionFor(attempt)})).rejects.toMatchObject({code:'check_attempt_corrupt'});
    expect((await store.read())[0]?.attempt.status).toBe('running');
  }
  const store=await resourceStore();const legacy=await store.allocate(input);
  await expect(store.finish(legacy,'passed',{outputs:[],resourceApplicability:await projectionFor(legacy)})).rejects.toMatchObject({code:'check_attempt_corrupt'});
  await store.finish(legacy,'passed',{outputs:[]});expect((await store.read())[0]?.payload?.resourceApplicability).toBeUndefined();expect((await store.read())[0]?.executionHeadSha).toBeUndefined();
});
it('resource applicability refuses portable digest and byte tampering on finish and load',async()=>{
  const { digestCanonical }=await import('@agent-delivery-harness/kernel');const { readFile }=await import('node:fs/promises');
  for(const phase of ['finish','load']) {
    const store=await resourceStore();const attempt=await store.allocate(input,{executionHeadSha});const projection=await projectionFor(attempt);
    if(phase==='finish') {
      await expect(store.finish(attempt,'passed',{outputs:[],resourceApplicability:{...projection,digest:'e'.repeat(64)}})).rejects.toMatchObject({code:'check_attempt_corrupt'});
      const substituted={...projection,origin:{...projection.origin,providerId:'other'}};
      const {digest,...body}=substituted;substituted.digest=digestCanonical(body);
      await expect(store.finish(attempt,'passed',{outputs:[],resourceApplicability:substituted})).rejects.toMatchObject({code:'check_attempt_corrupt'});
    } else {
      await store.finish(attempt,'passed',{outputs:[],resourceApplicability:projection});
      const file=store.terminalPath(attempt),row=JSON.parse(await readFile(file,'utf8'));
      const p=row.entry.payload.resourceApplicability;
      p.capture.resources[0].entries.find((e:any)=>e.path.endsWith('font.woff2')).bytesBase64='Yg==';
      const {digest:oldCapture,...captureBody}=p.capture;p.capture.digest=digestCanonical(captureBody);
      const {digest:oldProjection,...projectionBody}=p;p.digest=digestCanonical(projectionBody);
      row.digest=digestCanonical(row.entry);await writeFile(file,JSON.stringify(row));
      await expect(store.read()).rejects.toMatchObject({code:'check_attempt_corrupt'});
    }
  }
});
it.each(['providerId','runId','attemptId','generation','inputDigest','profileDigest','source.treeSha','source.headSha'])('resource applicability rejects native origin %s substitution with refreshed checksums',async member=>{
  const { digestCanonical }=await import('@agent-delivery-harness/kernel');const { readFile }=await import('node:fs/promises');
  const store=await resourceStore();const attempt=await store.allocate(input,{executionHeadSha});await store.finish(attempt,'passed',{outputs:[],resourceApplicability:await projectionFor(attempt)});
  const file=store.terminalPath(attempt),row=JSON.parse(await readFile(file,'utf8')),projection=row.entry.payload.resourceApplicability;
  const keys=member.split('.'),last=keys.pop()!;const target=keys.reduce((v,k)=>v[k],projection.origin);
  target[last]=member==='generation'?2:member.endsWith('Sha')?'e'.repeat(40):member.endsWith('Digest')?'e'.repeat(64):'substitute';
  const {digest,...body}=projection;projection.digest=digestCanonical(body);row.digest=digestCanonical(row.entry);await writeFile(file,JSON.stringify(row));
  await expect(store.read()).rejects.toMatchObject({code:'check_attempt_corrupt'});
});
it('resource applicability rejects running positive facts and terminal HEAD drift independent of projection',async()=>{
  const { digestCanonical }=await import('@agent-delivery-harness/kernel');const { readFile }=await import('node:fs/promises');
  for(const mode of ['running-positive','terminal-head']) {
    const store=await resourceStore();const attempt=await store.allocate(input,{executionHeadSha});
    if(mode==='terminal-head')await store.finish(attempt,'passed',{outputs:[]});
    const file=mode==='terminal-head'?store.terminalPath(attempt):path.join(store.root,String(attempt.generation),'running.json'),row=JSON.parse(await readFile(file,'utf8'));
    if(mode==='terminal-head')row.entry.executionHeadSha='e'.repeat(40);else row.entry.payload={outputs:[],resourceApplicability:await projectionFor(attempt)};
    row.digest=digestCanonical(row.entry);await writeFile(file,JSON.stringify(row));await expect(store.read()).rejects.toMatchObject({code:'check_attempt_corrupt'});
  }
});

it('resource applicability rejects loaded failed interrupted or missing-native-HEAD positives',async()=>{
  const { digestCanonical }=await import('@agent-delivery-harness/kernel');const { readFile }=await import('node:fs/promises');
  for(const status of ['failed','interrupted','missing-head']) {
    const store=await resourceStore();const attempt=await store.allocate(input,status==='missing-head'?{}:{executionHeadSha});
    await store.finish(attempt,'passed',{outputs:[],...(status==='missing-head'?{}:{resourceApplicability:await projectionFor(attempt)})});
    const file=store.terminalPath(attempt),row=JSON.parse(await readFile(file,'utf8'));
    if(status==='missing-head')row.entry.payload.resourceApplicability=await projectionFor(attempt);else row.entry.attempt.status=status;
    row.digest=digestCanonical(row.entry);await writeFile(file,JSON.stringify(row));
    await expect(store.read()).rejects.toMatchObject({code:'check_attempt_corrupt'});
  }
});
