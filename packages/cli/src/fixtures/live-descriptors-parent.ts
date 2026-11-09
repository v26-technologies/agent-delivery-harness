// V26-3314: run by live-providers.test.ts with a marker pipe on fd 3. Collects
// live results once with a provider that declares fd 3 and once with one that
// does not, and prints what each provider held on fd 3 and what its
// environment said it inherited.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import adopter from "../../../../harness.config.ts";
import { captureGitCandidate, channelIdentity, collectLiveProviderResults, computePreparationFingerprint, defineHarnessConfig, evaluateCandidateActivation, INHERITED_DESCRIPTORS_ENV, withDeliverableIdentity } from "@agent-delivery-harness/kernel";

const exec = promisify(execFile);
const provider = `const fs=require('fs');let held=null;try{held=fs.readFileSync(3,'utf8')}catch{}
fs.writeFileSync('.git/inherited',JSON.stringify({held,stated:process.env.${INHERITED_DESCRIPTORS_ENV}??null}));
require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.kind==='negotiate')console.log(JSON.stringify({kind:'negotiation',outcome:'supported',selectedVersion:'delivery-provider-rails/1',supportedVersions:['delivery-provider-rails/1']}));
 if(m.kind==='request')console.log(JSON.stringify({kind:'terminal',version:m.version,requestId:m.requestId,sequence:1,summary:'observed',outcome:'success'}));});`;

const reports: unknown[] = [];
for (const declared of [false, true]) {
  const dir = await mkdtemp(path.join(tmpdir(), "live-descriptors-"));
  try {
    const git = (...args: string[]) => exec("git", args, { cwd: dir });
    await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
    await writeFile(path.join(dir, "source.ts"), "export const a=1;"); await writeFile(path.join(dir, "harness.config.ts"), "export default {};");
    await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "base"); await git("branch", "origin/main");
    const config = defineHarnessConfig({ ...adopter, preparationCommands: [], preparationWiringPaths: ["harness.config.ts"],
      providers: [{ id: "live.sensor", findingCodes: [], command: [process.execPath, "-e", provider], ...(declared ? { inheritDescriptors: [3] as const } : {}) }],
      obligations: [{ ...adopter.obligations[0]!, id: "live.current", freshness: "live", providers: ["live.sensor"], activation: { kind: "always" }, humanWaiverAllowed: false, allowedResolutionKinds: ["satisfied_live_fact", "not_applicable"] }] });
    const capture = await captureGitCandidate({ rootDir: dir, config, workspaceId: "test-workspace", computeIdentity: withDeliverableIdentity() });
    if (!capture.ok) throw new Error(JSON.stringify(capture));
    const result = await collectLiveProviderResults({ rootDir: dir, config, candidate: capture.candidate,
      projection: await evaluateCandidateActivation({ rootDir: dir, config, candidate: capture.candidate }),
      evidenceContext: { preparationFingerprint: await computePreparationFingerprint(dir, config), release: null },
      env: { ...process.env, [INHERITED_DESCRIPTORS_ENV]: `3:${channelIdentity(3)}` } });
    reports.push({ status: result.liveResults[0]?.status ?? null, ...JSON.parse(await readFile(path.join(dir, ".git/inherited"), "utf8")) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(reports));
