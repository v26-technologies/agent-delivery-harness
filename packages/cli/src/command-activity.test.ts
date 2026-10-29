import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { emitCommand } from "./commands/emit.ts";
import { resolveRunSurface } from "./run-surface.ts";
import { projectRunProgress } from "./run-projection.ts";
import { beginCommandObservation, observeCandidateCaptures, type CommandObservation } from "./command-activity.ts";
const captureCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@agent-delivery-harness/kernel", async importOriginal => {
  const actual = await importOriginal<typeof import("@agent-delivery-harness/kernel")>();
  return { ...actual, createCandidateCapture: (options: Parameters<typeof actual.createCandidateCapture>[0]) => {
    const capture = actual.createCandidateCapture(options);
    return async () => { captureCalls.count++; return capture(); };
  } };
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
async function setup(version = 2) {
 const root = await mkdtemp(path.join(tmpdir(),"command-activity-")); roots.push(root);
 execFileSync("git",["init","-q",root]);
 const start = await emitCommand.run({rootDir:root,args:["run.started","--version",String(version),...(version===2?["--event-id","start"]:[]),"--json",JSON.stringify({host:"codex",workflow:{releaseId:"test",profile:"core"}})],env:{},readStdin:async()=>"",write:()=>{}});
 expect(start.kind).toBe("ok");
 const resolved=await resolveRunSurface(root);if(!resolved.ok)throw Error(resolved.reason);
 const {store,worktreeKey}=resolved.surface;const current=await store.current(worktreeKey);if(!current.ok||!current.runId)throw Error("missing run");
 const runId=current.runId;
 return {root,store,runId,read:async()=>{const r=await store.read(runId);if(!r.ok)throw Error("read");return r.events;}};
}
it.each([0,1,2,130])("correlates actual outcome %i with its started attempt",async(code)=>{
 const s=await setup();const observation=await beginCommandObservation(s.root,"gate");
 await observation.start("a".repeat(40));
 expect((await s.read()).at(-1)?.payload["state"]).toBe("running");
 await observation.finish(code,12);
 const events=await s.read();const activities=events.filter(e=>e.kind==="activity.observed");
 expect(activities.map(e=>e.payload["state"])).toEqual(["running",code===0?"completed":code===130?"interrupted":"failed"]);
 expect(activities[0]?.payload["attemptId"]).toBe(activities[1]?.payload["attemptId"]);
 expect(activities.every(e=>e.actor.role==="cli"&&e.candidateTreeSha==="a".repeat(40))).toBe(true);
 expect(events.at(-1)?.payload["durationMs"]).toBe(12);
});
it("keeps overlapping invocations separate and missing completion stale",async()=>{
 const s=await setup();const a=await beginCommandObservation(s.root,"gate");const b=await beginCommandObservation(s.root,"gate");
 await a.start("a".repeat(40));await b.start("a".repeat(40));await b.finish(0,1);
 const p=projectRunProgress(await s.read(),"2099-01-01T00:00:00Z");
 expect(p.activities).toHaveLength(2);
 expect(p.activities[0]?.attempts[0]).toMatchObject({state:"running",freshness:"stale"});
 expect(p.activities[1]?.attempts[0]?.state).toBe("completed");
});
it("keeps legacy journals completion-only and ignores a broken store",async()=>{
 const s=await setup(1);const o=await beginCommandObservation(s.root,"check");await o.start("a".repeat(40));await o.finish(1,1);
 expect((await s.read()).map(e=>[e.version,e.kind])).toEqual([["run-event/1","run.started"],["run-event/1","command.completed"]]);
 const broken=await beginCommandObservation(s.root,"gate");await rm(s.store.runsDir,{recursive:true,force:true});
 await expect(broken.start("a".repeat(40))).resolves.toBeUndefined();await expect(broken.finish(130,1)).resolves.toBeUndefined();
});

import config from "../../../harness.config.ts";
import { CliInterruption, runCliBoundary, wireRepo, type CommandDescriptor } from "./boundary.ts";
import type { CaptureCandidate, GateDecision } from "@agent-delivery-harness/kernel";

it.each(["success","failure","interrupt"])("observes the executing CLI boundary: %s",async(mode)=>{
 const s=await setup();
 execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-qm","fixture"],{cwd:s.root});
 const descriptor:CommandDescriptor={name:"check",sourceId:"test.command",summary:"fixture",usage:"Usage: delivery-harness fixture",run:async()=>{
   const events=await s.read();expect(events.at(-1)?.payload["state"]).toBe("running");
   if(mode==="interrupt")throw new CliInterruption();
   if(mode==="failure")throw Error("controlled failure");
   return {kind:"ok"};
 }};
 const code=await runCliBoundary(["check","private argument"],[descriptor],{cwd:s.root,env:{SECRET:"private environment"},stdinIsTTY:false,stdoutIsTTY:false,stdout:()=>{},stderr:()=>{},loadConfig:async()=>({...config,baseRef:"HEAD"})});
 expect(code).toBe(mode==="success"?0:mode==="interrupt"?130:1);
 const events=await s.read();
 expect(events.filter(e=>e.kind==="activity.observed").map(e=>e.payload["state"])).toEqual(["running",mode==="success"?"completed":mode==="interrupt"?"interrupted":"failed"]);
 expect(JSON.stringify(events)).not.toContain("private argument");expect(JSON.stringify(events)).not.toContain("private environment");
});
it("observes only an actual native prompt, preserving its scoped result and errors",async()=>{
 const s=await setup();const observation=await beginCommandObservation(s.root,"gate");await observation.start("a".repeat(40));
 const decision={candidate:{treeSha:"a".repeat(40)}} as GateDecision;
 const prompt=observation.prompt(async()=>{
   const p=projectRunProgress(await s.read(),new Date().toISOString());
   expect(p.waits[0]).toMatchObject({current:true,waitingOn:"human"});
   return false;
 });
 await expect(prompt(decision,[])).resolves.toBe(false);
 await observation.finish(1,4);
 const events=await s.read();expect(events.filter(e=>e.kind==="wait.resolved")).toHaveLength(1);
 expect(projectRunProgress(events,new Date().toISOString()).waits[0]?.current).toBe(false);
});
it("keeps the invocation on its original run when the current pointer changes",async()=>{
 const s=await setup();const observation=await beginCommandObservation(s.root,"check");await observation.start("a".repeat(40));
 const resolved=await resolveRunSurface(s.root);if(!resolved.ok)throw Error(resolved.reason);
 await s.store.clearCurrent(resolved.surface.worktreeKey,s.runId);
 await observation.finish(0,4);
 expect((await s.read()).at(-1)?.kind).toBe("command.completed");
});
it("does not change a boundary failure when its run journal disappears",async()=>{
 const s=await setup();execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-qm","fixture"],{cwd:s.root});
 const descriptor:CommandDescriptor={name:"check",sourceId:"test.command",summary:"fixture",usage:"Usage: delivery-harness fixture",run:async()=>{
   await rm(s.store.runsDir,{recursive:true,force:true});throw new CliInterruption();
 }};
 await expect(runCliBoundary(["check"],[descriptor],{cwd:s.root,env:{},stdinIsTTY:false,stdoutIsTTY:false,stdout:()=>{},stderr:()=>{},loadConfig:async()=>({...config,baseRef:"HEAD"})})).resolves.toBe(130);
});
it("preserves native prompt interruption without a reusable permission grant",async()=>{
 const s=await setup();const o=await beginCommandObservation(s.root,"gate");await o.start("a".repeat(40));
 const error=new CliInterruption();
 await expect(o.prompt(async()=>{throw error;})({candidate:{treeSha:"a".repeat(40)}} as GateDecision,[])).rejects.toBe(error);
 await o.finish(130,3);const events=await s.read();
 expect(events.filter(e=>e.kind==="wait.resolved")[0]?.payload["resolution"]).toBe("Native prompt ended without a decision.");
 expect(events.filter(e=>e.kind==="activity.observed").at(-1)?.payload["state"]).toBe("interrupted");
});

it("connects a native CLI prompt to its observed wait without changing the answer",async()=>{
 const s=await setup();
 execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-qm","fixture"],{cwd:s.root});
 const decision={candidate:{treeSha:"a".repeat(40)}} as GateDecision;
 let nativeCalls=0;
 const descriptor:CommandDescriptor={name:"gate",sourceId:"test.command",summary:"fixture",usage:"Usage: delivery-harness fixture",run:async(context)=>{
   expect(context.promptForWaiver).toBeDefined();
   expect(await context.promptForWaiver!(decision,[])).toBe(false);
   return {kind:"ok"};
 }};
 const code=await runCliBoundary(["gate"],[descriptor],{cwd:s.root,env:{},stdinIsTTY:true,stdoutIsTTY:true,stdout:()=>{},stderr:()=>{},loadConfig:async()=>({...config,baseRef:"HEAD"}),promptForWaiver:async(actualDecision,obligations)=>{
   nativeCalls++;
   expect(actualDecision).toBe(decision);expect(obligations).toEqual([]);
   const current=projectRunProgress(await s.read(),new Date().toISOString());
   expect(current.waits).toHaveLength(1);
   expect(current.waits[0]).toMatchObject({current:true,waitingOn:"human",owner:"operator"});
   return false;
 }});
 expect(code).toBe(0);expect(nativeCalls).toBe(1);
 const events=await s.read();const started=events.find(e=>e.kind==="wait.started");const resolved=events.filter(e=>e.kind==="wait.resolved");
 expect(started).toBeDefined();expect(resolved).toHaveLength(1);
 expect(resolved[0]?.payload).toMatchObject({waitId:started!.payload["waitId"],attemptId:started!.payload["attemptId"],candidateTreeSha:started!.payload["candidateTreeSha"],scope:started!.payload["scope"],resolution:"Native prompt declined."});
 expect(projectRunProgress(events,new Date().toISOString()).waits[0]?.current).toBe(false);
});


import { COMMANDS, runCli } from "./index.ts";
it("observes verify's own fresh capture without another capture for progress", async () => {
  const s = await setup();
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture", "--allow-empty"], {cwd:s.root});
  captureCalls.count = 0;
  let stderr = "";
  const code = await runCli(["verify"], {cwd:s.root,env:{},stdinIsTTY:false,stdoutIsTTY:false,
    stdout:()=>{},stderr:text=>{stderr+=text},loadConfig:async()=>({...config,baseRef:"HEAD"})});
  expect(code).toBe(1);
  expect(stderr).toContain("delivery_record_missing");
  expect(captureCalls.count).toBe(1);
  const events = await s.read();
  expect(events.filter(e=>e.kind==="activity.observed").map(e=>e.payload["state"])).toEqual(["running","failed"]);
  expect(events.at(-1)?.payload["outcome"]).toBe("policy");
});


const commitFixture = (root: string) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture", "--allow-empty"], {cwd:root});
const runtimeFor = (root: string) => ({cwd:root,env:{},stdinIsTTY:false,stdoutIsTTY:false,stdout:()=>{},stderr:()=>{},loadConfig:async()=>({...config,baseRef:"HEAD"})});
async function captureFixture() {
  const s = await setup(); commitFixture(s.root);
  return {...s,capture:(await wireRepo(s.root,{...config,baseRef:"HEAD"})).captureCandidate};
}
const observer = (start: CommandObservation["start"]): CommandObservation => ({needsCandidate:true,start,prompt:p=>p,finish:async()=>{}});

it("opts in only commands with their own captures, preserving check's eager observation", async () => {
  expect(COMMANDS.filter(c=>"capturesCandidate" in c && c.capturesCandidate).map(c=>c.name).sort()).toEqual([
    "admit","emit-review-evidence","gate","prepare","record","review-context","submit-evidence","verify",
  ]);
  const s=await setup();commitFixture(s.root);captureCalls.count=0;
  expect(await runCli(["check"],runtimeFor(s.root))).toBe(0);
  expect(captureCalls.count).toBe(1);
  expect((await s.read()).filter(e=>e.kind==="activity.observed").map(e=>e.payload["state"])).toEqual(["running","completed"]);
});
it("records argument refusals without capturing solely for progress", async () => {
  const s=await setup();commitFixture(s.root);captureCalls.count=0;
  expect(await runCli(["verify","--invalid"],runtimeFor(s.root))).toBe(2);
  expect(captureCalls.count).toBe(0);
  const events=await s.read();expect(events.filter(e=>e.kind==="activity.observed")).toHaveLength(0);
  expect(events.at(-1)?.payload["outcome"]).toBe("usage");
});
it("keeps legacy runs completion-only without another capture",async()=>{
  const s=await setup(1);commitFixture(s.root);captureCalls.count=0;
  expect(await runCli(["verify"],runtimeFor(s.root))).toBe(1);
  expect(captureCalls.count).toBe(1);
  expect((await s.read()).map(e=>e.kind)).toEqual(["run.started","command.completed"]);
});
it("does not add a capture when no run exists",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"no-command-run-"));roots.push(root);
  execFileSync("git",["init","-q",root]);commitFixture(root);captureCalls.count=0;
  expect(await runCli(["verify"],runtimeFor(root))).toBe(1);
  expect(captureCalls.count).toBe(1);
});
it("keeps repeated command captures fresh and pins progress to the first successful one",async()=>{
  const s=await setup();commitFixture(s.root);captureCalls.count=0;
  const trees:string[]=[];
  const descriptor:CommandDescriptor={name:"check",sourceId:"test.command",summary:"fixture",usage:"fixture",capturesCandidate:true,run:async context=>{
    const wiring=await context.wire();const first=await wiring.captureCandidate();if(!first.ok)throw Error("capture refused");trees.push(first.candidate.treeSha);
    expect((await s.read()).at(-1)?.payload["state"]).toBe("running");
    await writeFile(path.join(s.root,"changed.ts"),"export const changed=1;");execFileSync("git",["add","changed.ts"],{cwd:s.root});
    const second=await wiring.captureCandidate();if(!second.ok)throw Error("second capture refused");trees.push(second.candidate.treeSha);
    return {kind:"ok"};
  }};
  expect(await runCliBoundary(["check"],[descriptor],runtimeFor(s.root))).toBe(0);
  expect(captureCalls.count).toBe(2);expect(trees[0]).not.toBe(trees[1]);
  const activities=(await s.read()).filter(e=>e.kind==="activity.observed");
  expect(activities.map(e=>e.payload["state"])).toEqual(["running","completed"]);
  expect(activities.map(e=>e.candidateTreeSha)).toEqual([trees[0],trees[0]]);
});
it("starts once while concurrent captures retain distinct results",async()=>{
  const s=await captureFixture();const actual=await s.capture();if(!actual.ok)throw Error("capture refused");
  const first={...actual},second={...actual};
  const capture=vi.fn<CaptureCandidate>().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve});
  const start=vi.fn(async()=>{entered();await held;});
  const wrapped=observeCandidateCaptures(capture,observer(start));
  const pending=wrapped();await started;
  let settled=false;const next=wrapped().then(result=>{settled=true;return result;});
  try {
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(capture).toHaveBeenCalledTimes(2);expect(start).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  } finally { release();await Promise.allSettled([pending,next]); }
  expect(await pending).toBe(first);expect(await next).toBe(second);
});
it("preserves failed captures and observes only a later success",async()=>{
  const s=await captureFixture();const good=await s.capture();if(!good.ok)throw Error("capture refused");
  await writeFile(path.join(s.root,"untracked.ts"),"export {};");const bad=await s.capture();expect(bad.ok).toBe(false);
  const capture=vi.fn<CaptureCandidate>().mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
  const start=vi.fn(async()=>{});const wrapped=observeCandidateCaptures(capture,observer(start));
  expect(await wrapped()).toBe(bad);expect(start).not.toHaveBeenCalled();
  expect(await wrapped()).toBe(good);expect(start).toHaveBeenCalledExactlyOnceWith(good.candidate.treeSha);
});
it("does not change capture results or errors when reporting fails",async()=>{
  const s=await captureFixture();const actual=await s.capture();if(!actual.ok)throw Error("capture refused");
  const capture=vi.fn<CaptureCandidate>().mockResolvedValue(actual);
  const start=vi.fn(async()=>{throw Error("observation unavailable");});const wrapped=observeCandidateCaptures(capture,observer(start));
  expect(await wrapped()).toBe(actual);expect(await wrapped()).toBe(actual);expect(capture).toHaveBeenCalledTimes(2);expect(start).toHaveBeenCalledTimes(1);
  const error=Error("capture unavailable");const failed=observeCandidateCaptures(vi.fn<CaptureCandidate>().mockRejectedValue(error),observer(vi.fn(async()=>{})));
  await expect(failed()).rejects.toBe(error);
});
