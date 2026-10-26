import { scopedCheckIdentity, type ScopedRuntimeObservation } from "./scoped-inputs.ts";
import { digestCanonical } from "./digest.ts";
import type { ScopedCheckPlan, ScopedCheckAttempt } from "./records.types.ts";
/** Capture verifier inputs from the selected tree, never a synthetic CI checkout. */
import path from "node:path";
import { createHash } from "node:crypto";
import { BlockedError } from "./blockers.ts";
import { runGitCommand, runGitCommandBytes, evaluateCandidateActivation, type CandidateCommandRunner } from "./candidate.ts";
import type { CapturedCandidate } from "./candidate.types.ts";
import type { HarnessConfig } from "./config.ts";
import { computePreparationFingerprint } from "./preparation.ts";
import { parseCandidateTreeListing, type DeliveryRecord } from "./delivery-record.ts";
import { capturePortableEvidenceContext, portableArtifactContents, portableBlocker, MAX_PORTABLE_ARTIFACT_BYTES } from "./portable-evidence.ts";
import { computeDeliverableIdentity, isRecordNeutralPath } from "./identity.ts";
import { captureCheckBindings } from "./checks.ts";
import { retainedCheckOutput } from "./validator/checks-passed.ts";
import { readCompiledRepositoryPolicy, type ReviewInputReader } from "./review-inputs.ts";
import { isSafeRelativePath } from "./validator/envelope.ts";

export interface CandidateTreeInputMetadata {
  readonly mode: string | null;
  readonly links: readonly { readonly path: string; readonly target: string }[];
}
export type CandidateTreeInputReader = ReviewInputReader & { metadata(repoPath: string): Promise<CandidateTreeInputMetadata> };
export async function candidateTreeEvidenceReader(rootDir: string, treeSha: string, run: CandidateCommandRunner = runGitCommand): Promise<CandidateTreeInputReader> {
  return candidateTreeReader(rootDir, treeSha, run, MAX_PORTABLE_ARTIFACT_BYTES);
}
/** Source inputs are hashed from Git, not transported as portable artifacts.
 * Directory links contribute verified target-tree bytes and their link metadata. */
export async function candidateTreeSourceReader(rootDir: string, treeSha: string, run: CandidateCommandRunner = runGitCommand): Promise<CandidateTreeInputReader> {
  return candidateTreeReader(rootDir, treeSha, run, undefined, true);
}
async function candidateTreeReader(rootDir: string, treeSha: string, run: CandidateCommandRunner, maxBytes?: number, directoryLinks = false): Promise<CandidateTreeInputReader> {
  const refusal = (message: string): never => { throw new BlockedError([portableBlocker("portable_tree_unreadable", message)]); };
  const listing = await run(["git", "ls-tree", "-r", ...(directoryLinks ? ["-t"] : []), "-z", "--full-tree", treeSha], { cwd: rootDir });
  if (listing.exitCode !== 0) refusal("The target candidate tree cannot be enumerated.");
  const entries = new Map(parseCandidateTreeListing(listing.stdout).map(entry => [entry.path, entry]));
  const objectReads = new Map<string, Promise<Buffer>>();
  const verifyObject = (sha: string, type: "blob" | "tree", bytes: Buffer): Buffer => {
    const actual = createHash(sha.length === 64 ? "sha256" : "sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== sha) refusal(`The target-tree reader did not preserve the exact ${type} bytes.`);
    return bytes;
  };
  const loadObject = async (sha: string, type: "blob" | "tree"): Promise<Buffer> => {
    const size = await run(["git", "cat-file", "-s", sha], { cwd: rootDir });
    if (size.exitCode !== 0 || !/^\d+\s*$/.test(size.stdout) || (maxBytes !== undefined && Number(size.stdout) > maxBytes)) refusal("A target-tree input is missing or oversized.");
    const result = await run(["git", "cat-file", type, sha], { cwd: rootDir, captureBytes: true });
    if (result.exitCode !== 0) refusal("A target-tree evidence input cannot be read.");
    const bytes = result.stdoutBase64 === undefined ? Buffer.from(result.stdout, "utf8") : Buffer.from(result.stdoutBase64, "base64");
    return verifyObject(sha, type, bytes);
  };
  type ObjectRequest = { sha: string; type: "blob" | "tree"; resolve: (bytes: Buffer) => void; reject: (error: unknown) => void };
  const queued: ObjectRequest[] = [];
  let active = false, scheduled = false;
  const schedule = () => {
    if (active || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { void flush(); });
  };
  const flush = async () => {
    scheduled = false;
    active = true;
    const batch = queued.splice(0, 8);
    try {
      const result = await runGitCommandBytes(["git", "cat-file", "--batch"], {
        cwd: rootDir, stdin: batch.map(request => `${request.sha}\n`).join(""),
      });
      if (result.exitCode !== 0) refusal("A target-tree evidence input cannot be read.");
      const output = result.stdout, values: Buffer[] = [];
      let offset = 0;
      for (const request of batch) {
        const end = output.indexOf(0x0a, offset);
        if (end < offset || end - offset > 128) refusal("A target-tree object batch has an invalid header.");
        const header = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) (blob|tree) (0|[1-9][0-9]*)$/.exec(output.subarray(offset, end).toString("utf8"));
        if (!header || header[1] !== request.sha || header[2] !== request.type) refusal("A target-tree object batch has an invalid identity or type.");
        const size = Number(header![3]), start = end + 1, finish = start + size;
        if (!Number.isSafeInteger(size) || !Number.isSafeInteger(finish) || finish >= output.length || output[finish] !== 0x0a) refusal("A target-tree object batch has invalid or truncated bytes.");
        values.push(verifyObject(request.sha, request.type, Buffer.from(output.subarray(start, finish))));
        offset = finish + 1;
      }
      if (offset !== output.length) refusal("A target-tree object batch has unexpected trailing bytes.");
      // Publish nothing until every frame and the finite process have passed.
      batch.forEach((request, index) => request.resolve(values[index]!));
    } catch (error) { batch.forEach(request => request.reject(error)); }
    finally { active = false; if (queued.length) schedule(); }
  };
  const loadNativeObject = (sha: string, type: "blob" | "tree"): Promise<Buffer> => new Promise((resolve, reject) => {
    queued.push({ sha, type, resolve, reject });
    schedule();
  });
  // One reader owns one pinned tree and one size policy. Only verified bytes
  // resolve successfully; sharing in-flight reads also avoids duplicate Git I/O.
  const readObject = (sha: string, type: "blob" | "tree" = "blob"): Promise<Buffer> => {
    const key = `${type}:${sha}`;
    const existing = objectReads.get(key);
    if (existing) return existing;
    // Injected runners retain their existing per-object command contract. This
    // native-only choice is stable, never a fallback after a batch failure.
    const pending = directoryLinks && run === runGitCommand ? loadNativeObject(sha, type) : loadObject(sha, type);
    objectReads.set(key, pending);
    void pending.catch(() => { if (objectReads.get(key) === pending) objectReads.delete(key); });
    return pending;
  };
  const resolve = async (requested: string) => {
    if (!isSafeRelativePath(requested)) refusal("An evidence input is not a safe repository-relative path.");
    let current = requested;
    const links: { path: string; target: string }[] = [];
    for (let depth = 0; depth < 32; depth += 1) {
      const segments = current.split("/");
      let redirected = false;
      for (let index = 0; index < segments.length; index += 1) {
        const prefix = segments.slice(0, index + 1).join("/");
        const entry = entries.get(prefix);
        if (entry?.mode !== "120000") continue;
        const target = (await readObject(entry.objectSha)).toString("utf8");
        links.push({ path: prefix, target });
        if (path.posix.isAbsolute(target) || target.includes("\\") || target.includes("\0")) refusal("An evidence input symlink escapes the repository.");
        current = path.posix.normalize(path.posix.join(path.posix.dirname(prefix), target, ...segments.slice(index + 1)));
        if (!isSafeRelativePath(current)) refusal("An evidence input symlink escapes the repository.");
        redirected = true;
        break;
      }
      if (redirected) continue;
      const entry = entries.get(current);
      if (entry === undefined) return { entry, links };
      if (entry.mode === "040000" && directoryLinks) {
        // Only a committed link is an inventory input. Its target tree bytes
        // bind all descendant names, modes and objects without flattening the
        // link or treating a physical directory as a regular evidence file.
        return { entry: entries.get(requested)?.mode === "120000" ? entry : undefined, links };
      }
      if (!/^100(?:644|755)$/.test(entry.mode)) refusal("An evidence input is not a regular committed file.");
      return { entry, links };
    }
    return refusal("An evidence input symlink chain is cyclic or too deep.");
  };
  return Object.assign(async (requested: string) => {
    const { entry } = await resolve(requested);
    // The cache owns its buffers; callers may mutate only their own copies.
    return entry ? Buffer.from(await readObject(entry.objectSha, entry.mode === "040000" ? "tree" : "blob")) : null;
  }, { metadata: async (requested: string): Promise<CandidateTreeInputMetadata> => {
    const { entry, links } = await resolve(requested);
    return { mode: entry?.mode ?? null, links };
  } });
}

export async function capturePortableVerificationInputs(rootDir: string, config: HarnessConfig, candidate: CapturedCandidate, record: DeliveryRecord, run: CandidateCommandRunner = runGitCommand) {
  const transportedHeads = new Map<string, Promise<boolean>>();
  const recordTransportFrom = (originalHead: string): Promise<boolean> => {
    const cached = transportedHeads.get(originalHead);
    if (cached) return cached;
    const proof = (async () => {
      let head = candidate.headSha;
      for (let count = 0; head !== originalHead && count < 64; count++) {
        const parent = await run(["git", "rev-list", "--parents", "-n", "1", head], { cwd: rootDir });
        const members = parent.stdout.trim().split(/\s+/);
        if (parent.exitCode !== 0 || members.length !== 2 || members[0] !== head) return false;
        const diff = await run(["git", "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", head], { cwd: rootDir });
        const paths = diff.stdout.split("\0").filter(Boolean);
        if (diff.exitCode !== 0 || paths.length === 0 || paths.some(p => !isRecordNeutralPath(config, p))) return false;
        head = members[1]!;
      }
      return head === originalHead;
    })();
    transportedHeads.set(originalHead, proof);
    return proof;
  };
  const read = await candidateTreeEvidenceReader(rootDir, candidate.treeSha, run);
  const readWiring = async (repoPath: string): Promise<Uint8Array> => {
    const bytes = await read(repoPath);
    if (bytes === null) throw new BlockedError([portableBlocker("portable_wiring_missing", "A target-tree preparation input is missing.")]);
    return bytes;
  };
  const preparationFingerprint = await computePreparationFingerprint(rootDir, config, { readWiring });
  const evidenceContext = await capturePortableEvidenceContext(config, read, preparationFingerprint, candidate.deliverable.digest);
  const compiledPolicy = await readCompiledRepositoryPolicy(read);
  let scopedPlan: ScopedCheckPlan | undefined;
  let bindingCandidate = candidate;
  if (config.providers.some(p => p.check?.scope)) {
    const validationConfig = { ...config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: config.recordNeutral };
    const [recorded, current] = await Promise.all([record.candidateBinding.treeSha, candidate.treeSha].map(treeSha => computeDeliverableIdentity({ rootDir, treeSha, config: validationConfig }, { run })));
    // Non-reusable executions may be verified after their record transport is
    // staged. This proves strict byte equivalence; it never grants gate reuse.
    if (recorded === current && record.candidateBinding.baseRef === candidate.base.ref && record.candidateBinding.baseTipSha === candidate.base.tipSha && record.candidateBinding.mergeBaseSha === candidate.base.mergeBaseSha) bindingCandidate = { ...candidate, treeSha: record.candidateBinding.treeSha, workspaceId: record.candidateBinding.workspaceId };
  }
  const scopedProviders = config.providers.filter(p => p.check?.scope);
  if (scopedProviders.length) {
    const readSource = await candidateTreeSourceReader(rootDir, candidate.treeSha, run);
    const listing = await run(["git", "ls-tree", "-r", "--name-only", "-z", candidate.treeSha], { cwd: rootDir });
    if (listing.exitCode !== 0) throw new BlockedError([portableBlocker("portable_tree_unreadable", "Cannot enumerate scoped source inputs.")]);
    const checks: Record<string, ScopedCheckPlan["checks"][string]> = {};
    for (const provider of scopedProviders) {
      const evidence = record.claims.flatMap(c => [...(c.evidence ? [c.evidence] : []), ...(c.supportingEvidence ?? [])]).find(e => e.resolution.kind === "evidence" && e.resolution.providerId === provider.id);
      const portable = evidence?.resolution.kind === "evidence" ? evidence.resolution.portable : undefined;
      const contents = portableArtifactContents(portable?.artifacts);
      const raw = contents.artifacts.get("scoped-inputs.json");
      if (!raw) throw new BlockedError([portableBlocker("portable_scoped_inputs_missing", "Scoped execution requires retained input observations and its originating attempt.")]);
      let mismatch = "retained observation";
      try {
        const retained = JSON.parse(raw) as { observation: ScopedRuntimeObservation; attempt: ScopedCheckAttempt };
        // Record-only transport verifies the historical execution, including its
        // HEAD. The strict equivalence/base proof above does not grant gate reuse.
        const manifestCandidate = (portable?.manifest as { candidate?: { headSha?: unknown } } | undefined)?.candidate;
        let identityCandidate = bindingCandidate.treeSha === record.candidateBinding.treeSha && bindingCandidate.workspaceId === record.candidateBinding.workspaceId && typeof manifestCandidate?.headSha === "string" && /^[a-f0-9]{40}$/.test(manifestCandidate.headSha) && await recordTransportFrom(manifestCandidate.headSha)
          ? { ...bindingCandidate, headSha: manifestCandidate.headSha } : candidate;
        // A record can itself have reused an earlier execution after neutral
        // staging. Prove that attempt's tree too, rather than assuming every
        // evidence manifest was executed on the record's final tree.
        const origin = retained.attempt.origin.candidate;
        if (identityCandidate !== candidate && origin.treeSha !== identityCandidate.treeSha) {
          const validationConfig = { ...config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: config.recordNeutral };
          const [original, current] = await Promise.all([origin.treeSha, candidate.treeSha].map(treeSha => computeDeliverableIdentity({ rootDir, treeSha, config: validationConfig }, { run })));
          if (original === current && origin.baseRef === candidate.base.ref && origin.baseTipSha === candidate.base.tipSha && origin.mergeBaseSha === candidate.base.mergeBaseSha)
            identityCandidate = { ...identityCandidate, treeSha: origin.treeSha };
        }
        const identity = await scopedCheckIdentity(config, provider, listing.stdout.split("\0").filter(Boolean), readSource, retained.observation, identityCandidate, read);
        const differences = [
          ...(retained.attempt.providerId !== provider.id ? ["providerId"] : []),
          ...(retained.attempt.status !== "passed" ? ["attempt status"] : []),
          ...(retained.attempt.inputDigest !== identity.inputDigest ? ["inputDigest"] : []),
          ...(retained.attempt.profileDigest !== identity.profileDigest ? ["profileDigest"] : []),
        ];
        if (differences.length) { mismatch = differences.join(", "); throw new Error("Mismatched scoped execution identity"); }
        checks[provider.id] = { inputDigest: identity.inputDigest, profileDigest: identity.profileDigest, reusable: identity.reusable, attempts: [retained.attempt] };
      } catch (error) {
        const cause = error instanceof BlockedError ? ` (${error.blockers.map(blocker => blocker.code).join(", ")})` : "";
        throw new BlockedError([portableBlocker("portable_scoped_inputs_invalid", `Provider ${provider.id}: ${mismatch} does not match the selected source, profile or policy${cause}.`)]);
      }
    }
    scopedPlan = { version: "scoped-plan/1", candidate: { treeSha: bindingCandidate.treeSha, deliverableDigest: candidate.deliverable.digest, identityToken: candidate.deliverable.identity, baseRef: candidate.base.ref, baseTipSha: candidate.base.tipSha, mergeBaseSha: candidate.base.mergeBaseSha, workspaceId: bindingCandidate.workspaceId },
      selectionDigest: digestCanonical(scopedProviders.map(p => ({ id: p.id, check: p.check })).sort((a, b) => a.id.localeCompare(b.id))), checks };
  }
  const checkBindings = await captureCheckBindings(rootDir, config, bindingCandidate, { readWiring, readReleaseInputs: read, ...(scopedPlan ? { scopedPlan } : {}),
    readOutput: async (repoPath, providerId) => {
      const evidence = record.claims.flatMap(claim => [
        ...(claim.evidence === undefined ? [] : [claim.evidence]),
        ...(claim.supportingEvidence ?? []),
      ]).find(entry => entry.resolution.kind === "evidence" && entry.resolution.providerId === providerId);
      const portable = evidence?.resolution.kind === "evidence" ? evidence.resolution.portable : undefined;
      const contents = portableArtifactContents(portable?.artifacts);
      const index = config.providers.find(provider => provider.id === providerId)?.check?.outputs?.indexOf(repoPath) ?? -1;
      return retainedCheckOutput(contents.artifacts, repoPath, index);
    },
  });
  const projection = await evaluateCandidateActivation({ rootDir, config, candidate, run });
  // Human approval binds the stricter candidate, allowing only its record transport.
  // Read Git trees directly; portable verification needs no old provider folders.
  let waiverCandidateMatches: boolean | undefined;
  if (record.claims.some(claim => claim.outcome === "waived")) {
    const validationConfig = { ...config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: config.recordNeutral };
    const [approved, target] = await Promise.all([record.candidateBinding.treeSha, candidate.treeSha].map(treeSha =>
      computeDeliverableIdentity({ rootDir, treeSha, config: validationConfig }, { run })));
    waiverCandidateMatches = approved === target;
  }
  return { evidenceContext, checkBindings, projection, ...(compiledPolicy === null ? {} : { compiledPolicy }),
    ...(waiverCandidateMatches === undefined ? {} : { waiverCandidateMatches }) };
}
