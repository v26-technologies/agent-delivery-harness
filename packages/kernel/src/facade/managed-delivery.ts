import { capturePortableVerificationInputs } from "../portable-inputs.ts";
import { computePreparationFingerprint } from "../preparation.ts";
import { capturePortableEvidenceContext, repositoryEvidenceReader } from "../portable-evidence.ts";
/**
 * The facade module's V-slice: ONE typed operation surface over the walking
 * skeleton's modules — accept an already-scoped contract, bind the
 * host-supplied workspace, drive the checkpoint path, and reconstruct
 * status/resume from durable state — with every mutation-capable operation
 * passing the canonical rechecks (product trust, registering installation and
 * active profile, projection digest) before it touches the journal.
 *
 * WHAT THIS FACADE NEVER DOES: launch a coding agent, schedule a subagent,
 * create or delete a worktree, or advance a checkpoint from a host-activity
 * observation. Worktrees are host-created and handed in; the only processes
 * the facade runs — git plumbing and the trusted-base sensor — go through the
 * injected exec port so the scenario sensor can assert the complete launch
 * inventory.
 *
 * CONFIRMATIONS. Contract confirmation and takeover authorization are
 * operator confirmations: excluded from every execution grant, denied by the
 * interceptor, and served only by this facade's channel. The walking skeleton
 * runs under the composition's `confirmation-fixture` profile — valid only in
 * disposable-repository qualification runs and production-rejected by the
 * installer — where the binding renders the challenge into the
 * installation-scoped confirmation channel file instead of an interactive
 * display. Echo evaluation still runs the frozen model-external decision:
 * a model-visible surface, a closed channel, a consumed or expired challenge,
 * or a wrong echo refuses exactly as in production.
 *
 * RESUME. Graceful SessionEnd evidence can report honest `paused`, but this
 * host is currently graded Tier 0 because production has no qualified
 * pre-registration confirmation producer. The confirmation fixture proves
 * fresh-worktree takeover semantics, including fence, revision, and target
 * commit binding; production takeover remains unavailable until the missing
 * producer is qualified.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertionLaneAvailability,
  evaluateConfirmationEcho,
  evaluateHostAdmission,
  type CheckpointAdmissionExpectation,
  type ConfirmationEchoAttempt,
  type IntakeAdmissionExpectation,
  type RenderedConfirmationChallenge,
} from "../binding/host-admission.ts";
import { createBlocker, type Blocker } from "../blockers.ts";
import {
  createIntakeJournalStore,
  createJournalStore,
  type IntakeJournalStore,
  type JournalStore,
} from "../checkpoint/journal-store.ts";
import { evaluateCanonicalRecheck, type CompareCheck, type RecheckValues, type ValueCheck } from "../checkpoint/recheck.ts";
import { resolveCommonDirectoryNamespace } from "../checkpoint/run-namespace.ts";
import {
  deleteDelivery as runDeliveryDeletion,
  exportDelivery as runDeliveryExport,
  type RetentionContext,
} from "../checkpoint/retention.ts";
import { digestCanonical, sha256Hex } from "../digest.ts";
import { createArtifactsPort } from "../artifacts.ts";
import { liveHookRuntimeProbes, resolveHookRuntimeArgs, type HookRuntimeProbes } from "./hook-runtime.ts";
import { runAdmission } from "../admission.ts";
import {
  buildDeliveryRecord,
  isDeliveryOwnedTreeEntry,
  deliveryRecordBytes,
  deliveryRecordPathFor,
  needsCommittedSymlinkTarget,
  parseCandidateTreeListing,
  parseDeliveryRecord,
  verifyDeliveryRecord,
  type CandidateTreeEntry,
} from "../delivery-record.ts";
import { publishPreparationReceipt } from "../preparation.ts";
import { discoverRecords, resolveRecordStorage } from "../records.ts";
import { submitManifest } from "../recorder.ts";
import { reviewFindingCoherenceCodes, reviewFindingCoherenceCodesV2 } from "../validator/review-green.ts";
import { REVIEW_GREEN_1, REVIEW_GREEN_2 } from "../validator/codes.ts";
import { createCandidateCapture, evaluateCandidateActivation, type CandidateCommandRunner } from "../candidate.ts";
import { isRecordNeutralPath, isReviewNeutralPath, withDeliverableIdentity } from "../identity.ts";
import { classifyExecutionContext, type EnvSnapshot } from "../context.ts";
import { validateHarnessConfig, type HarnessConfig } from "../config.ts";
import type { CaptureCandidate, CapturedCandidate } from "../candidate.types.ts";
import { PORTABLE_INTAKE_GRANT, verifyCompiledPolicy, type CompiledPolicy } from "../policy/compile.ts";
import { validateExecutionGrant } from "../spine/grant.ts";
import {
  checkReviewFloor,
  composeOutcomeVerification,
  qualifyReviewAttempts,
  type ConsumedWaiver,
  type RecordedReviewAttempt,
  type RecordedSensorResult,
} from "../evidence/review.ts";
import {
  WAIVER_APPROVAL_ORIGIN_PREFIX,
  checkPositiveCriterion,
  evaluateWaiverConsumption,
  type WaiverProposal,
} from "../evidence/waiver.ts";
import { composeBlockerInventory, type BlockerInventoryEntry } from "../evidence/blocker-inventory.ts";
import { gradeHostActivity, resolveObservationLifetimeSeconds, type HostActivity } from "./liveness.ts";
import { decideFinishLine, type ExternalVerification } from "../finish-line/merge-ready.ts";
import {
  GENERATION_SKILLS_ARCHIVE,
  bindingStateFile,
  claudeCodeBinding,
  gradeResumeEligibility,
  gradedDescendantTeardown,
  materializeProjection,
  mintGrantAttestation,
  tearDownProjection,
} from "../host/claude-code.ts";
import type { ManagedHostBinding } from "../host/managed-host-binding.ts";
import { PROJECTION_RECEIPT_FILE, readConsumptionMarker, verifyProjection } from "../host/projection.ts";
import {
  emitProjectionConsumptionRecord,
  SHADOW_MILESTONE_GATE_RECORD_PATH,
  type ProjectionConsumptionUnobserved,
} from "../host/consumption-gate-record.ts";
import { projectionConsumptionObservationFile } from "../projection-consumption-observation.ts";
import { createExecPort, type ExecPort } from "../host/exec-port.ts";
import {
  createProviderReviewHandoff,
  parseProviderReviewResult,
  type ProviderReviewCapability,
  type ProviderReviewHandoff,
  type ProviderReviewResult,
} from "../host/provider-review-result.ts";
import {
  PINNED_AGENT_SKILLS,
  PRODUCT_TRUST_LABEL,
  localDigestTrustPredicate,
  type ProductTrustState,
} from "../spine/composition.ts";
import { checkContractWithinPolicy, validateAcceptedContract, type AcceptedContract, type OutcomeVerification } from "../spine/contract.ts";
import { validateSensorResult } from "../spine/capability.ts";
import type { PolicySnapshot } from "../spine/policy.ts";
import type { DeliveryState, IntakeState } from "../spine/vocabulary.ts";
import {
  assertionSourceForKind,
  loadPinnedGeneration,
  registrationBinding,
  resolveActiveGeneration,
  trustStorePathFor,
  type SubstrateBlocker,
} from "../substrate/installer.ts";
import { loadAssertionProviderConfig, type AssertionSourcePort } from "../substrate/assertion-source.ts";
import { SENSITIVE_APPROVAL_ASSERTION_SPEC, SECURITY_BLOCKED_MIGRATION_ACTION } from "../spine/assertion.ts";
import { evaluateMigrationConsumption } from "./migration.ts";
import {
  composeManagedStatus,
  type AssertionSourceView,
  type ListedDelivery,
  type ManagedCheckpoint,
  type ManagedDeliveryStatus,
  type ManagedStatusInput,
  type ProductTrustView,
  type RegistrationMismatch,
  type WorkspaceDisposition,
} from "./status.ts";
import { parseTrustState } from "../substrate/trust-store.ts";
import {
  maintainTrustState,
  rollbackComposition,
  updateComposition,
  type MaintainTrustStateInput,
  type UpdateCompositionInput,
} from "../substrate/lifecycle.ts";
import {
  loadBundledWorkflowGraph,
  workflowStageBindingFor,
  workflowStageOf,
  type WorkflowGraph,
} from "../workflow/graph.ts";
import {
  WORKFLOW_CANDIDATE_REF_SPEC,
  WORKFLOW_STAGE_RESULT_SPEC,
  WORKFLOW_SUBJECT_REF_SPEC,
  evaluateStagePrerequisites,
  validateWorkflowStageResult,
  type AcceptedStageResult,
  type CompletedStageSummary,
} from "../workflow/result.ts";

// ── Result and blocker plumbing ────────────────────────────────────────────

const SOURCE = { kind: "command", id: "managed-delivery.facade" } as const;

export type FacadeFailure = { readonly ok: false; readonly blockers: readonly Blocker[] };

const refuse = (code: string, summary: string, remediation: string): FacadeFailure => ({
  ok: false,
  blockers: [
    createBlocker({
      code,
      source: SOURCE,
      summary,
      remediations: [{ id: `${code.replaceAll("_", "-")}-remediation`, kind: "manual_action", summary: remediation }],
    }),
  ],
});

const refuseWith = (blockers: readonly Blocker[]): FacadeFailure => ({ ok: false, blockers });

/**
 * A maintenance-lane refusal, reported with the substrate's own code and
 * message. The lane already decided why it failed closed; restating that
 * decision here is how two vocabularies for one refusal appear.
 */
const substrateRefusal = (blockers: readonly SubstrateBlocker[]): FacadeFailure =>
  refuseWith(
    blockers.map((blocker) =>
      createBlocker({
        code: blocker.code,
        source: SOURCE,
        summary: blocker.message,
        remediations: [
          {
            id: "maintenance-lane-remediation",
            kind: "manual_action",
            summary: "Resolve the reported maintenance-lane condition and repeat the operation with a fresh assertion.",
          },
        ],
      }),
    ),
  );

// ── Durable layout ─────────────────────────────────────────────────────────

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

/**
 * The model-external hook entry, named the way the packed composition STAGES
 * it — relative to the generation root rather than to a checkout layout above
 * this module.
 *
 * The command that names it runs on the RUNNING Node executable and nothing
 * else. A composition stages the harness packages and no `node_modules`, so a
 * command naming a dependency binary resolved from a checkout points at
 * something an installed generation does not have; this repository ships zero
 * runtime dependencies, and the emitted command has to hold to that too. Node
 * strips the types itself, which is why `tsconfig.base.json` pins
 * `erasableSyntaxOnly`.
 *
 * The flag is why the package's engines floor is 22.6 and not 22: earlier
 * 22.x rejects it outright, and the interceptor would then never start — an
 * empty stdout and an exit code the host does not read as blocking, which is
 * a deny-until-attested boundary failing OPEN. Which flags this runtime
 * actually accepts, and whether it is Node at all, are PROBED rather than
 * assumed — see `hook-runtime.ts` — and a runtime that cannot be observed to
 * support them is refused rather than handed a command it will reject.
 */
const GENERATION_HOOK_ENTRY = "harness/packages/kernel/src/host/hook-main.ts";

/**
 * The staged hook entry, resolved to the spelling the entry will recognize as
 * its own — or `undefined` when the generation does not stage it.
 *
 * RESOLVED, not merely joined. The entry decides it was invoked directly by
 * comparing its argument vector against its own module URL, and Node resolves
 * that URL through symlinks. An installation path reached through a symlink —
 * which is the DEFAULT spelling of the temp root on some platforms — would
 * therefore start the process and run nothing: no interceptor, no refusal, and
 * a session that looks admitted. Resolving here is what makes the emitted
 * command the entry's own name for itself.
 */
async function resolveStagedHookEntry(target: string): Promise<string | undefined> {
  try {
    return (await stat(target)).isFile() ? await realpath(target) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The host this facade's binding drives, taken from the binding itself rather
 * than restated here: the key into the graded capability record and the host
 * identity are one value, so a second binding cannot be reached through a
 * facade still grading the first.
 */
const DEFAULT_HOST_BINDING: ManagedHostBinding = claudeCodeBinding;

export interface ManagedInstallation {
  readonly installationPath: string;
  readonly receiptDir: string;
}

export interface CreateFacadeInput {
  /** Any checkout of the adopter repository (root or linked worktree). */
  readonly repoDir: string;
  /** The adopter's already-compiled policy and its resolved native bindings. */
  readonly policyBinding: CompiledAdopterPolicyBinding;
  readonly installation: ManagedInstallation;
  readonly hostVersion: string;
  readonly exec?: ExecPort;
  /**
   * The one host binding this facade drives. Supplied, never discovered: the
   * facade holds a single instance and chooses between none. Defaults to the
   * Claude Code binding, which is what every existing caller gets, unchanged.
   */
  readonly hostBinding?: ManagedHostBinding;
  /**
   * Observations of the runtime that will carry the emitted hook command.
   * Injectable so an unsupported runtime is testable without one; the live
   * default observes the real process.
   */
  readonly hookRuntime?: HookRuntimeProbes;
}

/**
 * The one adopter-owned seam into the portable facade. The policy compiler
 * owns grants, lenses, capability identities, and the admission projection;
 * the host/adopter supplies only resolved bytes and one trusted sensor path.
 */
export interface CompiledAdopterPolicyBinding {
  readonly compiledPolicy: CompiledPolicy;
  readonly personaSources: Readonly<Record<string, ResolvedPersonaSource>>;
  readonly sensor: {
    readonly capabilityId: string;
    readonly trustedBasePath: string;
  };
  readonly outcomeAuthorities: readonly string[];
}

export type ResolvedPersonaSource =
  | { readonly origin: "composition"; readonly bytes: string; readonly digest: string }
  | { readonly origin: "repository"; readonly bytes: string; readonly digest: string; readonly trustedBasePath: string };

export const compiledAdopterPolicyBindingDigest = (binding: CompiledAdopterPolicyBinding): string => digestCanonical(binding);

interface DeliveryMeta {
  readonly contract: AcceptedContract;
  readonly policy: PolicySnapshot;
  readonly generationDigest: string;
  readonly intakeId: string;
  readonly policyBindingDigest: string;
}

/**
 * The presentation-time binding of one intake draft: the presented contract,
 * the policy and generation it validated against, and the single-use nonce of
 * the pending confirmation. A draft mutation after presentation clears the
 * nonce — the operator confirmed different bytes.
 */
interface IntakeMeta {
  readonly contract: AcceptedContract;
  readonly policy: PolicySnapshot;
  readonly generationDigest: string;
  readonly nonce?: string;
  readonly policyBindingDigest: string;
}

/** The four-member verified release projection every typed stage result binds. */
const RELEASE_IDENTITY = Object.freeze({
  releaseId: PINNED_AGENT_SKILLS.releaseId,
  profile: PINNED_AGENT_SKILLS.profile,
  archiveSha256: PINNED_AGENT_SKILLS.archiveSha256,
  metadataSha256: PINNED_AGENT_SKILLS.metadataSha256,
});

/**
 * Findings-driven review rounds allowed before the bounded-loop blocker
 * records: review repeats until the selected lenses approve OR this bound is
 * reached — the loop cannot spin unobserved forever.
 */
const REVIEW_ROUND_BOUND = 3;

interface WorkspaceMeta {
  readonly worktreeDir: string;
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly branchRef: string;
  readonly observationLifetimeSeconds: number;
  readonly workflowGraphSha256: string;
  readonly discoveryConfigurationDigest: string;
  readonly projectionDigest: string;
  /** The fence this workspace was bound under. */
  readonly fence: number;
  /** The fence-scoped admission configuration this delivery's session carries. */
  readonly settingsPath: string;
}

interface PendingTakeover {
  readonly targetBaseCommit: string;
  readonly takeoverBranchRef: string;
  readonly supersededFence: number;
}

interface PendingConfirmation {
  readonly rendered: RenderedConfirmationChallenge;
  readonly confirmation: Record<string, unknown>;
  readonly subject: string;
}

interface CapabilityBinding {
  readonly id: string;
  readonly digest: string;
}

interface StoredProviderReviewHandoff {
  readonly handoff: ProviderReviewHandoff;
  readonly invocationCapability: CapabilityBinding;
  readonly reviewWorkspaceDir: string;
}

interface ProviderReviewAuthorityState {
  readonly deliveryId: string;
  readonly workspaceId: string;
  readonly fence: number;
  readonly discoveryConfigurationDigest: string;
  readonly grantDigest: string;
  readonly productTrustRevocationEpoch: number;
  readonly bindingCapability: CapabilityBinding;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

const capabilityShape = (capability: ProviderReviewCapability): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(capability.id) && capability.secret.length >= 32 && capability.secret.length <= 1024;

const capabilityDigest = (input: {
  readonly domain: "workspace" | "review-invocation";
  readonly capability: ProviderReviewCapability;
  readonly deliveryId: string;
  readonly workspaceId: string;
  readonly fence: number;
  readonly handoffId?: string;
  readonly nativeSessionId?: string;
  readonly nativeRunId?: string;
  readonly discoveryConfigurationDigest?: string;
  readonly grantDigest?: string;
  readonly promptContextDigest?: string;
  readonly productTrustRevocationEpoch?: number;
  readonly reviewWorkspaceId?: string;
}): string => digestCanonical(input);

async function writeOwned(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: OWNER_DIR });
  await writeFile(target, contents, { mode: OWNER_FILE });
  await chmod(target, OWNER_FILE);
}

async function readJson<T>(target: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// ── Journal reading helpers ────────────────────────────────────────────────

interface JournalEntryView {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

const viewsOf = (entries: readonly unknown[]): JournalEntryView[] =>
  entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    return { kind: record["kind"] as string, payload: record["payload"] as Record<string, unknown> };
  });

const lastOf = (views: readonly JournalEntryView[], kind: string): JournalEntryView | undefined =>
  [...views].reverse().find((view) => view.kind === kind);

interface CurrentCandidate {
  readonly treeSha: string;
  readonly branchRefValue: string;
}

function currentCandidateOf(views: readonly JournalEntryView[]): CurrentCandidate | undefined {
  const recaptured = lastOf(views, "candidate.recaptured");
  if (recaptured !== undefined) {
    return {
      treeSha: recaptured.payload["treeSha"] as string,
      branchRefValue: recaptured.payload["branchRefValue"] as string,
    };
  }
  const fenced = lastOf(views, "invocation.fenced");
  if (fenced !== undefined) {
    return {
      treeSha: fenced.payload["candidateTreeSha"] as string,
      branchRefValue: fenced.payload["candidateBranchRefValue"] as string,
    };
  }
  return undefined;
}

interface RecordedRegistrationBinding {
  readonly registeringInstallationId: string;
  readonly activeCompositionProfile: string;
}

/**
 * The delivery's registration binding as CURRENTLY recorded: the identity
 * minted at registration, replaced by each consumed rebinding migration —
 * the recheck resolves the latest recorded binding, never only the original.
 */
function recordedBindingOf(views: readonly JournalEntryView[]): RecordedRegistrationBinding | undefined {
  const registered = views.find((view) => view.kind === "delivery.registered");
  if (registered === undefined) return undefined;
  let registeringInstallationId = registered.payload["registeringInstallationId"] as string;
  const activeCompositionProfile = registered.payload["activeCompositionProfile"] as string;
  for (const view of views) {
    if (view.kind !== "approval.assertion.consumed") continue;
    const rebound = view.payload["newRegisteringInstallationId"];
    if (typeof rebound === "string" && rebound !== "absent-by-state") {
      registeringInstallationId = rebound;
    }
  }
  return { registeringInstallationId, activeCompositionProfile };
}

/** Every assertion nonce this delivery journal has consumed. */
function consumedAssertionNoncesOf(views: readonly JournalEntryView[]): Set<string> {
  const nonces = new Set<string>();
  for (const view of views) {
    if (view.kind !== "approval.assertion.consumed") continue;
    const assertion = view.payload["assertion"];
    if (typeof assertion === "object" && assertion !== null) {
      const nonce = (assertion as Record<string, unknown>)["nonce"];
      if (typeof nonce === "string") nonces.add(nonce);
    }
  }
  return nonces;
}

/** A consumed waiver, bound to the candidate it was approved against. */
interface LedgerWaiver extends ConsumedWaiver {
  readonly candidateTreeSha: string;
}

interface WaiverLedger {
  /** Proposals still awaiting an approval, oldest first. */
  readonly pending: readonly WaiverProposal[];
  /** Criteria whose waiver was CONSUMED, in journal order. */
  readonly consumed: readonly LedgerWaiver[];
}

/**
 * The waiver ledger, derived from the journal alone — no second authority.
 * A proposal is pending from its `approval.request.recorded` until a waiver
 * consumption answers it or a typed voiding blocker retires it.
 *
 * PAIRING IS FIFO, AND THAT IS THE WHOLE POINT. A consumption's human
 * evaluation is a window in which the journal can grow: the facade reads the
 * pending proposal, discloses its criterion to the operator, and only then
 * appends the consumption. Answering the NEWEST pending proposal would let a
 * proposal appended during that window inherit an approval the operator gave
 * for a different criterion. The oldest pending proposal is fixed before the
 * window opens, so it cannot be displaced; and if the window's appends voided
 * it instead, the consumption answers nothing and no waiver is recorded.
 *
 * The candidate a proposal binds is read the way admission reads it — the
 * last recaptured candidate, falling back to the fence's — so a proposal is
 * never stamped with a tree the checkpoint does not stand on.
 */
function waiverLedgerOf(views: readonly JournalEntryView[]): WaiverLedger {
  const pendingStack: WaiverProposal[] = [];
  const consumed: LedgerWaiver[] = [];
  let fencedCandidate = "";
  let recapturedCandidate: string | undefined;
  for (const view of views) {
    const candidate = recapturedCandidate ?? fencedCandidate;
    switch (view.kind) {
      case "invocation.fenced":
        fencedCandidate = view.payload["candidateTreeSha"] as string;
        break;
      case "candidate.recaptured":
        recapturedCandidate = view.payload["treeSha"] as string;
        break;
      case "approval.request.recorded":
        pendingStack.push({
          requestKind: view.payload["requestKind"] as "waiver" | "amendment",
          criterionId: view.payload["criterionId"] as string,
          actorId: view.payload["actorId"] as string,
          candidateTreeSha: recapturedCandidate ?? fencedCandidate,
        });
        break;
      case "blocker.recorded":
        if (view.payload["code"] === "approval.proposal-voided") pendingStack.shift();
        break;
      case "approval.assertion.consumed": {
        const assertion = view.payload["assertion"] as Record<string, unknown> | undefined;
        const origin = String(assertion?.["origin"] ?? "");
        if (!origin.startsWith(WAIVER_APPROVAL_ORIGIN_PREFIX)) break;
        const answered = pendingStack.shift();
        if (answered !== undefined) {
          consumed.push({
            candidateTreeSha: candidate,
            criterionId: answered.criterionId,
            reference: `${String(assertion?.["action"])} by ${origin.slice(WAIVER_APPROVAL_ORIGIN_PREFIX.length)} (${String(assertion?.["nonce"])})`,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return { pending: pendingStack, consumed };
}

function sensorResultsOf(views: readonly JournalEntryView[]): RecordedSensorResult[] {
  return views
    .filter((view) => view.kind === "operation.result.recorded")
    .map((view) => view.payload["result"] as unknown as RecordedSensorResult & { spec: string });
}

// ── The facade ─────────────────────────────────────────────────────────────

export interface ManagedDeliveryFacade {
  readonly namespaceDir: () => Promise<string>;

  /**
   * The host-native intake entrypoint: opens an iterative intake for an
   * outcome-only work request. The scope workflow the host runs against it
   * executes under the READ-ONLY intake grant minted here — the admission is
   * never mutation-capable, and every delivery-scoped identity is recorded
   * explicitly absent-by-state.
   */
  openIntake(input: {
    readonly workRequest: string;
    readonly observedAt: string;
    readonly attestationExpiry: string;
  }): Promise<
    { readonly ok: true; readonly intakeId: string; readonly grantDigest: string; readonly grantPath: string } | FacadeFailure
  >;

  /** Durably retains one clarification exchange of the scope workflow. */
  recordClarification(input: {
    readonly intakeId: string;
    readonly question: string;
    readonly answer: string;
  }): Promise<{ readonly ok: true } | FacadeFailure>;

  /**
   * Durably retains the current draft contract. A draft recorded after
   * presentation VOIDS the pending confirmation — the operator confirmed
   * different bytes — and a draft recorded while acceptance is blocked
   * returns intake to the confirmation handoff through the frozen chain.
   */
  recordDraft(input: {
    readonly intakeId: string;
    readonly draft: unknown;
  }): Promise<{ readonly ok: true; readonly draftDigest: string } | FacadeFailure>;

  /** Presents the retained draft for the ONE operator confirmation. */
  presentDraft(input: {
    readonly intakeId: string;
    readonly expiry: string;
  }): Promise<
    | { readonly ok: true; readonly nonce: string; readonly normalizedContractDigest: string; readonly channelPath: string }
    | FacadeFailure
  >;

  /**
   * Re-runs acceptance validation after a preflight failure, WITHOUT a new
   * operator confirmation: the journal guarantees the draft cannot have
   * changed since the consumed confirmation, so the confirmation stands.
   */
  retryAcceptance(input: { readonly intakeId: string }): Promise<{ readonly ok: true; readonly deliveryId: string } | FacadeFailure>;

  /**
   * The already-scoped fallback lane: no product-owned intake turn runs, but
   * the frozen chain is identical from the draft record on — contract
   * validation and the operator confirmation are never bypassed.
   */
  presentContract(input: {
    readonly contract: AcceptedContract;
    readonly expiry: string;
  }): Promise<
    | { readonly ok: true; readonly intakeId: string; readonly nonce: string; readonly normalizedContractDigest: string; readonly channelPath: string }
    | FacadeFailure
  >;

  /**
   * Consumes the operator confirmation at the EXIT of awaiting_confirmation,
   * runs acceptance validation in validating_acceptance, and — only when it
   * passes — completes registration at accepted_contract, on the facade side,
   * outside intake's capability set. A preflight failure blocks the intake
   * with the consumed confirmation intact for `retryAcceptance`.
   */
  confirmContract(input: {
    readonly intakeId: string;
    readonly echo: ConfirmationEchoAttempt;
  }): Promise<{ readonly ok: true; readonly deliveryId: string } | FacadeFailure>;

  bindWorkspace(input: {
    readonly deliveryId: string;
    readonly worktreeDir: string;
    readonly hostTaskId: string;
    readonly observedAt: string;
    readonly attestationExpiry: string;
    readonly observationLifetimeSeconds?: number;
    /** Root proof created and retained by the operator-owned host. */
    readonly providerReviewBindingCapability: ProviderReviewCapability;
  }): Promise<
    | {
        readonly ok: true;
        readonly fence: number;
        readonly workspaceId: string;
        readonly statePath: string;
        readonly settingsPath: string;
        readonly cliArgs: readonly string[];
        readonly projectionDigest: string;
      }
    | FacadeFailure
  >;

  /**
   * The one typed status model. Every operator-facing surface renders this
   * result without re-deriving anything from the journal, so the CLI, the MCP
   * tool, and any later projection cannot disagree about whether a delivery may
   * be resumed, migrated, or retried.
   *
   * Host disappearance is reported LAZILY and here: a graceful lifecycle event
   * reports `paused`, while an activity observation aged past the fence's
   * declared lifetime reports `unknown` on this observation. Timeout never
   * proves termination.
   */
  status(input: { readonly deliveryId: string; readonly observedAt: string }): Promise<
    { readonly ok: true; readonly status: ManagedDeliveryStatus } | FacadeFailure
  >;

  /**
   * The INSTALLATION-SCOPED listing mode of the same status surface: every
   * delivery this installation registered, four members each.
   *
   * WHY THIS IS A MODE AND NOT A DASHBOARD. `status` answers about one
   * delivery a caller already knows the id of. Nothing answered "what is
   * running across this installation right now", and the caller that needs it
   * has no delivery id to ask with — so it cannot be a member of the
   * per-delivery model, and the per-delivery model is unchanged by it. What it
   * returns stays deliberately four members wide (`ListedDelivery`); every
   * further question has a delivery id by then and belongs to `status`.
   *
   * LIVENESS IS THE SAME GRADED RULE. Each listed delivery's activity comes
   * from `gradeHostActivity` in ./liveness.ts, the function `status` calls,
   * resolved lazily on this read. There is no heartbeat of its own and no
   * polling: listing reads what the binding already stamped.
   *
   * READ-CLASS AND INSTALLATION-SCOPED. It writes nothing, advances no
   * journal revision, binds no fence, and enumerates only this installation's
   * own namespace directory — a delivery registered by another installation
   * has no path into this result.
   *
   * `unreadable` NAMES WHAT IT COULD NOT LIST, rather than dropping it. A
   * directory with no registration record, one whose journal does not reduce,
   * or one whose durable binding records disagree with this facade's — the
   * precondition `status` refuses on — has no state this surface may report — but this is the only installation-wide
   * surface an operator has, and a delivery that silently vanishes from it is
   * worse than one reported as unreadable: the CLI's own delivery resolution
   * counts that same directory as in flight, so a silent omission leaves two
   * surfaces contradicting each other with no id to reconcile them by. The id
   * is returned here; `status` with that id gives the refusal and says why.
   */
  listDeliveries(input: { readonly observedAt: string }): Promise<
    | {
        readonly ok: true;
        readonly deliveries: readonly ListedDelivery[];
        /** Delivery ids present in the namespace that have no state to report. */
        readonly unreadable: readonly string[];
      }
    | FacadeFailure
  >;

  nextCheckpoint(input: { readonly deliveryId: string }): Promise<{ readonly ok: true; readonly checkpoint: ManagedCheckpoint } | FacadeFailure>;

  submitStageResult(input: {
    readonly deliveryId: string;
    readonly stageId: "plan" | "compound";
    readonly resultBytes: string;
    /** The fence the invoking task was bound under; an older fence's output is permanently rejected, and omitting it fails closed. */
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  checkpointCandidate(input: {
    readonly deliveryId: string;
    readonly resultBytes: string;
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState; readonly treeSha: string } | FacadeFailure>;

  runSensor(input: { readonly deliveryId: string; readonly fence: number }): Promise<
    { readonly ok: true; readonly outcome: "passed" | "failed"; readonly state: DeliveryState } | FacadeFailure
  >;

  /** Prepares one exact reviewer invocation after proving the standing binding. */
  prepareProviderReviewHandoff(input: {
    readonly deliveryId: string;
    readonly expectedFence: number;
    readonly expectedWorkspaceId: string;
    readonly nativeSessionId: string;
    readonly nativeRunId: string;
    readonly finalPassId: string;
    readonly lensId: string;
    /** Host-created snapshot outside model/reviewer writable roots; the trusted host owns its lifecycle. */
    readonly reviewWorkspaceDir: string;
    /** Instructions joined with trusted persona, contract, and sensor bytes by the binding. */
    readonly reviewInstructionsBytes: string;
    readonly bindingCapability: ProviderReviewCapability;
    readonly invocationCapability: ProviderReviewCapability;
  }): Promise<{ readonly ok: true; readonly handoff: ProviderReviewHandoff; readonly handoffPath: string } | FacadeFailure>;

  /** Accepts one native result only with the invocation proof retained by its host. */
  ingestProviderReviewResult(input: {
    readonly deliveryId: string;
    readonly handoffId: string;
    readonly resultBytes: string;
    readonly fence: number;
    readonly invocationCapability: ProviderReviewCapability;
  }): Promise<
    | {
        readonly ok: true;
        readonly replay: "recorded" | "identical";
        readonly disposition: "approved" | "changes_requested";
      }
    | FacadeFailure
  >;

  reduceReview(input: { readonly deliveryId: string; readonly fence: number }): Promise<
    { readonly ok: true; readonly state: DeliveryState } | FacadeFailure
  >;

  admit(input: {
    readonly deliveryId: string;
    readonly recordedAtInstant: string;
    readonly env: EnvSnapshot;
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  prepareTrackedRecord(input: {
    readonly deliveryId: string;
    readonly env: EnvSnapshot;
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly relativePath: string } | FacadeFailure>;

  confirmTrackedRecord(input: { readonly deliveryId: string; readonly fence: number }): Promise<
    { readonly ok: true; readonly state: DeliveryState } | FacadeFailure
  >;

  completeFinishLine(input: { readonly deliveryId: string; readonly fence: number }): Promise<
    { readonly ok: true; readonly state: DeliveryState; readonly resultDigest: string } | FacadeFailure
  >;

  sessionEnded(input: { readonly deliveryId: string; readonly fence: number }): Promise<{ readonly ok: true } | FacadeFailure>;

  /**
   * TERMINATION PROVENANCE, and the only door it enters through. The caller is
   * the trusted host-runtime lifecycle integration — never a model-callable
   * tool — reporting that an invocation ended cleanly.
   *
   * The caller reports only THAT, and nothing else. Whether the clean end also
   * proves the invocation's descendants are gone is not a claim any caller may
   * make: the descendant-teardown status is read from the graded capability
   * record inside the pinned generation — whose digest closure is verified on
   * every guarded call — and the resume position is derived from it here. No
   * argument to this operation, and nothing a session writes into the binding
   * state file, can widen it.
   *
   * What this does NOT defend is the delivery journal itself. On a host with no
   * protected common-Git authority path, a granted shell capability writes the
   * journal directly, and the payload grammar only enforces a record's internal
   * consistency. Closing that belongs to the host's own sandbox, not to this
   * operation. Every graded host states its own position on that path rather
   * than leaving it absent: the record carries
   * `commonGitAuthorityPathProtected` as `supported` for Codex's OS sandbox and
   * as `unsupported` for Claude Code, whose ordinary stage sessions hold the
   * shell capability the shipped mutation-stage grant allows.
   *
   * Crash provenance has no entrypoint at all: no supported host supplies it,
   * no daemon exists to observe it, and the product never infers it.
   */
  recordTerminationProvenance(input: { readonly deliveryId: string; readonly fence: number }): Promise<
    | {
        readonly ok: true;
        readonly descendantTeardown: "verified" | "unverified";
        readonly resumeEligibility: "same-workspace" | "fresh-worktree-only";
      }
    | FacadeFailure
  >;

  /**
   * Tears the run-pinned projection and the binding-written discovery
   * configuration down with the worktree, so nothing the binding wrote
   * outlives the workspace it was scoped to.
   */
  tearDownWorkspaceProjection(input: { readonly deliveryId: string }): Promise<{ readonly ok: true } | FacadeFailure>;

  /**
   * A waiver or contract-amendment proposal: journaled with a pending marker
   * while the delivery remains in its current state. Consumption belongs to
   * the sensitive-approval lane (its journal kind stays reserved here); a
   * candidate change since proposal voids the stale proposal with a typed
   * blocker record.
   */
  recordApprovalRequest(input: {
    readonly deliveryId: string;
    readonly requestKind: "waiver" | "amendment";
    readonly criterionId: string;
    readonly actorId: string;
    readonly reason: string;
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  /**
   * The waiver's approval half, and the ONLY way a proposal becomes valid.
   * One fresh model-external interactive evaluation from the installation's
   * configured assertion source is consumed as a delivery-bound sensitive
   * approval against the pending proposal: an approver who is the proposer is
   * refused, a proposal made against a superseded candidate voids, and an
   * expired or replayed evaluation is refused.
   *
   * `outcomeChanging` selects the approving action, and only a
   * policy-declared outcome authority may take it. A confirmed amendment
   * creates a NEW contract identity and forces full re-evaluation — which is
   * why it is not consumable at `admitting`: there is no review left to
   * re-open from there.
   */
  consumeWaiver(input: {
    readonly deliveryId: string;
    /** The approving identity; never the proposing actor. */
    readonly approverId: string;
    readonly outcomeChanging: boolean;
    readonly fence: number;
    /** The consumption instant; the facade never consults a clock itself. */
    readonly now: string;
    readonly assertionSource?: AssertionSourcePort;
  }): Promise<
    | {
        readonly ok: true;
        readonly criterionId: string;
        readonly outcomeChanging: boolean;
        readonly contractId: string;
        readonly state: DeliveryState;
      }
    | FacadeFailure
  >;

  /**
   * The blocker/remediation inventory: every blocker this delivery journaled,
   * its declared remediation, and whether the delivery left the suspended
   * state it caused. This is the audit surface for review loops — the current
   * state says only where the delivery is now.
   */
  blockerInventory(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly entries: readonly BlockerInventoryEntry[] } | FacadeFailure
  >;

  /**
   * Cancellation, first half: enter `cancellation_requested`, revoke the
   * invocation fence for the model-external interceptor, and request native
   * host cancellation (fence-revocation-only on hosts without a trusted
   * cancellation acknowledgement). The delivery is NOT terminal yet.
   */
  requestCancellation(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly state: DeliveryState } | FacadeFailure
  >;

  /**
   * Cancellation, second half: terminal `cancelled` through permanent
   * quarantine of the prior workspace and preservation of the last trusted
   * candidate. This path never claims that the prior task or its descendants
   * terminated.
   */
  finalizeCancellation(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly state: DeliveryState } | FacadeFailure
  >;

  /** Export the delivery's durable detail to an owned namespace path; journaled to the maintenance journal. */
  exportDelivery(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly exportPath: string; readonly artifactDigest: string } | FacadeFailure
  >;

  /**
   * Delete a TERMINAL delivery's durable detail, preserving the minimum
   * candidate/policy/evidence/action audit record first. The maintenance
   * journal record survives the target's removal and reports what was
   * preserved.
   */
  deleteDelivery(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly preservedAuditRecords: readonly string[] } | FacadeFailure
  >;

  presentTakeover(input: {
    readonly deliveryId: string;
    readonly expiry: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly nonce: string;
        readonly channelPath: string;
        readonly supersededFence: number;
        readonly expectedJournalRevision: number;
        readonly targetBaseCommit: string;
        readonly takeoverBranchRef: string;
      }
    | FacadeFailure
  >;

  confirmTakeover(input: {
    readonly deliveryId: string;
    readonly echo: ConfirmationEchoAttempt;
  }): Promise<
    { readonly ok: true; readonly targetBaseCommit: string; readonly takeoverBranchRef: string } | FacadeFailure
  >;

  /**
   * Turns the binding's own observation into a durable entry in the shadow
   * milestone's gate-record artifact.
   *
   * The caller names the delivery and baseline category — never the target or
   * observation. The target is the canonical gate-record path under the
   * facade's protected repository root, and the expected repository identity
   * comes from the accepted delivery contract. The delivery and fence the
   * record binds come from the binding's own workspace record,
   * and the record's contents are re-derived from the materialization receipt,
   * the marker in the worktree, and the model-external interceptor's record of
   * this run's invocations, so no caller can assert what the binding did not
   * observe. When it did not, nothing is written and the delivery stays out of
   * the comparison set.
   *
    * WHAT AN EMITTED ENTRY CERTIFIES: that the qualified host emitted a
    * PostToolUse event for this run's completed exact Read of the receipted
    * canonical workflow source. Reads outside that qualified surface are not
    * observed at all — such a delivery is excluded rather than affirmed.
   */
  recordProjectionConsumption(input: {
    readonly deliveryId: string;
    readonly category: string;
  }): Promise<
    | { readonly ok: true; readonly emitted: true; readonly projectionDigest: string }
    | { readonly ok: true; readonly emitted: false; readonly reason: ProjectionConsumptionUnobserved }
    | FacadeFailure
  >;

  explainBlocker(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly blocker: { readonly code: string; readonly summary: string; readonly remediation: string } | undefined } | FacadeFailure
  >;

  /**
   * The maintenance-lane exit from `security_blocked`. Always: current local
   * trust state, full re-preparation, and invalidation of revoked-era
   * candidate-bound evidence. When the generation changed or the delivery is
   * being rebound to a different registering installation, additionally
   * consumes the security-blocked migration assertion — without re-fencing.
   */
  /**
   * The installation-scoped maintenance lane, reached through the one facade
   * rather than through a second entrypoint. Each of these consumes a
   * maintenance-lane sensitive assertion bound to the target installation and
   * generation identities — not to a delivery, candidate, or fence — and each
   * fails closed when no assertion source can evaluate one. They write the
   * installation's maintenance journal, never a delivery journal, so no
   * delivery's expected revision moves.
   *
   * The generation of every paused delivery is retained across an update: the
   * pin lives in each delivery's own record, and updating the installation
   * neither reads nor rewrites it.
   */
  updateComposition(input: Omit<UpdateCompositionInput, "installationPath" | "receiptDir">): Promise<
    { readonly ok: true; readonly generationDigest: string; readonly priorGenerationDigest: string; readonly noOp: boolean } | FacadeFailure
  >;

  /** Restores a previously accepted, still-eligible generation. A revoked one can never be restored. */
  rollbackComposition(input: {
    readonly targetGenerationDigest: string;
    readonly assertionSource?: AssertionSourcePort;
    readonly now: string;
  }): Promise<{ readonly ok: true; readonly generationDigest: string } | FacadeFailure>;

  /** Pin, revoke, un-revoke, or advance the trust high-water mark. */
  maintainTrustState(
    input: { readonly assertionSource?: AssertionSourcePort; readonly now: string } & (
      | { readonly operation: "pin" | "revoke" | "unrevoke"; readonly generationDigest: string }
      | { readonly operation: "advance-high-water-mark"; readonly highWaterMark: number }
    ),
  ): Promise<{ readonly ok: true; readonly state: ProductTrustState } | FacadeFailure>;

  recoverSecurityBlocked(input: {
    readonly deliveryId: string;
    /** Defaults to the delivery's recorded generation pin. */
    readonly targetGenerationDigest?: string;
    readonly assertionSource?: AssertionSourcePort;
    /** The consumption instant; the facade never consults a clock itself. */
    readonly now: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly mode: "re-preparation" | "generation-change-migration" | "rebinding-migration";
        readonly state: DeliveryState;
      }
    | FacadeFailure
  >;
}

export type { ManagedCheckpoint } from "./status.ts";

/**
 * Voids the attestation in every binding state file for a fence BELOW the
 * given one. A superseded session's hook keeps reading its own fence-scoped
 * file, and an attestation of `null` is the frozen deny-until-attested case,
 * so the predecessor's tools close on its very next invocation without any
 * callback plumbing. Passing an infinite fence voids every invocation, which
 * is what cancellation wants.
 */
async function voidSupersededBindingStates(bindingDir: string, currentFence: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(bindingDir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^state-(\d+)\.json$/.exec(name);
    if (match === null) continue;
    if (Number.parseInt(match[1] as string, 10) >= currentFence) continue;
    const statePath = path.join(bindingDir, name);
    const state = await readJson<Record<string, unknown>>(statePath);
    if (state === undefined || state["attestation"] === null) continue;
    await writeOwned(statePath, `${JSON.stringify({ ...state, attestation: null })}\n`);
  }
}

export function createManagedDeliveryFacade(input: CreateFacadeInput): ManagedDeliveryFacade {
  const policyBinding = input.policyBinding;
  const compiledPolicy = policyBinding.compiledPolicy;
  if (compiledPolicy.admission === undefined) {
    throw new Error("the adopter's compiled repository policy has no admission projection");
  }
  const policyVerdict = verifyCompiledPolicy(compiledPolicy);
  if (!policyVerdict.ok) {
    throw new Error(`the adopter's compiled repository policy is invalid: ${policyVerdict.rejections.map((rejection) => rejection.message).join("; ")}`);
  }
  const admissionVerdict = validateHarnessConfig(compiledPolicy.admission);
  if (!admissionVerdict.ok) {
    throw new Error(`the adopter's compiled admission projection is invalid: ${admissionVerdict.blockers.map((blocker) => blocker.summary).join("; ")}`);
  }
  const stageGrants = new Map(compiledPolicy.checkpointGrants.map((entry) => [entry.stageId, entry.grant]));
  const stageGrant = stageGrants.get("plan");
  if (stageGrant === undefined || !["implement", "compound"].every((stageId) => stageGrants.has(stageId))) {
    throw new Error("the adopter's compiled repository policy must grant plan, implement, and compound checkpoints");
  }
  const stageGrantDigest = digestCanonical(stageGrant);
  if (["implement", "compound"].some((stageId) => digestCanonical(stageGrants.get(stageId)) !== stageGrantDigest)) {
    throw new Error("the facade requires one shared checkpoint grant across model-driven stages");
  }
  const invalidGrant = ["plan", "implement", "compound"].find((stageId) => {
    const grant = stageGrants.get(stageId);
    const verdict = validateExecutionGrant(grant);
    return !verdict.ok || grant?.profile !== "checkpoint";
  });
  if (invalidGrant !== undefined) {
    throw new Error("the adopter's model-driven checkpoint grant is invalid");
  }
  const sensorCapability = compiledPolicy.capabilities.find(
    (capability) => capability.capabilityId === policyBinding.sensor.capabilityId && capability.kind === "sensor",
  );
  if (sensorCapability === undefined || sensorCapability.resultSpec !== "sensor-result/1") {
    throw new Error("the adopter's trusted sensor binding is not present in the compiled policy");
  }
  if (path.isAbsolute(policyBinding.sensor.trustedBasePath) || policyBinding.sensor.trustedBasePath.split("/").includes("..")) {
    throw new Error("the adopter's trusted sensor binding must be a repository-relative path");
  }
  for (const lens of compiledPolicy.snapshot.reviewLenses) {
    const source = policyBinding.personaSources[lens.personaId];
    if (source === undefined || source.digest !== sha256Hex(source.bytes) || source.digest !== lens.personaDigest) {
      throw new Error(`the adopter's resolved persona bytes do not match ${lens.personaId}`);
    }
    if (source.origin === "repository" && (path.isAbsolute(source.trustedBasePath) || source.trustedBasePath.split("/").includes(".."))) {
      throw new Error(`the repository persona source for ${lens.personaId} must be a repository-relative path`);
    }
  }
  const config = admissionVerdict.config;
  const policy = compiledPolicy.snapshot;
  const policyBindingDigest = compiledAdopterPolicyBindingDigest(policyBinding);
  const checkpointGrantFor = (stageId: string) => {
    const grant = stageGrants.get(stageId);
    if (grant === undefined) throw new Error(`the adopter's compiled repository policy has no ${stageId} checkpoint grant`);
    return grant;
  };
  const checkpointGrantDigestFor = (stageId: string): string => digestCanonical(checkpointGrantFor(stageId));
  // Workspace admission is established before the first model-driven stage;
  // later checkpoints advertise their own policy grant in `next`.
  const exec = input.exec ?? createExecPort();
  const hostBinding = input.hostBinding ?? DEFAULT_HOST_BINDING;

  const git = async (cwd: string, ...args: string[]): Promise<{ code: number; out: string }> => {
    const outcome = await exec.run({ command: "git", args, cwd });
    return { code: outcome.code, out: outcome.stdout.trim() };
  };

  /**
   * The committed tree's entries — path, mode, and, for a delivery-owned
   * symlink, the target read untrimmed out of its own blob — for the
   * protected-authority-path rule. `undefined` when the tree could not be
   * listed, which the two call sites read differently: the verification
   * checkpoint reports the external verification unavailable rather than
   * passed, while the recording checkpoint — which listed the commit it has
   * just written — treats it as no entries, exactly as it did before this
   * helper existed. The pull-request Action still fails closed on an
   * unlistable head, so the enforcement point is unaffected either way.
   *
   * `-z`, never newline splitting: git quotes a path containing a newline, and
   * the quoted form no longer starts with the prefix it is inside. The blob is
   * read without trimming because a symlink's target is exactly its blob's
   * bytes, and trimming would let a target the external verifiers reject read
   * as one they admit.
   */
  const candidateTreeEntries = async (cwd: string): Promise<CandidateTreeEntry[] | undefined> => {
    const listed = await exec.run({ command: "git", args: ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], cwd });
    if (listed.code !== 0) return undefined;
    const entries: CandidateTreeEntry[] = [];
    for (const entry of parseCandidateTreeListing(listed.stdout)) {
      if (!needsCommittedSymlinkTarget(entry)) {
        entries.push(entry);
        continue;
      }
      const blob = await exec.run({ command: "git", args: ["cat-file", "blob", entry.objectSha], cwd });
      entries.push(blob.code === 0 ? { ...entry, symlinkTarget: blob.stdout } : entry);
    }
    return entries;
  };

  /**
   * The evidence kernel's capture/activation git plumbing, routed through the
   * SAME exec port as every other product launch — the inventory the negative
   * process sensor asserts is complete only because nothing bypasses the
   * port. The kernel's scrubbed-environment semantics are preserved: the
   * whole GIT_ namespace is dropped and prompts/optional locks are disabled,
   * exactly as the kernel's own default runner does.
   */
  const candidateRunner: CandidateCommandRunner = async (command, options) => {
    const [executable, ...args] = command;
    if (executable === undefined) return { exitCode: -1, stdout: "", stderr: "no command was given" };
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith("GIT_") || value === undefined) continue;
      environment[name] = value;
    }
    const outcome = await exec.run({
      command: executable,
      args,
      cwd: options.cwd,
      env: { ...environment, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    return { exitCode: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr };
  };

  /**
   * The record-storage flavor of the same rule: every `RecordStorageOptions`
   * consumer the facade drives (store resolution, receipts, submission,
   * admission, record discovery) resolves git through the port. Throws on a
   * non-zero exit, exactly like the kernel's default runner.
   */
  const storageGitRunner = async (cwd: string, args: readonly string[]): Promise<string> => {
    const outcome = await exec.run({ command: "git", args: [...args], cwd });
    if (outcome.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${outcome.code}): ${outcome.stderr.trim()}`);
    }
    return outcome.stdout.trim();
  };

  // Candidate capture uses `git write-tree` to include a staged candidate.
  // Serialize only the two read/capture brackets for concurrent native
  // callbacks so they cannot contend on one linked worktree index; durable
  // acceptance still races at the guarded journal CAS below.
  let providerCaptureQueue: Promise<void> = Promise.resolve();
  const captureProviderPair = async (mutableRoot: string, reviewRoot: string) => {
    let release!: () => void;
    const prior = providerCaptureQueue;
    providerCaptureQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      const mutable = await captureFor(mutableRoot, config, candidateRunner, storageGitRunner);
      if (!mutable.ok) return { ok: false as const, failure: mutable.failure };
      const review = await captureFor(reviewRoot, config, candidateRunner, storageGitRunner);
      if (!review.ok) return { ok: false as const, failure: review.failure };
      return { ok: true as const, mutable: mutable.candidate, review: review.candidate };
    } finally {
      release();
    }
  };

  let namespaceDirCache: string | undefined;
  const namespaceDir = async (): Promise<string> => {
    if (namespaceDirCache !== undefined) return namespaceDirCache;
    // The SAME resolver the run store uses, driven by the facade's injected
    // exec port and given no environment override — so this stays exactly the
    // one launch the process inventory has always recorded.
    const resolved = await resolveCommonDirectoryNamespace({
      cwd: input.repoDir,
      run: async ({ cwd, args }) => {
        const outcome = await exec.run({ command: "git", args: [...args], cwd });
        return { code: outcome.code, stdout: outcome.stdout };
      },
    });
    if (!resolved.ok) throw new Error(resolved.reason);
    namespaceDirCache = resolved.namespaceDir;
    return namespaceDirCache;
  };

  const deliveryDir = async (deliveryId: string): Promise<string> => path.join(await namespaceDir(), "deliveries", deliveryId);
  const providerAuthorityDir = (deliveryId: string): string =>
    path.join(input.installation.installationPath, "provider-review-authority", "deliveries", deliveryId);
  const providerAuthorityStatePath = (deliveryId: string): string => path.join(providerAuthorityDir(deliveryId), "workspace.json");
  const providerHandoffAuthorityPath = (deliveryId: string, handoffId: string): string =>
    path.join(providerAuthorityDir(deliveryId), "handoffs", `${handoffId}.json`);
  const journalStoreFor = async (deliveryId: string): Promise<JournalStore> =>
    createJournalStore(path.join(await deliveryDir(deliveryId), "journal.jsonl"));
  const confirmationPath = (nonce: string): string => path.join(input.installation.installationPath, "confirmations", `${nonce}.json`);

  const readTrust = async (): Promise<ProductTrustState | undefined> => {
    try {
      const parsed = parseTrustState(await readFile(trustStorePathFor(input.installation.installationPath), "utf8"));
      return parsed.ok ? parsed.state : undefined;
    } catch {
      return undefined;
    }
  };

  const appendEntry = async (
    store: JournalStore,
    deliveryId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | FacadeFailure> => {
    const read = await store.read();
    if (!read.ok) return refuse("journal_unreadable", "The delivery journal is unreadable.", "Inspect the durable journal file.");
    let expectedRevision = 0;
    if (read.entries.length > 0) {
      const reduced = await store.state();
      if (!reduced.ok) {
        return refuse("journal_rejected", "The durable journal does not reduce.", "Inspect the durable journal file.");
      }
      expectedRevision = reduced.state.expectedRevision;
    }
    const appended = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: deliveryId,
      expectedRevision,
      idempotencyKey: `e${read.entries.length}-${kind}`,
      kind,
      payload,
    });
    if (!appended.ok) {
      return refuse(
        "journal_rejected",
        `The frozen journal reducer refused a ${kind} append: ${appended.rejections.map((rejection) => rejection.message).join("; ")}`,
        "The refused entry is reported verbatim; correct the calling state.",
      );
    }
    return { ok: true };
  };

  const recordBlockerAndTransition = async (
    store: JournalStore,
    deliveryId: string,
    fromState: DeliveryState,
    code: string,
    summary: string,
    to: "blocked" | "security_blocked",
  ): Promise<void> => {
    await appendEntry(store, deliveryId, "blocker.recorded", { code, summary });
    await appendEntry(store, deliveryId, "transition.committed", { from: fromState, to });
  };

  interface GuardedContext {
    readonly store: JournalStore;
    readonly meta: DeliveryMeta;
    readonly state: DeliveryState;
    readonly lastActiveState: DeliveryState;
    readonly expectedRevision: number;
    readonly lastFence: number;
    readonly views: readonly JournalEntryView[];
    readonly workspace: WorkspaceMeta | undefined;
    readonly generationRoot: string;
    /** The gathered observations, reusable by consumption-substituted rechecks. */
    readonly recheckValues: RecheckValues;
  }

  /**
   * THE CANONICAL RECHECK every mutation-capable operation runs, routed
   * through the single substitution-aware helper: product trust, the
   * repository authority-revocation epoch, the invocation fence, the
   * registering installation identity and active profile, and the projection
   * and discovery-configuration digests. The helper decides; this function
   * gathers observations and maps failures onto the typed blocker/transition
   * behavior — trust and installation failures fence into `security_blocked`,
   * authority and workspace-integrity failures block, and a stale invoking
   * fence is permanently refused without touching the journal.
   */
  const guard = async (
    deliveryId: string,
    options: {
      readonly requireState?: readonly DeliveryState[];
      readonly verifyWorkspace?: boolean;
      /** Only the takeover rebind consumes a pending authorization. */
      readonly allowPendingTakeover?: boolean;
      /** The invoking task's claimed fence; an older fence is permanently rejected. */
      readonly invokingFence?: number;
      /** Fence-carrying operations fail closed when no fence is presented. */
      readonly fenceRequired?: boolean;
    } = {},
  ): Promise<GuardedContext | FacadeFailure> => {
    const dir = await deliveryDir(deliveryId);
    const meta = await readJson<DeliveryMeta>(path.join(dir, "delivery.json"));
    if (meta === undefined) {
      return refuse("unknown_delivery", `No registered delivery ${deliveryId}.`, "Register a delivery through the contract handoff first.");
    }
    // A consumed takeover authorization quarantines the prior workspace; no
    // checkpoint operation runs until the authorized fresh worktree is bound.
    // A superseded-but-still-running task keeps no write path this way.
    if (options.allowPendingTakeover !== true && (await readJson<PendingTakeover>(path.join(dir, "takeover.json"))) !== undefined) {
      return refuse(
        "takeover_pending",
        "A consumed takeover authorization is pending; the quarantined workspace accepts no further checkpoints.",
        "Bind the fresh worktree the takeover authorized, then continue from the last trustworthy checkpoint.",
      );
    }
    const store = await journalStoreFor(deliveryId);
    const reduced = await store.state();
    if (!reduced.ok) {
      return refuse("journal_rejected", "The durable journal does not reduce.", "Inspect the durable journal file.");
    }
    const read = await store.read();
    if (!read.ok) return refuse("journal_unreadable", "The delivery journal is unreadable.", "Inspect the durable journal file.");
    const views = viewsOf(read.entries);
    const recordedPolicyBindingDigest = reduced.state.policyBindingDigest;
    if (
      meta.policyBindingDigest !== policyBindingDigest ||
      recordedPolicyBindingDigest !== policyBindingDigest ||
      meta.policyBindingDigest !== recordedPolicyBindingDigest
    ) {
      return refuse(
        "policy_binding_mismatch",
        "The current compiled adopter policy binding does not match this delivery's recorded binding.",
        "Use the exact binding captured at registration; drift requires a new owner-approved delivery.",
      );
    }
    const workspace = await readJson<WorkspaceMeta>(path.join(dir, "workspace.json"));

    const pinned = reduced.state.generationDigest;
    if (pinned === undefined) {
      return refuse("unregistered", "The delivery has no pinned generation.", "Register the delivery first.");
    }

    // ── Gather the frozen rechecked-value observations ──
    // Product trust at the pinned generation, resolved only from the
    // installation store — planted repository-local trust files are ignored
    // by construction.
    const generation = await loadPinnedGeneration({
      installationPath: input.installation.installationPath,
      generationDigest: pinned,
    });
    const trustCheck: ValueCheck = generation.ok
      ? { kind: "eligible", ok: true }
      : {
          kind: "eligible",
          ok: false,
          detail: generation.blockers.map((blocker) => blocker.message).join("; ").slice(0, 1900),
        };

    // The recheck resolves the LATEST recorded binding, so a consumed
    // rebinding migration moves service to the new installation and away
    // from the old one.
    const recordedBinding = recordedBindingOf(views);
    const binding = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    const installationCheck: CompareCheck = {
      kind: "compare",
      expected: recordedBinding?.registeringInstallationId ?? "recorded-installation",
      observed: binding.ok ? binding.registeringInstallationId : "unresolved-installation",
    };
    const profileCheck: CompareCheck = {
      kind: "compare",
      expected: recordedBinding?.activeCompositionProfile ?? "recorded-profile",
      observed: binding.ok ? binding.activeCompositionProfile : "unresolved-profile",
    };

    const epochCheck: ValueCheck =
      reduced.state.authorityEpoch === undefined
        ? "absent-by-state"
        : { kind: "compare", expected: reduced.state.authorityEpoch, observed: meta.policy.repositoryAuthorityRevocationEpoch };

    if (options.fenceRequired === true && options.invokingFence === undefined) {
      // A fence-carrying operation records host-task output; without the
      // invoking fence the canonical recheck would be vacuous, so it fails
      // closed instead.
      return refuse(
        "missing_fence",
        "This operation records host-task output and presented no invocation fence.",
        "Present the fence the invocation was bound under; only the currently fenced invocation may record outputs.",
      );
    }
    const fenceCheck: ValueCheck = {
      kind: "compare",
      expected: reduced.state.lastFence,
      observed: options.invokingFence ?? reduced.state.lastFence,
    };

    let projectionCheck: ValueCheck = "absent-by-state";
    let discoveryCheck: ValueCheck = "absent-by-state";
    if (options.verifyWorkspace === true && workspace !== undefined) {
      // A vanished workspace is a typed refusal, not a mismatch: the delivery
      // itself is unharmed and resumes through an authorized takeover.
      try {
        await stat(workspace.worktreeDir);
      } catch {
        return refuse(
          "workspace_missing",
          "The bound worktree no longer exists on disk.",
          "Resume through an operator-authorized takeover into a fresh host-created worktree.",
        );
      }
      const projection = await verifyProjection({
        worktreeDir: workspace.worktreeDir,
        bindingDir: path.join(dir, "binding"),
      });
      projectionCheck = {
        kind: "compare",
        expected: workspace.projectionDigest,
        observed: projection.ok
          ? projection.projectionDigest
          : `unverifiable: ${projection.blockers.map((blocker) => blocker.message).join("; ")}`.slice(0, 1900),
      };
      discoveryCheck = {
        kind: "compare",
        expected: workspace.discoveryConfigurationDigest,
        observed:
          (await hostBinding.recomputeDiscoveryConfigurationDigest({
            admissionConfigurationPath: workspace.settingsPath,
            bindingDir: path.join(dir, "binding"),
          })) ?? "unreadable-discovery-configuration",
      };

    }

    const recheckValues: RecheckValues = {
      "product-trust": trustCheck,
      "repository-authority-epoch": epochCheck,
      "invocation-fence": fenceCheck,
      "registering-installation-id": installationCheck,
      "active-profile": profileCheck,
      "projection-digest": projectionCheck,
      "discovery-configuration-digest": discoveryCheck,
    };
    const recheck = evaluateCanonicalRecheck({ consumption: { kind: "standard" }, values: recheckValues });
    if (!recheck.ok) {
      const failure = recheck.failures[0];
      if (failure === undefined) {
        return refuse("recheck_failed", "The canonical recheck failed without a named value.", "Inspect the durable journal file.");
      }
      switch (failure.value) {
        case "product-trust": {
          if (reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(store, deliveryId, reduced.state.state, "trust.generation-ineligible", failure.message.slice(0, 1900), "security_blocked");
          }
          return refuse(
            "trust_ineligible",
            "The pinned generation is no longer execution-eligible under current local trust state.",
            "Restore local trust state through the operator maintenance lane.",
          );
        }
        case "registering-installation-id":
        case "active-profile": {
          if (reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(
              store,
              deliveryId,
              reduced.state.state,
              "trust.installation-mismatch",
              "the registering installation identity or active profile no longer matches this installation",
              "security_blocked",
            );
          }
          return refuse(
            "installation_mismatch",
            "This delivery is bound to a different registering installation or profile.",
            "Rebinding a delivery is an explicit migration, not an ambient adoption.",
          );
        }
        case "repository-authority-epoch": {
          if (reduced.state.state !== "blocked" && reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(store, deliveryId, reduced.state.state, "authority.epoch-changed", failure.message.slice(0, 1900), "blocked");
          }
          return refuse(
            "authority_epoch_changed",
            "The repository authority-revocation epoch changed; the delivery returns to policy evaluation.",
            "Re-evaluate under the current compiled policy before continuing.",
          );
        }
        case "invocation-fence": {
          // Outputs from an older fence are PERMANENTLY rejected; the journal
          // is untouched and the delivery itself is unharmed.
          return refuse(
            "stale_fence",
            `The invocation fence ${String(options.invokingFence)} is not the current fence ${reduced.state.lastFence}; outputs from an older fence are permanently rejected.`,
            "Only the currently fenced invocation may record outputs; resume through an authorized takeover.",
          );
        }
        case "discovery-configuration-digest": {
          if (reduced.state.state !== "blocked" && reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(store, deliveryId, reduced.state.state, "discovery.configuration-tampered", failure.message.slice(0, 1900), "blocked");
          }
          return refuse(
            "discovery_configuration_tampered",
            "The binding-written host discovery configuration no longer matches its application digest.",
            "Quarantine the workspace and resume through an authorized takeover.",
          );
        }
        default: {
          if (reduced.state.state !== "blocked" && reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(store, deliveryId, reduced.state.state, "projection.tampered", failure.message.slice(0, 1900), "blocked");
          }
          return refuse(
            "projection_tampered",
            "The receipted projection subtree no longer matches its materialization digest.",
            "Quarantine the workspace and resume through an authorized takeover.",
          );
        }
      }
    }

    // The consumption marker's READ-BACK half, AFTER the canonical recheck so
    // it never preempts a frozen recheck verdict.
    //
    // The receipt digest already covers these bytes, and on an untampered
    // workspace the two checks agree by construction — the marker is a
    // receipted entry and the fence only advances through a re-materializing
    // rebind. What the marker adds is a SECOND, differently-keyed statement of
    // which run injected the projection, so an attacker who has reached the
    // binding's own receipt still has to forge the marker in agreement with
    // it. It is defense in depth on binding-owned files, not an independent
    // proof against an uncompromised receipt.
    if (options.fenceRequired === true && options.verifyWorkspace === true && workspace !== undefined) {
      const marker = await readConsumptionMarker({ worktreeDir: workspace.worktreeDir });
      const observedMarker = marker.ok
        ? `${marker.deliveryId}@${marker.fence}`
        : `unreadable (${marker.blockers.map((blocker) => blocker.code).join(", ")})`;
      const expectedMarker = `${deliveryId}@${options.invokingFence ?? reduced.state.lastFence}`;
      if (observedMarker !== expectedMarker) {
        // Like every sibling workspace-integrity failure, this leaves a
        // durable blocker rather than a silently retryable refusal.
        if (reduced.state.state !== "blocked" && reduced.state.state !== "security_blocked") {
          await recordBlockerAndTransition(
            store,
            deliveryId,
            reduced.state.state,
            "projection.consumption-marker-mismatch",
            `the worktree's per-run consumption marker reads ${observedMarker}, not ${expectedMarker}`.slice(0, 1900),
            "blocked",
          );
        }
        return refuse(
          "consumption_marker_mismatch",
          `The worktree's per-run consumption marker reads ${observedMarker}, not ${expectedMarker}.`,
          "Only the projection this invocation materialized may carry its outputs; quarantine the workspace and resume through an authorized takeover.",
        );
      }
    }

    // The qualification profile's use-time binding: a fixture installation
    // advances deliveries only in its receipt-listed disposable
    // repositories. The receipt is the ONLY source of eligibility;
    // repository content can never make itself eligible.
    if (
      binding.ok &&
      binding.activeCompositionProfile === "confirmation-fixture" &&
      !(binding.disposableRepositoryIds ?? []).includes(meta.contract.repository.repositoryId)
    ) {
      return refuse(
        "disposable_repository_refused",
        "A qualification installation serves only its receipt-listed disposable repositories; this repository is not listed.",
        "Qualification runs happen in the disposable repositories named at install time; production repositories need a production installation.",
      );
    }

    return options.requireState !== undefined && !options.requireState.includes(reduced.state.state)
      ? refuse(
          "wrong_state",
          `This operation runs in ${options.requireState.join("/")}; the delivery is in ${reduced.state.state}.`,
          "Read `status` for the next valid checkpoint.",
        )
      : {
          store,
          meta,
          state: reduced.state.state,
          lastActiveState: reduced.state.lastActiveState,
          expectedRevision: reduced.state.expectedRevision,
          lastFence: reduced.state.lastFence,
          views,
          workspace,
          generationRoot: generation.ok ? generation.root : "",
          recheckValues,
        };
  };

  interface RecordedProviderAttempt {
    readonly attemptId: string;
    readonly lensId: string;
    readonly contextDigest: string;
    readonly personaDigest: string;
    readonly artifactDigest: string;
  }

  const providerRunKeyOf = (result: ProviderReviewResult): string => digestCanonical({
    providerId: result.provider.id,
    providerVersion: result.provider.version,
    runId: result.provider.runId,
    finalPassId: result.provider.finalPassId,
  });

  const suspendedProviderRunKeysOf = (views: readonly JournalEntryView[]): ReadonlySet<string> => new Set(
    views
      .filter((view) => view.kind === "blocker.recorded" && view.payload["code"] === "review.result-replay-conflict")
      .map((view) => view.payload["providerRunKey"])
      .filter((key): key is string => typeof key === "string"),
  );

  const recordedProviderAttemptsOf = (views: readonly JournalEntryView[]): RecordedProviderAttempt[] =>
    views
      .filter((view) => view.kind === "attempt.artifact.recorded")
      .map((view) => ({
        attemptId: view.payload["attemptId"] as string,
        lensId: view.payload["lensId"] as string,
        contextDigest: view.payload["contextDigest"] as string,
        personaDigest: view.payload["personaDigest"] as string,
        artifactDigest: view.payload["artifactDigest"] as string,
      }));

  const acceptedProviderResultsOf = async (
    deliveryId: string,
    views: readonly JournalEntryView[],
  ): Promise<{ readonly ok: true; readonly results: ProviderReviewResult[] } | FacadeFailure> => {
    const dir = await deliveryDir(deliveryId);
    const results: ProviderReviewResult[] = [];
    for (const recorded of recordedProviderAttemptsOf(views)) {
      try {
        const bytes = await readFile(persistedResultPath(dir, recorded.artifactDigest), "utf8");
        if (sha256Hex(bytes) !== recorded.artifactDigest) {
          return refuse(
            "provider_result_artifact_unavailable",
            `Accepted provider result ${recorded.attemptId} no longer matches its journaled content address.`,
            "Restore the exact content-addressed result bytes; never append a replacement acceptance.",
          );
        }
        const parsed = parseProviderReviewResult(bytes);
        if (
          parsed.ok &&
          parsed.result.reviewer.attemptId === recorded.attemptId &&
          parsed.result.reviewer.lensId === recorded.lensId &&
          parsed.result.reviewer.contextDigest === recorded.contextDigest &&
          parsed.result.reviewer.personaDigest === recorded.personaDigest
        ) {
          results.push(parsed.result);
        } else {
          return refuse(
            "provider_result_artifact_unavailable",
            `Accepted provider result ${recorded.attemptId} is malformed or disagrees with its journaled attempt binding.`,
            "Restore the exact content-addressed result bytes; never append a replacement acceptance.",
          );
        }
      } catch {
        return refuse(
          "provider_result_artifact_unavailable",
          `Accepted provider result ${recorded.attemptId} is missing from content-addressed storage.`,
          "Restore the exact content-addressed result bytes; never append a replacement acceptance.",
        );
      }
    }
    return { ok: true, results };
  };

  const attemptsOf = async (
    deliveryId: string,
    views: readonly JournalEntryView[],
  ): Promise<{ readonly ok: true; readonly attempts: RecordedReviewAttempt[]; readonly results: ProviderReviewResult[] } | FacadeFailure> => {
    const loaded = await acceptedProviderResultsOf(deliveryId, views);
    if (!loaded.ok) return loaded;
    const results = loaded.results.filter((result) => !suspendedProviderRunKeysOf(views).has(providerRunKeyOf(result)));
    const attempts: RecordedReviewAttempt[] = [];
    for (const result of results) {
      attempts.push({
        attemptId: result.reviewer.attemptId,
        lensId: result.reviewer.lensId,
        contextDigest: result.reviewer.contextDigest,
        artifactDigest: sha256Hex(`${JSON.stringify(result, null, 2)}\n`),
        verdict: result.verdict === "approved" ? "approved" : "findings",
        candidateTreeSha: result.candidate.treeSha,
        personaDigest: result.reviewer.personaDigest,
      });
    }
    return { ok: true, attempts, results };
  };

  const nextCheckpointOf = (state: DeliveryState, views: readonly JournalEntryView[]): ManagedCheckpoint => {
    switch (state) {
      case "accepted":
      case "preparing":
        return { kind: "bind-workspace" };
      case "planning":
        return { kind: "workflow-stage", stageId: "plan", remediation: false, grantDigest: checkpointGrantDigestFor("plan") };
      case "implementing":
        return { kind: "workflow-stage", stageId: "implement", remediation: false, grantDigest: checkpointGrantDigestFor("implement") };
      case "remediating":
        return { kind: "workflow-stage", stageId: "implement", remediation: true, grantDigest: checkpointGrantDigestFor("implement") };
      case "validating":
        return { kind: "repository-sensor", capabilityId: policyBinding.sensor.capabilityId };
      case "reviewing":
        return { kind: "review", stageId: "review.acquire", lenses: policy.reviewLenses.map((lens) => lens.lensId) };
      case "admitting":
        return { kind: "admission" };
      case "recording":
        return { kind: "tracked-record" };
      case "ready":
        return { kind: "finish-line" };
      case "completed":
        return { kind: "complete" };
      case "compounding":
        return { kind: "workflow-stage", stageId: "compound", remediation: false, grantDigest: checkpointGrantDigestFor("compound") };
      default: {
        const blocker = lastOf(views, "blocker.recorded");
        return {
          kind: "blocked",
          code: (blocker?.payload["code"] as string | undefined) ?? "blocked",
          summary: (blocker?.payload["summary"] as string | undefined) ?? `the delivery is ${state}`,
        };
      }
    }
  };

  const renderChallenge = async (
    nonce: string,
    confirmation: Record<string, unknown>,
    subject: string,
    expiry: string,
  ): Promise<{ readonly ok: true; readonly channelPath: string } | FacadeFailure> => {
    // The fixture channel is profile-gated: only the confirmation-fixture
    // composition profile may render a durable challenge file, and the
    // installer already refuses that profile on a production installation.
    const binding = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    if (!binding.ok) {
      return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
    }
    if (binding.activeCompositionProfile !== "confirmation-fixture") {
      return refuse(
        "interactive_channel_required",
        "Production confirmations fail closed because this host has no qualified binding-owned producer.",
        "Qualify a host-native producer before enabling production contract confirmation or takeover.",
      );
    }
    const pending: PendingConfirmation = {
      rendered: {
        channelId: `chan-${nonce}`,
        channelOpen: true,
        interactive: true,
        challenge: hex(16),
        consumed: false,
        expiry,
      },
      confirmation,
      subject,
    };
    const channelPath = confirmationPath(nonce);
    await writeOwned(channelPath, `${JSON.stringify(pending)}\n`);
    return { ok: true, channelPath };
  };

  const consumeChallenge = async (
    nonce: string,
    echo: ConfirmationEchoAttempt,
  ): Promise<{ confirmation: Record<string, unknown> } | FacadeFailure> => {
    const channelPath = confirmationPath(nonce);
    const pending = await readJson<PendingConfirmation>(channelPath);
    if (pending === undefined) {
      return refuse("confirmation_unknown", "No rendered confirmation challenge matches this nonce.", "Present the confirmation first.");
    }
    const decision = evaluateConfirmationEcho(pending.rendered, echo);
    if (!decision.completed) {
      return refuse(
        "confirmation_refused",
        `The confirmation echo was refused: ${decision.denials.map((denial) => `${denial.code}: ${denial.message}`).join("; ")}`,
        "Complete the echo on the same open, interactive, binding-owned channel it was rendered on.",
      );
    }
    await writeOwned(channelPath, `${JSON.stringify({ ...pending, rendered: { ...pending.rendered, consumed: true } })}\n`);
    return { confirmation: pending.confirmation };
  };

  const retentionContext = async (): Promise<RetentionContext | FacadeFailure> => {
    const binding = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    if (!binding.ok) {
      return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
    }
    return {
      namespaceDir: await namespaceDir(),
      installationId: binding.registeringInstallationId,
      maintenanceJournalPath: path.join(input.installation.installationPath, "maintenance.jsonl"),
    };
  };

  /** Read-only retention/explanation admission: the current facade may only
   * inspect or remove a delivery whose two durable binding records agree with
   * the exact binding captured by this facade. */
  const verifyDeliveryBinding = async (deliveryId: string): Promise<{ ok: true } | FacadeFailure> => {
    const dir = await deliveryDir(deliveryId);
    const meta = await readJson<DeliveryMeta>(path.join(dir, "delivery.json"));
    if (meta === undefined) {
      return refuse("unknown_delivery", `No registered delivery ${deliveryId}.`, "Register a delivery through the contract handoff first.");
    }
    const reduced = await (await journalStoreFor(deliveryId)).state();
    if (!reduced.ok) {
      return refuse("journal_rejected", "The durable delivery journal does not reduce.", "Inspect the durable delivery journal file.");
    }
    if (
      meta.policyBindingDigest !== policyBindingDigest ||
      reduced.state.policyBindingDigest !== policyBindingDigest ||
      meta.policyBindingDigest !== reduced.state.policyBindingDigest
    ) {
      return refuse(
        "policy_binding_mismatch",
        "The current compiled adopter policy binding does not match this delivery's recorded binding.",
        "Use the exact binding captured at registration; drift requires a new owner-approved delivery.",
      );
    }
    return { ok: true };
  };

  // ── Intake plumbing ──────────────────────────────────────────────────────

  const intakePath = async (intakeId: string, suffix: string): Promise<string> =>
    path.join(await namespaceDir(), "intake", `${intakeId}${suffix}`);
  const intakeStoreFor = async (intakeId: string): Promise<IntakeJournalStore> =>
    createIntakeJournalStore(await intakePath(intakeId, ".jsonl"));

  /**
   * The intake half of the status model. A delivery whose intake journal is
   * gone or unreducible reports no intake rather than inventing one — the
   * delivery journal is the authority for everything after registration.
   */
  const intakeProjectionOf = async (
    intakeId: string,
  ): Promise<{ readonly state: IntakeState; readonly expectedRevision: number } | undefined> => {
    try {
      const reduced = await (await intakeStoreFor(intakeId)).state();
      return reduced.ok ? { state: reduced.state.state, expectedRevision: reduced.state.expectedRevision } : undefined;
    } catch {
      return undefined;
    }
  };

  /** Appends one intake-journal entry under the frozen reducer's discipline. */
  const appendIntake = async (
    store: IntakeJournalStore,
    intakeId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | FacadeFailure> => {
    const read = await store.read();
    if (!read.ok) return refuse("intake_journal_unreadable", "The intake journal is unreadable.", "Inspect the durable intake journal file.");
    let expectedRevision = 0;
    if (read.entries.length > 0) {
      const reduced = await store.state();
      if (!reduced.ok) return refuse("intake_journal_rejected", "The durable intake journal does not reduce.", "Inspect the durable intake journal file.");
      expectedRevision = reduced.state.expectedRevision;
    }
    const appended = await store.append({
      spec: "journal-entry/1",
      journal: "intake",
      subjectId: intakeId,
      expectedRevision,
      idempotencyKey: `e${read.entries.length}-${kind}`,
      kind,
      payload,
    });
    if (!appended.ok) {
      return refuse(
        "intake_journal_rejected",
        `The frozen intake reducer refused a ${kind} append: ${appended.rejections.map((rejection) => rejection.message).join("; ")}`,
        "The refused entry is reported verbatim; correct the calling state.",
      );
    }
    return { ok: true };
  };

  const intakeStateOf = async (
    store: IntakeJournalStore,
  ): Promise<{ readonly state: string; readonly lastDraftDigest?: string } | FacadeFailure> => {
    const reduced = await store.state();
    if (!reduced.ok) {
      return refuse("intake_unknown", "No intake journal reduces under this identity.", "Open an intake or present a contract first.");
    }
    return { state: reduced.state.state, ...(reduced.state.lastDraftDigest === undefined ? {} : { lastDraftDigest: reduced.state.lastDraftDigest }) };
  };

  interface PresentValidated {
    readonly contract: AcceptedContract;
    readonly policy: PolicySnapshot;
    readonly generationDigest: string;
    readonly trust: ProductTrustState;
  }

  /**
   * Resolves repository-owned reviewer sources from the trusted pre-run base;
   * composition-owned sources were already authenticated and are carried
   * forward without assuming an adopter repository path.
   */
  const trustedBaseCharters = async (
    baseRef: string,
  ): Promise<{ readonly personaBytes: Readonly<Record<string, string>> } | FacadeFailure> => {
    const personaBytes: Record<string, string> = {};
    for (const lens of policy.reviewLenses) {
      const source = policyBinding.personaSources[lens.personaId];
      if (source === undefined) return refuse("reviewer_charter_missing", `No resolved reviewer charter exists for ${lens.personaId}.`, "Bind every activated review lens to an authenticated persona source.");
      if (source.origin === "composition") {
        personaBytes[lens.personaId] = source.bytes;
        continue;
      }
      const shown = await exec.run({ command: "git", args: ["show", `${baseRef}:${source.trustedBasePath}`], cwd: input.repoDir });
      if (shown.code !== 0 || shown.stdout !== source.bytes) {
        return refuse(
          "reviewer_charter_moved",
          `The trusted pre-run base ${baseRef} does not carry the exact reviewer charter ${lens.personaId} bound by policy.`,
          "Rebind the repository-owned persona from the exact trusted base bytes before presenting the contract.",
        );
      }
      personaBytes[lens.personaId] = shown.stdout;
    }
    return { personaBytes };
  };

  /**
   * The presentation-time validation both lanes run before anything reaches
   * the operator: frozen contract grammar, an execution-eligible active
   * generation, readable trust state, the qualification profile's use-time
   * binding, and the compiled policy's authority ceiling.
   */
  const presentValidation = async (contractValue: unknown): Promise<PresentValidated | FacadeFailure> => {
    const contractVerdict = validateAcceptedContract(contractValue);
    if (!contractVerdict.ok) {
      return refuse(
        "contract_rejected",
        `The scoped contract is outside its frozen grammar: ${contractVerdict.rejections.map((rejection) => rejection.message).join("; ")}`,
        "Fix the contract; material ambiguity remains in intake.",
      );
    }
    const contract = contractValue as AcceptedContract;

    const active = await resolveActiveGeneration(input.installation.installationPath);
    if (!active.ok) {
      return refuse("no_active_generation", "No active composition generation is installed.", "Install and activate a composition first.");
    }
    const generation = await loadPinnedGeneration({
      installationPath: input.installation.installationPath,
      generationDigest: active.generationDigest,
    });
    if (!generation.ok) {
      return refuse(
        "trust_ineligible",
        `The active generation fails its trust checks: ${generation.blockers.map((blocker) => blocker.message).join("; ")}`,
        "Restore local trust state through the operator maintenance lane.",
      );
    }
    const trust = await readTrust();
    if (trust === undefined) {
      return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
    }
    if (policy.repositoryId !== contract.repository.repositoryId) {
      return refuse(
        "policy_repository_mismatch",
        "The compiled adopter policy belongs to a different repository than this contract.",
        "Compile and bind the repository policy for the contract's repository identity.",
      );
    }
    if (policy.productTrustRevocationEpoch !== trust.revocationEpoch) {
      return refuse(
        "policy_trust_epoch_mismatch",
        "The compiled adopter policy was not produced under the current product trust epoch.",
        "Recompile and bind the repository policy under the current trust state.",
      );
    }

    // The qualification profile's use-time binding at registration: a fixture
    // installation registers deliveries only in its receipt-listed disposable
    // repositories, and only the receipt decides.
    const registration = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    if (!registration.ok) {
      return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
    }
    if (
      registration.activeCompositionProfile === "confirmation-fixture" &&
      !(registration.disposableRepositoryIds ?? []).includes(contract.repository.repositoryId)
    ) {
      return refuse(
        "disposable_repository_refused",
        "A qualification installation registers deliveries only in its receipt-listed disposable repositories; this repository is not listed.",
        "Qualification runs happen in the disposable repositories named at install time; production repositories need a production installation.",
      );
    }
    // Resolve every authenticated reviewer source before confirmation.
    const charters = await trustedBaseCharters(contract.repository.baseRef);
    if (!("personaBytes" in charters)) return charters;
    const withinPolicy = checkContractWithinPolicy(contract, policy);
    if (!withinPolicy.ok) {
      return refuse(
        "authority_not_granted",
        `The contract requests authority the compiled policy does not grant: ${withinPolicy.rejections.map((rejection) => rejection.message).join("; ")}`,
        "Absence of a grant is denial; narrow the contract or widen repository policy through its owners.",
      );
    }
    return { contract, policy, generationDigest: active.generationDigest, trust };
  };

  /** Mints and renders one contract-confirmation for the presented draft. */
  const presentForConfirmation = async (
    intakeId: string,
    contract: AcceptedContract,
    validated: PresentValidated,
    expiry: string,
  ): Promise<{ readonly ok: true; readonly nonce: string; readonly normalizedContractDigest: string; readonly channelPath: string } | FacadeFailure> => {
    const nonce = `nonce-${hex(8)}`;
    const normalizedContractDigest = digestCanonical(contract);
    const confirmation = {
      spec: "operator-confirmation/1",
      confirmationClass: "contract-confirmation",
      origin: "managed-delivery.facade",
      action: "confirm-contract",
      expiry,
      nonce,
      productTrustRevocationEpoch: validated.trust.revocationEpoch,
      repositoryAuthorityRevocationEpoch: "absent-by-state",
      intakeDraftId: intakeId,
      deliveryId: "absent-by-state",
      normalizedContractDigest,
      supersededInvocationFence: "absent-by-state",
      expectedJournalRevision: "absent-by-state",
      targetBaseCommit: "absent-by-state",
      boundInvocationFence: "absent-by-state",
      boundCandidateTreeSha: "absent-by-state",
    };
    const rendered = await renderChallenge(nonce, confirmation, intakeId, expiry);
    if (!rendered.ok) return rendered;
    await writeOwned(
      await intakePath(intakeId, ".meta.json"),
      `${JSON.stringify({ contract, policy: validated.policy, generationDigest: validated.generationDigest, nonce, policyBindingDigest } satisfies IntakeMeta)}\n`,
    );
    return { ok: true, nonce, normalizedContractDigest, channelPath: rendered.channelPath };
  };

  interface AcceptancePreflight {
    readonly binding: { readonly registeringInstallationId: string; readonly activeCompositionProfile: string };
    readonly sensorBytes: string;
    /** The authenticated reviewer charter bytes, by identity. */
    readonly personaBytes: Readonly<Record<string, string>>;
    /** Read HERE, not after the terminal transition: see the preflight's contract below. */
    readonly trust: ProductTrustState;
  }

  /**
   * The validating_acceptance preflight, run AFTER the confirmation is
   * consumed — the pinned intake ordering. Everything here may drift between
   * presentation and consumption (trust state, installation resolution, the
   * trusted-base sensor), so a failure blocks with the consumed confirmation
   * intact and `retryAcceptance` re-runs it over the unchanged draft.
   *
   * EVERY value that can drift is read HERE, and the preflight carries them
   * forward. Registration runs after the terminal `accepted_contract`
   * transition, where the intake journal accepts no further entries — so a
   * validation-class refusal raised there would be unrecoverable, spending
   * the operator's single confirmation. Blocking is retryable; that is the
   * whole point of the ordering.
   */
  const acceptancePreflight = async (meta: IntakeMeta): Promise<AcceptancePreflight | FacadeFailure> => {
    const contractVerdict = validateAcceptedContract(meta.contract);
    if (!contractVerdict.ok) {
      return refuse(
        "contract_rejected",
        `The presented contract is outside its frozen grammar: ${contractVerdict.rejections.map((rejection) => rejection.message).join("; ")}`,
        "Fix the contract; material ambiguity remains in intake.",
      );
    }
    const binding = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    if (!binding.ok) {
      return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
    }
    const trust = await readTrust();
    if (trust === undefined) {
      return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
    }
    if (meta.policyBindingDigest !== compiledAdopterPolicyBindingDigest(policyBinding)) {
      return refuse(
        "policy_binding_mismatch",
        "The presented intake was bound to different adopter policy material.",
        "Re-present the contract with the exact compiled adopter policy binding.",
      );
    }
    if (meta.policy.repositoryId !== meta.contract.repository.repositoryId) {
      return refuse(
        "policy_repository_mismatch",
        "The presented policy belongs to a different repository than the contract.",
        "Re-present the contract with its repository's compiled policy.",
      );
    }
    const generation = await loadPinnedGeneration({
      installationPath: input.installation.installationPath,
      generationDigest: meta.generationDigest,
    });
    if (!generation.ok) {
      return refuse(
        "trust_ineligible",
        "The generation bound at presentation is not execution-eligible under current local trust state.",
        "Restore local trust state through the operator maintenance lane, then retry acceptance.",
      );
    }
    if (meta.policy.productTrustRevocationEpoch !== trust.revocationEpoch) {
      return refuse(
        "policy_trust_epoch_mismatch",
        "The presented policy was not produced under the current product trust epoch.",
        "Re-present the contract with a policy compiled under the current trust state.",
      );
    }
    const withinPolicy = checkContractWithinPolicy(meta.contract, meta.policy);
    if (!withinPolicy.ok) {
      return refuse(
        "authority_not_granted",
        `The contract requests authority the compiled policy does not grant: ${withinPolicy.rejections.map((rejection) => rejection.message).join("; ")}`,
        "Absence of a grant is denial; narrow the contract or widen repository policy through its owners.",
      );
    }
    // The trusted-base sensor: copied from the base commit NOW, executed only
    // from that copy — the candidate's tracked rewrite never governs.
    const shown = await exec.run({
      command: "git",
      args: ["show", `${meta.contract.repository.baseRef}:${policyBinding.sensor.trustedBasePath}`],
      cwd: input.repoDir,
    });
    if (shown.code !== 0) {
      return refuse(
        "trusted_sensor_missing",
        `The trusted pre-run base ${meta.contract.repository.baseRef} carries no ${policyBinding.sensor.trustedBasePath}.`,
        "The repository's sensor must exist at the base; candidate-supplied sensors never govern.",
      );
    }
    const charters = await trustedBaseCharters(meta.contract.repository.baseRef);
    if (!("personaBytes" in charters)) return charters;
    // Repository-owned source bytes were compared to the trusted base above;
    // composition-owned bytes remain independent of adopter repository paths.
    for (const lens of meta.policy.reviewLenses) {
      if (sha256Hex(charters.personaBytes[lens.personaId] ?? "") === lens.personaDigest) continue;
      return refuse(
        "reviewer_charter_moved",
        `The trusted pre-run base no longer carries the reviewer charter ${lens.personaId} that this draft's policy pinned.`,
        "Re-present the contract so the policy pins the charters the base carries now.",
      );
    }
    return { binding, sensorBytes: shown.stdout, personaBytes: charters.personaBytes, trust };
  };

  /** Registration at accepted_contract: facade-side, outside intake's capability set. */
  const registerDelivery = async (
    intakeId: string,
    meta: IntakeMeta,
    preflight: AcceptancePreflight,
  ): Promise<{ readonly ok: true; readonly deliveryId: string } | FacadeFailure> => {
    // Trust state was read by the preflight, BEFORE the terminal transition —
    // re-reading it here could only produce an unrecoverable refusal.
    const trust = preflight.trust;
    if (meta.nonce === undefined) {
      return refuse("confirmation_void", "No consumed confirmation is bound to this intake draft.", "Present the draft and complete the operator confirmation first.");
    }
    const ns = await namespaceDir();
    const deliveryId = `dlv-${hex(6)}`;
    const dir = await deliveryDir(deliveryId);
    const store = await journalStoreFor(deliveryId);

    const registered = await appendEntry(store, deliveryId, "delivery.registered", {
      contractDigest: digestCanonical(meta.contract),
      intakeId,
      confirmationNonce: meta.nonce,
      activeCompositionProfile: preflight.binding.activeCompositionProfile,
      registeringInstallationId: preflight.binding.registeringInstallationId,
    });
    if (!registered.ok) return registered;
    await appendEntry(store, deliveryId, "generation.pinned", {
      generationDigest: meta.generationDigest,
      releaseId: PINNED_AGENT_SKILLS.releaseId,
      profile: preflight.binding.activeCompositionProfile,
    });
    await appendEntry(store, deliveryId, "policy.snapshot.bound", {
      policyDigest: meta.policy.policyDigest,
      policyBindingDigest,
      repositoryAuthorityEpoch: meta.policy.repositoryAuthorityRevocationEpoch,
    });
    await appendEntry(store, deliveryId, "trust.epoch.observed", {
      productTrustEpoch: trust.revocationEpoch,
      repositoryAuthorityEpoch: meta.policy.repositoryAuthorityRevocationEpoch,
    });

    await writeOwned(path.join(dir, "trusted-sensor.mjs"), preflight.sensorBytes);
    for (const [personaId, bytes] of Object.entries(preflight.personaBytes)) {
      await writeOwned(path.join(dir, "personas", `${personaId}.md`), bytes);
    }
    await writeOwned(
      path.join(dir, "delivery.json"),
      `${JSON.stringify({ contract: meta.contract, policy: meta.policy, generationDigest: meta.generationDigest, intakeId, policyBindingDigest } satisfies DeliveryMeta)}\n`,
    );
    // Keep the exact adopter binding beside the product namespace pointer so
    // the CLI can recreate this facade without rediscovering policy paths.
    await writeOwned(path.join(ns, "policy-binding.json"), `${JSON.stringify(policyBinding)}\n`);

    // The namespace pointer the host-facing CLI resolves the facade from:
    // installation paths and host version, in the product namespace, never
    // in candidate-writable paths.
    await writeOwned(
      path.join(ns, "facade.json"),
      `${JSON.stringify({
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
        hostVersion: input.hostVersion,
        policyBindingDigest,
      })}\n`,
    );

    const transitioned = await appendEntry(store, deliveryId, "transition.committed", { from: "accepted", to: "preparing" });
    if (!transitioned.ok) return transitioned;
    return { ok: true, deliveryId };
  };

  /**
   * The validating_acceptance leg shared by confirmation and retry: preflight
   * under the already-consumed confirmation, then either the accepted_contract
   * transition plus registration, or the typed blocked transition.
   */
  const runAcceptance = async (
    intakeId: string,
    store: IntakeJournalStore,
    meta: IntakeMeta,
  ): Promise<{ readonly ok: true; readonly deliveryId: string } | FacadeFailure> => {
    const preflight = await acceptancePreflight(meta);
    if (!("binding" in preflight)) {
      await appendIntake(store, intakeId, "intake.state.changed", { from: "validating_acceptance", to: "blocked" });
      return preflight;
    }
    const accepted = await appendIntake(store, intakeId, "intake.state.changed", { from: "validating_acceptance", to: "accepted_contract" });
    if (!accepted.ok) return accepted;
    return registerDelivery(intakeId, meta, preflight);
  };

  // ── Typed workflow-checkpoint plumbing ───────────────────────────────────

  const loadGraph = async (
    generationRoot: string,
  ): Promise<{ readonly graph: WorkflowGraph; readonly graphSha256: string } | FacadeFailure> => {
    let archiveBytes: Uint8Array;
    try {
      archiveBytes = await readFile(path.join(generationRoot, ...GENERATION_SKILLS_ARCHIVE.split("/")));
    } catch {
      return refuse("workflow_graph_rejected", "The pinned generation's skills archive is unreadable.", "Restore the installation through the operator maintenance lane.");
    }
    const loaded = loadBundledWorkflowGraph(archiveBytes);
    if (!loaded.ok) {
      return refuse(
        "workflow_graph_rejected",
        `The bundled workflow graph failed its pin: ${loaded.blockers.map((blocker) => blocker.message).join("; ")}`,
        "Only the exact pinned graph governs checkpoints.",
      );
    }
    return { graph: loaded.graph, graphSha256: loaded.graphSha256 };
  };

  const persistedResultPath = (dir: string, digest: string): string => path.join(dir, "results", `${digest}.json`);

  /** Reads one persisted typed result back, verifying its journal digest binding. */
  const persistedResultOf = async (dir: string, digest: string): Promise<AcceptedStageResult | undefined> => {
    try {
      const bytes = await readFile(persistedResultPath(dir, digest), "utf8");
      if (sha256Hex(bytes) !== digest) return undefined; // tampered persistence satisfies nothing
      const parsed = JSON.parse(bytes) as { status?: unknown; stageId?: unknown; output?: { kind?: unknown } };
      if (typeof parsed.status !== "string" || typeof parsed.stageId !== "string") return undefined;
      return {
        stageId: parsed.stageId,
        status: parsed.status,
        ...(typeof parsed.output?.kind === "string" ? { outputKind: parsed.output.kind } : {}),
        evidenceRefs: [],
        limitations: [],
      };
    } catch {
      return undefined;
    }
  };

  /**
   * The harness-retained prerequisite summaries, rebuilt from the journal's
   * digest-bound stage records and their persisted typed documents. The
   * registration itself is the scoped-subject evidence — an accepted contract
   * IS intake's success output.
   */
  const retainedSummaries = async (
    deliveryId: string,
    views: readonly JournalEntryView[],
  ): Promise<Map<string, CompletedStageSummary>> => {
    const map = new Map<string, CompletedStageSummary>();
    if (views.some((view) => view.kind === "delivery.registered")) {
      map.set("intake", { status: "succeeded", outputKind: "scoped-subject" });
    }
    const dir = await deliveryDir(deliveryId);
    for (const view of views) {
      if (view.kind !== "stage.result.recorded") continue;
      const persisted = await persistedResultOf(dir, view.payload["resultDigest"] as string);
      if (persisted === undefined) continue;
      map.set(view.payload["stageId"] as string, {
        status: persisted.status,
        ...(persisted.outputKind === undefined ? {} : { outputKind: persisted.outputKind }),
      });
    }
    return map;
  };

  interface ProcessedStageResult {
    readonly bytes: string;
    readonly digest: string;
    readonly result: AcceptedStageResult;
  }

  /**
   * The checkpoint reducer's admission of one typed result: parse, validate
   * against the pinned graph and release under the stage's released
   * candidate-binding policy, then evaluate the graph-declared prerequisites
   * over harness-retained summaries. Prose, unknown members, self-nominated
   * candidates, and unmet prerequisites all refuse — host-facing skill text
   * guides execution but cannot advance the reducer.
   */
  const processStageResult = (processInput: {
    readonly resultBytes: string;
    readonly graph: WorkflowGraph;
    readonly graphSha256: string;
    readonly stageId: string;
    readonly deliveryId: string;
    readonly currentCandidate?: string;
    readonly producedCandidate?: string;
    readonly summaries: ReadonlyMap<string, CompletedStageSummary>;
    readonly repairLoop?: boolean;
    readonly productRealized?: readonly string[];
  }): ProcessedStageResult | FacadeFailure => {
    let parsed: unknown = processInput.resultBytes;
    try {
      parsed = JSON.parse(processInput.resultBytes);
    } catch {
      /* validation reports the typed refusal for non-JSON bytes */
    }
    const verdict = validateWorkflowStageResult(parsed, {
      graph: processInput.graph,
      graphSha256: processInput.graphSha256,
      release: RELEASE_IDENTITY,
      expectedStageId: processInput.stageId,
      expectedSubject: processInput.deliveryId,
      ...(processInput.currentCandidate === undefined ? {} : { currentCandidate: processInput.currentCandidate }),
      ...(processInput.producedCandidate === undefined ? {} : { producedCandidate: processInput.producedCandidate }),
    });
    if (!verdict.ok) {
      return refuse(
        "stage_result_rejected",
        `The ${processInput.stageId} result is outside the released workflow contract: ${verdict.rejections
          .map((rejection) => rejection.message)
          .join("; ")
          .slice(0, 1500)}`,
        "Submit a typed workflow-stage-result/1 document; host-facing skill text guides execution but cannot advance a checkpoint.",
      );
    }
    const stage = workflowStageOf(processInput.graph, processInput.stageId);
    if (stage === undefined) {
      return refuse("stage_result_rejected", `The pinned graph declares no ${processInput.stageId} stage.`, "Read `next-checkpoint`.");
    }
    const prerequisites = evaluateStagePrerequisites(stage, processInput.summaries, {
      ...(processInput.repairLoop === undefined ? {} : { repairLoop: processInput.repairLoop }),
      ...(processInput.productRealized === undefined ? {} : { productRealized: processInput.productRealized }),
    });
    if (!prerequisites.ok) {
      return refuse(
        "stage_prerequisite_unmet",
        `The ${processInput.stageId} stage's graph-declared prerequisites are not admitted: ${prerequisites.rejections
          .map((rejection) => rejection.message)
          .join("; ")
          .slice(0, 1500)}`,
        "Admit the prerequisite stage's typed result first; the frozen checkpoint order is not advisory.",
      );
    }
    return { bytes: processInput.resultBytes, digest: sha256Hex(processInput.resultBytes), result: verdict.result };
  };

  return {
    namespaceDir,

    async openIntake({ workRequest, observedAt, attestationExpiry }) {
      if (workRequest.trim().length === 0) {
        return refuse("work_request_empty", "An intake opens over a non-empty work request.", "State the intended outcome, then open the intake.");
      }
      const trust = await readTrust();
      if (trust === undefined) {
        return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
      }
      const intakeId = `intake-${hex(6)}`;

      // The product-owned scope workflow executes only under the READ-ONLY
      // intake grant: no writable paths, every delivery-scoped identity
      // explicitly absent-by-state, and an admission that is never
      // mutation-capable.
      const expectation: IntakeAdmissionExpectation = {
        profile: "intake",
        hostVersion: input.hostVersion,
        productTrustRevocationEpoch: trust.revocationEpoch,
        observedAt,
        intakeDraftId: intakeId,
      };
      const attestation = mintGrantAttestation({ grant: PORTABLE_INTAKE_GRANT, expectation, expiry: attestationExpiry });
      const admission = evaluateHostAdmission(expectation, PORTABLE_INTAKE_GRANT, attestation);
      if (!admission.admitted) {
        return refuse(
          "host_admission_refused",
          `The minted intake attestation does not admit against the binding's own expectation: ${admission.denials.map((denial) => denial.code).join(", ")}`,
          "Missing or failed grant application yields no intake invocation token.",
        );
      }

      const store = await intakeStoreFor(intakeId);
      const openedTransition = await appendIntake(store, intakeId, "intake.state.changed", {
        from: "draft_scope",
        to: "awaiting_clarification",
      });
      if (!openedTransition.ok) return openedTransition;
      await writeOwned(await intakePath(intakeId, ".request.json"), `${JSON.stringify({ workRequest })}\n`);
      const grantPath = await intakePath(intakeId, ".grant.json");
      await writeOwned(grantPath, `${JSON.stringify({ grant: PORTABLE_INTAKE_GRANT, expectation, attestation, admission })}\n`);
      return { ok: true, intakeId, grantDigest: admission.grantDigest, grantPath };
    },

    async recordClarification({ intakeId, question, answer }) {
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;
      return appendIntake(store, intakeId, "intake.clarification.recorded", { question, answer });
    },

    async recordDraft({ intakeId, draft }) {
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;

      if (state.state === "blocked") {
        // A draft mutation after a blocked acceptance preflight: the frozen
        // chain returns intake to the confirmation handoff — the consumed
        // confirmation covered different bytes and cannot carry the retry.
        const reopened = await appendIntake(store, intakeId, "intake.state.changed", { from: "blocked", to: "validating_acceptance" });
        if (!reopened.ok) return reopened;
        const returned = await appendIntake(store, intakeId, "intake.state.changed", {
          from: "validating_acceptance",
          to: "awaiting_confirmation",
        });
        if (!returned.ok) return returned;
      }

      const draftDigest = digestCanonical(draft);
      const recorded = await appendIntake(store, intakeId, "intake.draft.recorded", { draftDigest });
      if (!recorded.ok) return recorded;
      await writeOwned(await intakePath(intakeId, ".draft.json"), `${JSON.stringify(draft)}\n`);

      // A draft recorded after presentation VOIDS the pending confirmation:
      // the operator confirmed the previous digest, so the rendered channel
      // is destroyed and a fresh presentation is required.
      const metaPath = await intakePath(intakeId, ".meta.json");
      const meta = await readJson<IntakeMeta>(metaPath);
      if (meta?.nonce !== undefined) {
        await rm(confirmationPath(meta.nonce), { force: true });
        const { nonce: _voided, ...rest } = meta;
        await writeOwned(metaPath, `${JSON.stringify(rest)}\n`);
      }
      return { ok: true, draftDigest };
    },

    async presentDraft({ intakeId, expiry }) {
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;
      if (state.state !== "awaiting_clarification" && state.state !== "awaiting_confirmation") {
        return refuse(
          "wrong_state",
          `A draft is presented from awaiting_clarification or awaiting_confirmation; intake is in ${state.state}.`,
          "Record the draft, then present it.",
        );
      }
      const draft = await readJson<unknown>(await intakePath(intakeId, ".draft.json"));
      if (draft === undefined || state.lastDraftDigest === undefined) {
        return refuse("draft_missing", "No draft is retained for this intake.", "Record the completed draft contract first.");
      }
      const validated = await presentValidation(draft);
      if (!("policy" in validated)) return validated;

      if (state.state === "awaiting_clarification") {
        const presentedTransition = await appendIntake(store, intakeId, "intake.state.changed", {
          from: "awaiting_clarification",
          to: "awaiting_confirmation",
        });
        if (!presentedTransition.ok) return presentedTransition;
      }
      return presentForConfirmation(intakeId, validated.contract, validated, expiry);
    },

    async presentContract({ contract, expiry }) {
      const validated = await presentValidation(contract);
      if (!("policy" in validated)) return validated;

      // The direct already-scoped handoff still walks the frozen intake
      // chain — it bypasses only clarification, never the draft retention,
      // acceptance validation, or the operator confirmation.
      const intakeId = `intake-${hex(6)}`;
      const store = await intakeStoreFor(intakeId);
      const opened = await appendIntake(store, intakeId, "intake.state.changed", { from: "draft_scope", to: "awaiting_clarification" });
      if (!opened.ok) return opened;
      const draftDigest = digestCanonical(contract);
      const drafted = await appendIntake(store, intakeId, "intake.draft.recorded", { draftDigest });
      if (!drafted.ok) return drafted;
      await writeOwned(await intakePath(intakeId, ".draft.json"), `${JSON.stringify(contract)}\n`);
      const presentedTransition = await appendIntake(store, intakeId, "intake.state.changed", {
        from: "awaiting_clarification",
        to: "awaiting_confirmation",
      });
      if (!presentedTransition.ok) return presentedTransition;

      const presented = await presentForConfirmation(intakeId, validated.contract, validated, expiry);
      if (!presented.ok) return presented;
      return { ok: true, intakeId, nonce: presented.nonce, normalizedContractDigest: presented.normalizedContractDigest, channelPath: presented.channelPath };
    },

    async confirmContract({ intakeId, echo }) {
      const meta = await readJson<IntakeMeta>(await intakePath(intakeId, ".meta.json"));
      if (meta === undefined) {
        return refuse("intake_unknown", `No presented intake draft ${intakeId}.`, "Present the contract first.");
      }
      if (meta.nonce === undefined) {
        return refuse(
          "confirmation_void",
          "No confirmation is pending: the draft mutated after presentation, so the operator's confirmation covered different bytes.",
          "Present the current draft for a fresh operator confirmation.",
        );
      }
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;
      if (state.state !== "awaiting_confirmation") {
        return refuse(
          "wrong_state",
          `A contract confirmation is consumed in awaiting_confirmation; intake is in ${state.state}.`,
          state.state === "blocked" ? "Retry acceptance; the consumed confirmation stands over the unchanged draft." : "Present the draft first.",
        );
      }
      const consumed = await consumeChallenge(meta.nonce, echo);
      if (!("confirmation" in consumed)) return consumed;

      // The confirmation is consumed at the EXIT of awaiting_confirmation;
      // acceptance validation runs AFTER it, and registration completes only
      // at accepted_contract.
      const recorded = await appendIntake(store, intakeId, "operator.confirmation.recorded", { confirmation: consumed.confirmation });
      if (!recorded.ok) return recorded;
      const validating = await appendIntake(store, intakeId, "intake.state.changed", {
        from: "awaiting_confirmation",
        to: "validating_acceptance",
      });
      if (!validating.ok) return validating;
      return runAcceptance(intakeId, store, meta);
    },

    async retryAcceptance({ intakeId }) {
      const meta = await readJson<IntakeMeta>(await intakePath(intakeId, ".meta.json"));
      if (meta === undefined) {
        return refuse("intake_unknown", `No presented intake draft ${intakeId}.`, "Present the contract first.");
      }
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;
      if (state.state !== "blocked") {
        return refuse(
          "wrong_state",
          `retryAcceptance re-runs a blocked acceptance preflight; intake is in ${state.state}.`,
          "Only a blocked validating_acceptance retries without a fresh confirmation.",
        );
      }
      // The journal guarantees the draft cannot have changed since the
      // consumed confirmation — a retry over the unchanged draft re-runs
      // validation under that confirmation; no fresh confirmation is minted.
      const retried = await appendIntake(store, intakeId, "intake.state.changed", { from: "blocked", to: "validating_acceptance" });
      if (!retried.ok) return retried;
      return runAcceptance(intakeId, store, meta);
    },

    async bindWorkspace({ deliveryId, worktreeDir, hostTaskId, observedAt, attestationExpiry, observationLifetimeSeconds, providerReviewBindingCapability }) {
      const guarded = await guard(deliveryId, { allowPendingTakeover: true });
      if (!("store" in guarded)) return guarded;
      if (!capabilityShape(providerReviewBindingCapability)) {
        return refuse(
          "provider_binding_capability_invalid",
          "The operator-owned provider-review binding capability is missing or malformed.",
          "Have the host create a fresh high-entropy capability outside the model process before binding.",
        );
      }

      // What the emitted command may assume about this runtime is PROBED, not
      // baked in: a runtime that rejects the type-stripping flag, or that is
      // not Node at all, would be handed a Node-shaped command it cannot run,
      // and an interceptor that never starts is a deny-until-attested boundary
      // failing OPEN. Refusing here is the closed direction.
      //
      // It is a PURE OBSERVATION of this process, so it is taken here, before
      // anything is written: a refusal on this ground must not land after the
      // predecessor's binding states have been voided, a `workspace.bound`
      // append has happened, or the projection has been materialized.
      const hookRuntime = resolveHookRuntimeArgs(input.hookRuntime ?? liveHookRuntimeProbes());
      if (!hookRuntime.ok) {
        return refuse(
          "hook_runtime_unsupported",
          `The running executable cannot run the emitted hook command: ${hookRuntime.reason}.`,
          "Run the delivery on a Node runtime that accepts the type-stripping flag; the activation preflight declares the floor.",
        );
      }
      const takeover = await readJson<PendingTakeover>(path.join(await deliveryDir(deliveryId), "takeover.json"));
      if (guarded.state !== "preparing" && takeover === undefined) {
        return refuse(
          "wrong_state",
          `bindWorkspace runs in preparing or after an authorized takeover; the delivery is in ${guarded.state}.`,
          "Read `status` for the next valid checkpoint.",
        );
      }

      // The workspace is host-created; the facade only validates and binds.
      const top = await git(worktreeDir, "rev-parse", "--show-toplevel");
      const commonOfWorktree = await git(worktreeDir, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const commonOfRepo = await git(input.repoDir, "rev-parse", "--path-format=absolute", "--git-common-dir");
      if (top.code !== 0 || commonOfWorktree.code !== 0 || commonOfWorktree.out !== commonOfRepo.out) {
        return refuse("workspace_invalid", "The supplied worktree does not belong to this repository.", "Hand in a host-created worktree of this repository.");
      }
      const porcelain = await git(worktreeDir, "status", "--porcelain");
      if (porcelain.code !== 0 || porcelain.out !== "") {
        return refuse("workspace_dirty", "The supplied worktree carries uncommitted or untracked work.", "Dirty baselines fail closed; hand in a clean worktree.");
      }
      const branchRef = (await git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD")).out;
      const branchRefValue = (await git(worktreeDir, "rev-parse", `refs/heads/${branchRef}`)).out;
      const headCommit = (await git(worktreeDir, "rev-parse", "HEAD")).out;
      const treeSha = (await git(worktreeDir, "rev-parse", "HEAD^{tree}")).out;
      const baseTipSha = (await git(input.repoDir, "rev-parse", guarded.meta.contract.repository.baseRef)).out;

      if (takeover !== undefined) {
        if (headCommit !== takeover.targetBaseCommit || branchRef !== takeover.takeoverBranchRef) {
          return refuse(
            "takeover_mismatch",
            `The fresh worktree must sit on ${takeover.takeoverBranchRef} at the authorized last trusted commit ${takeover.targetBaseCommit}.`,
            "Recreate the worktree from the takeover authorization's target base commit.",
          );
        }
      }

      const dir = await deliveryDir(deliveryId);
      const bindingDir = path.join(dir, "binding");
      const workspaceId = `ws-${hex(6)}`;
      const worktreeId = `wt-${sha256Hex(worktreeDir).slice(0, 16)}`;

      // Every SUPERSEDED invocation's state is voided HERE — before the fresh
      // worktree is materialized into, and before any refusal path below can
      // return. Its session keeps reading its own fence-scoped file, and a null
      // attestation is the frozen deny-until-attested case, so a still-running
      // predecessor keeps no write path into the workspace the takeover just
      // authorized — including the case where the operator recreated that
      // worktree at the path the predecessor was bound to. A predecessor is
      // already dead to the facade once a takeover is authorized, so voiding
      // early is strictly safer than voiding on success. Same mechanism
      // cancellation uses.
      await voidSupersededBindingStates(bindingDir, guarded.lastFence + 1);

      const bound = await appendEntry(guarded.store, deliveryId, "workspace.bound", {
        workspaceId,
        repositoryId: guarded.meta.contract.repository.repositoryId,
        baseRef: guarded.meta.contract.repository.baseRef,
        baseTipSha,
        branchRef: `refs/heads/${branchRef}`,
        branchRefValue,
        worktreeId,
        baselineClassification: "clean",
      });
      if (!bound.ok) return bound;

      // The fence this invocation will carry is known before materialization,
      // so the per-run consumption marker binds it: the marker read back from
      // a fence-bound submission proves the worktree holds THIS run's
      // projection rather than a prior run's leftovers.
      const fence = guarded.lastFence + 1;
      const materialized = await materializeProjection({
        worktreeDir,
        generationRoot: guarded.generationRoot,
        deliveryId,
        fence,
        bindingDir,
        exec,
      });
      if (!materialized.ok) {
        return refuse(
          "projection_failed",
          `Materializing the run-pinned projection failed: ${materialized.blockers.map((blocker) => blocker.message).join("; ")}`,
          "A missing or unmaterializable pinned root blocks rather than falling forward.",
        );
      }

      // FENCE-SCOPED, so a rebind writes new files instead of overwriting the
      // predecessor's in place: this host reloads settings and hooks
      // mid-session, and a superseded session must keep reading its own
      // configuration and its own — now voided — state.
      const statePath = path.join(bindingDir, bindingStateFile(fence));

      // A session wired to a hook entry that is not there would compose
      // cleanly and then have no interceptor at all, so resolution failing is
      // a refusal rather than a throw.
      //
      // UNREACHABLE IN PRACTICE, AND SAID SO RATHER THAN DRESSED UP. Every
      // guarded operation reloads this delivery's PINNED generation and
      // re-verifies its digest closure, so a root missing a staged file is
      // already refused as `trust_ineligible` — which is the refusal the
      // qualification lane pins, because it is the one that fires. What is
      // left for this branch is a race after that verification, and nothing
      // falsifies it; it keeps the resolution total, and it is recorded as
      // unexercised in qualifications/product-qualification.json.
      const hookEntry = await resolveStagedHookEntry(path.join(guarded.generationRoot, ...GENERATION_HOOK_ENTRY.split("/")));
      if (hookEntry === undefined) {
        return refuse(
          "hook_entry_missing",
          `The installed generation stages no model-external hook entry at ${GENERATION_HOOK_ENTRY}.`,
          "Reinstall or roll back to a generation whose closure verifies; a session cannot be admitted without its interceptor.",
        );
      }

      const composed = await hostBinding.composeSession({
        bindingDir,
        statePath,
        // The executable that was PROBED, not a second read of the process:
        // validating one runtime and then naming another is the seam this
        // resolution exists to close.
        hookCommand: [hookRuntime.execPath, ...hookRuntime.args, hookEntry],
        // The session's own identity, baked into its hook command: a later
        // invocation overwrites the shared binding state, and this is how a
        // superseded-but-still-running session recognizes that it has been.
        fence,
        workspaceRoot: worktreeDir,
        commonGitDir: commonOfWorktree.out,
        authorityDir: path.join(input.installation.installationPath, "provider-review-authority"),
        grant: stageGrant,
      });
      if (!composed.ok) {
        return refuse(
          "session_composition_failed",
          `Composing the host admission failed: ${composed.blockers.map((blocker) => blocker.message).join("; ")}`,
          "Materialize the projection before composing the session.",
        );
      }
      // The neutral composition under the names the rest of this operation and
      // the persisted workspace record already use. One binding's settings
      // file and another's thread-start request are the same thing here: the
      // fence-scoped admission configuration, and the arguments the OPERATOR
      // hands the host with it.
      const session = {
        settingsPath: composed.admissionConfigurationPath,
        cliArgs: composed.hostAdmissionArguments,
        discoveryConfigurationDigest: composed.discoveryConfigurationDigest,
      };

      // The bundled graph rides in through the pinned generation; binding
      // validates the checkpoint mapping against it.
      const archiveBytes = await readFile(path.join(guarded.generationRoot, ...GENERATION_SKILLS_ARCHIVE.split("/")));
      const graph = loadBundledWorkflowGraph(archiveBytes);
      if (!graph.ok) {
        return refuse(
          "workflow_graph_rejected",
          `The bundled workflow graph failed its pin: ${graph.blockers.map((blocker) => blocker.message).join("; ")}`,
          "Only the exact pinned graph governs checkpoints.",
        );
      }

      const trust = await readTrust();
      if (trust === undefined) {
        return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
      }
      const registered = lastOf(guarded.views, "delivery.registered");
      const expectation: CheckpointAdmissionExpectation = {
        profile: "checkpoint",
        hostVersion: input.hostVersion,
        productTrustRevocationEpoch: trust.revocationEpoch,
        observedAt,
        deliveryId,
        invocationFence: fence,
        workspaceId,
        projectionDigest: materialized.projectionDigest,
        discoveryConfigurationDigest: session.discoveryConfigurationDigest,
        registeringInstallationId: registered?.payload["registeringInstallationId"] as string,
        activeProfile: registered?.payload["activeCompositionProfile"] as string,
      };
      const attestation = mintGrantAttestation({ grant: stageGrant, expectation, expiry: attestationExpiry });
      const admission = evaluateHostAdmission(expectation, stageGrant, attestation);
      if (!admission.admitted) {
        return refuse(
          "host_admission_refused",
          `The minted attestation does not admit against the binding's own expectation: ${admission.denials.map((denial) => denial.code).join(", ")}`,
          "Missing or failed grant application yields no mutation-capable invocation token.",
        );
      }

      const observationPath = path.join(bindingDir, "observation.json");
      await writeOwned(
        statePath,
        `${JSON.stringify({
          expectation,
          grant: stageGrant,
          attestation,
          workspaceRoot: worktreeDir,
          observationPath,
          projectionConsumptionPath: path.join(bindingDir, projectionConsumptionObservationFile(fence)),
          projectionReceiptPath: path.join(bindingDir, PROJECTION_RECEIPT_FILE),
          journalPath: guarded.store.journalPath,
          deliveryId,
        })}\n`,
      );
      await writeOwned(observationPath, `${JSON.stringify({ fence, observedAt })}\n`);
      const lifetime = resolveObservationLifetimeSeconds(observationLifetimeSeconds);
      const grantDigest = stageGrantDigest;
      const providerReviewBinding: CapabilityBinding = {
        id: providerReviewBindingCapability.id,
        digest: capabilityDigest({
          domain: "workspace",
          capability: providerReviewBindingCapability,
          deliveryId,
          workspaceId,
          fence,
          discoveryConfigurationDigest: session.discoveryConfigurationDigest,
          grantDigest,
          productTrustRevocationEpoch: trust.revocationEpoch,
        }),
      };
      // Capability material and invocation bindings are installation-owned,
      // outside both common Git and the composed model grant. The repository
      // keeps no copy a model could replace before importing this facade.
      await writeOwned(
        providerAuthorityStatePath(deliveryId),
        `${JSON.stringify({
          deliveryId,
          workspaceId,
          fence,
          discoveryConfigurationDigest: session.discoveryConfigurationDigest,
          grantDigest,
          productTrustRevocationEpoch: trust.revocationEpoch,
          bindingCapability: providerReviewBinding,
        } satisfies ProviderReviewAuthorityState)}\n`,
      );
      await writeOwned(
        path.join(dir, "workspace.json"),
        `${JSON.stringify({
          worktreeDir,
          workspaceId,
          worktreeId,
          branchRef,
          observationLifetimeSeconds: lifetime,
          workflowGraphSha256: graph.graphSha256,
          discoveryConfigurationDigest: session.discoveryConfigurationDigest,
          projectionDigest: materialized.projectionDigest,
          fence,
          settingsPath: session.settingsPath,
        } satisfies WorkspaceMeta)}\n`,
      );

      const fenced = await appendEntry(guarded.store, deliveryId, "invocation.fenced", {
        fence,
        hostTaskId,
        worktreeId,
        candidateTreeSha: treeSha,
        candidateBranchRefValue: branchRefValue,
        policyDigest: guarded.meta.policy.policyDigest,
        authorityEpoch: guarded.meta.policy.repositoryAuthorityRevocationEpoch,
        observationLifetimeSeconds: lifetime,
      });
      if (!fenced.ok) return fenced;
      await appendEntry(guarded.store, deliveryId, "activity.observed", { activity: "active", fence });

      if (takeover !== undefined) {
        await appendEntry(guarded.store, deliveryId, "workspace.disposition.recorded", {
          workspaceId,
          disposition: "takeover",
        });
        // A blocked delivery resumes at its last trustworthy checkpoint — the
        // frozen reducer's journal-dependent rule — once the authorized fresh
        // worktree stands. (Leaving security_blocked stays a maintenance-lane
        // operation outside this skeleton; the trust recheck above already
        // refuses that path.)
        if (guarded.state === "blocked") {
          const resumed = await appendEntry(guarded.store, deliveryId, "transition.committed", {
            from: "blocked",
            to: guarded.lastActiveState,
          });
          if (!resumed.ok) return resumed;
        }
        await rm(path.join(dir, "takeover.json"), { force: true });
      } else {
        const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "preparing", to: "planning" });
        if (!transitioned.ok) return transitioned;
      }

      return {
        ok: true,
        fence,
        workspaceId,
        statePath,
        settingsPath: session.settingsPath,
        cliArgs: session.cliArgs,
        projectionDigest: materialized.projectionDigest,
      };
    },

    async status({ deliveryId, observedAt }) {
      const dir = await deliveryDir(deliveryId);
      const meta = await readJson<DeliveryMeta>(path.join(dir, "delivery.json"));
      if (meta === undefined) {
        return refuse("unknown_delivery", `No registered delivery ${deliveryId}.`, "Register a delivery through the contract handoff first.");
      }
      const store = await journalStoreFor(deliveryId);
      const reduced = await store.state();
      const read = await store.read();
      if (!reduced.ok || !read.ok) {
        return refuse("journal_rejected", "The durable journal does not reduce.", "Inspect the durable journal file.");
      }
      if (meta.policyBindingDigest !== policyBindingDigest || reduced.state.policyBindingDigest !== policyBindingDigest) {
        return refuse(
          "policy_binding_mismatch",
          "The current compiled adopter policy binding does not match this delivery's recorded binding.",
          "Use the exact binding captured at registration; drift requires a new owner-approved delivery.",
        );
      }
      const views = viewsOf(read.entries);
      const workspace = await readJson<WorkspaceMeta>(path.join(dir, "workspace.json"));

      // Host activity: the trusted lifecycle observations, aged lazily by the
      // fence's declared observation lifetime. The rule itself is
      // `gradeHostActivity` in ./liveness.ts, shared with every other reader
      // of liveness so two surfaces cannot disagree about whether one delivery
      // is alive — timeout never proves termination, so an aged `active`
      // becomes `unknown`, never `ended`.
      const lastActivity = lastOf(views, "activity.observed");
      const activity: HostActivity = gradeHostActivity({
        currentFence: reduced.state.lastFence,
        lastObservedActivity:
          lastActivity === undefined
            ? undefined
            : {
                activity: lastActivity.payload["activity"] as HostActivity,
                fence: lastActivity.payload["fence"] as number,
              },
        observationLifetimeSeconds: workspace?.observationLifetimeSeconds,
        // Read whenever a workspace is bound rather than only when the journal
        // last said `active`, so the rule stays a pure function of its inputs
        // instead of the caller re-deriving half of it to decide what to read.
        // The cost is one small JSON read on a path that already reduces the
        // whole journal.
        observation:
          workspace === undefined
            ? undefined
            : await readJson<{ fence: number; observedAt: string }>(path.join(dir, "binding", "observation.json")),
        observedAt,
      });

      const confirmations = views.filter((view) => view.kind === "operator.confirmation.recorded").length;
      const interventions = views.filter(
        (view) => view.kind === "blocker.recorded" && String(view.payload["code"]).startsWith("operator."),
      ).length;

      const terminal = reduced.state.state === "completed" || reduced.state.state === "cancelled" || reduced.state.state === "failed";
      // Same-workspace resume is gated on TERMINATION PROVENANCE for the
      // current fence, not on activity: an absent lifecycle event, a stale
      // one, or one whose descendant teardown was unverified all leave the
      // prior workspace unverified, and the designed path is an
      // operator-authorized takeover into a fresh worktree.
      const provenance = lastOf(views, "termination.provenance.recorded");
      const sameWorkspaceResumable =
        provenance !== undefined &&
        provenance.payload["fence"] === reduced.state.lastFence &&
        provenance.payload["resumeEligibility"] === "same-workspace";
      const resume: "none" | "takeover-required" | "same-workspace" = terminal
        ? "none"
        : activity === "active"
          ? "none"
          : sameWorkspaceResumable
            ? "same-workspace"
            : "takeover-required";

      const blockers =
        reduced.state.state === "blocked" || reduced.state.state === "security_blocked"
          ? views
              .filter((view) => view.kind === "blocker.recorded")
              .slice(-1)
              .map((view) => ({ code: view.payload["code"] as string, summary: view.payload["summary"] as string }))
          : [];

      // The registration binding, compared to the installation observed NOW.
      // Identity and profile are kept apart here on purpose: only an
      // identity mismatch on a matching profile has a migration path, and
      // collapsing the two is exactly what would offer a migration that is
      // guaranteed to refuse.
      const recordedBinding = recordedBindingOf(views);
      const observedBinding = await registrationBinding({
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
      });
      const currentBinding = observedBinding.ok
        ? {
            registeringInstallationId: observedBinding.registeringInstallationId,
            activeCompositionProfile: observedBinding.activeCompositionProfile as string,
          }
        : undefined;
      let mismatch: RegistrationMismatch;
      if (recordedBinding === undefined || currentBinding === undefined) {
        mismatch = "unresolved";
      } else if (recordedBinding.activeCompositionProfile !== currentBinding.activeCompositionProfile) {
        mismatch = "profile";
      } else if (recordedBinding.registeringInstallationId !== currentBinding.registeringInstallationId) {
        mismatch = "identity";
      } else {
        mismatch = "none";
      }

      // Product trust, read verbatim from the substrate; an unreadable store
      // reports itself rather than defaulting to eligible.
      const trust = await readTrust();
      const pinnedGenerationDigest = meta.generationDigest;
      const generation: ProductTrustView["generation"] =
        trust === undefined
          ? "unreadable"
          : (() => {
              const decision = localDigestTrustPredicate.evaluate(pinnedGenerationDigest, trust);
              return decision.eligible ? "eligible" : decision.reason;
            })();

      // Assertion-source availability, probed through the configured provider.
      const providerConfig = await loadAssertionProviderConfig(input.installation.installationPath);
      let assertionView: AssertionSourceView;
      if (!providerConfig.ok) {
        assertionView = {
          availability: "unconfigured",
          detail: `assertion provider configuration is ${providerConfig.reason}`,
          lanes: assertionLaneAvailability({ hostNative: false, osNative: false }),
        };
      } else {
        const probe = await assertionSourceForKind(providerConfig.config.sourceKind).probe();
        assertionView = probe.available
          ? {
              availability: "available",
              detail: probe.detail,
              lanes: assertionLaneAvailability({
                hostNative: probe.sourceKind === "host-native",
                osNative: probe.sourceKind !== "host-native",
              }),
            }
          : {
              availability: "unavailable",
              detail: probe.detail,
              lanes: assertionLaneAvailability({ hostNative: false, osNative: false }),
            };
      }
      // The durable file channel is qualification-only. Production has no
      // qualified producer and status must not advertise a takeover that the
      // facade is guaranteed to refuse.
      if (currentBinding?.activeCompositionProfile === "confirmation-fixture") {
        assertionView = {
          ...assertionView,
          lanes: { ...assertionView.lanes, operatorConfirmations: "available" },
        };
      }

      const dispositions = views.filter((view) => view.kind === "workspace.disposition.recorded");
      const quarantinedWorkspaces = [
        ...new Set(
          dispositions
            .filter((view) => view.payload["disposition"] === "quarantined")
            .map((view) => view.payload["workspaceId"] as string),
        ),
      ];
      const lastDisposition = dispositions[dispositions.length - 1]?.payload["disposition"] as WorkspaceDisposition | undefined;

      const admission = await readJson<{ completedObligations?: readonly string[] }>(path.join(dir, "admission.json"));
      const intakeState = await intakeProjectionOf(meta.intakeId);

      const composed: ManagedStatusInput = {
        deliveryId,
        intake: intakeState,
        delivery: { state: reduced.state.state, expectedRevision: reduced.state.expectedRevision, fence: reduced.state.lastFence },
        hostActivity: activity,
        completedObligations: admission?.completedObligations ?? [],
        productTrust: {
          label: PRODUCT_TRUST_LABEL,
          pinnedGenerationDigest,
          revocationEpoch: trust?.revocationEpoch ?? 0,
          generation,
        },
        assertionSource: assertionView,
        // Verbatim from the policy this facade is bound to — status reports the
        // posture, it does not re-derive it.
        trackerPosture: compiledPolicy.tracker,
        quarantinedWorkspaces,
        candidate: currentCandidateOf(views),
        pendingDecision: waiverLedgerOf(views).pending[0],
        registrationBinding: { recorded: recordedBinding, current: currentBinding, mismatch },
        lastWorkspaceDisposition: lastDisposition,
        terminationVerifiedAtCurrentFence:
          provenance !== undefined &&
          provenance.payload["fence"] === reduced.state.lastFence &&
          provenance.payload["descendantTeardown"] === "verified",
        workspaceBound: workspace !== undefined,
        nextCheckpoint: nextCheckpointOf(reduced.state.state, views),
        resume,
        blockers,
        policyRequiredInterruptions: confirmations + 1, // + the intake contract confirmation
        operatorInterventions: interventions,
      };

      return { ok: true, status: composeManagedStatus(composed) };
    },

    async listDeliveries({ observedAt }) {
      const root = path.join(await namespaceDir(), "deliveries");
      let ids: string[];
      try {
        // Directories only. A stray FILE in the namespace is not a delivery
        // whose state could not be read — it is not a delivery id at all, and
        // reporting it as unreadable would send an operator to ask `status`
        // about a name no delivery ever had.
        ids = (await readdir(root, { withFileTypes: true }))
          .filter((candidate) => candidate.isDirectory())
          .map((candidate) => candidate.name)
          .sort();
      } catch (error) {
        // ABSENCE ONLY. An installation that has registered nothing has no
        // directory at all, and that is an EMPTY listing rather than a
        // refusal: "nothing is running" is a true and useful answer, and
        // refusing it would make the one surface that reports
        // installation-wide quiet unavailable exactly when the installation is
        // quiet. Every OTHER failure is the opposite situation — the directory
        // exists and cannot be read — and answering it with the same empty
        // listing would report a positive claim of quiet built out of an
        // unreadable namespace, with not even an id left to reconcile by.
        // ENOENT ALONE. A path component that exists as a non-directory
        // raises `ENOTDIR`, and that is a corrupt namespace rather than an
        // installation that has registered nothing — swallowing it would
        // rebuild the very defect this discrimination exists to close.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          return refuse(
            "delivery_namespace_unreadable",
            "The installation's deliveries directory exists but cannot be read.",
            "Inspect the product namespace directory and its permissions; a listing that cannot read it reports nothing rather than nothing running.",
          );
        }
        return { ok: true, deliveries: [], unreadable: [] };
      }

      const listed: ListedDelivery[] = [];
      const unreadable: string[] = [];
      for (const deliveryId of ids) {
        const dir = path.join(root, deliveryId);
        const meta = await readJson<DeliveryMeta>(path.join(dir, "delivery.json"));
        // No registration record: either a stray directory, or the crash
        // window between registration's two writes. Either way there is no
        // state to report, so the id goes to `unreadable` rather than into a
        // listing entry with an invented state — and rather than nowhere.
        if (meta === undefined) {
          unreadable.push(deliveryId);
          continue;
        }
        const store = await journalStoreFor(deliveryId);
        const reduced = await store.state();
        const read = await store.read();
        // A journal that does not reduce has no state either. `status` with
        // this id refuses and says why; the listing names the id so an
        // operator can ask.
        if (!reduced.ok || !read.ok) {
          unreadable.push(deliveryId);
          continue;
        }
        // THE SAME PRECONDITION `status` ENFORCES, with the same three-way
        // comparison. A delivery whose two durable binding records do not both
        // agree with this facade's binding is one `status` refuses outright, so
        // listing its state would put the two modes of one surface in
        // contradiction by id: the listing would report `reviewing` for a
        // delivery the per-delivery mode will not report on at all. The id goes
        // to `unreadable` instead, which is exactly what that member is for —
        // `status` with it then gives the `policy_binding_mismatch` refusal and
        // says why.
        if (
          meta.policyBindingDigest !== policyBindingDigest ||
          reduced.state.policyBindingDigest !== policyBindingDigest ||
          meta.policyBindingDigest !== reduced.state.policyBindingDigest
        ) {
          unreadable.push(deliveryId);
          continue;
        }

        const views = viewsOf(read.entries);
        const workspace = await readJson<WorkspaceMeta>(path.join(dir, "workspace.json"));
        // Read only when a workspace is bound: a heartbeat file left behind by
        // a workspace that is gone is not this delivery's freshness.
        const observation =
          workspace === undefined
            ? undefined
            : await readJson<{ fence: number; observedAt: string }>(path.join(dir, "binding", "observation.json"));
        const lastActivity = lastOf(views, "activity.observed");
        const currentFence = reduced.state.lastFence;
        listed.push({
          deliveryId,
          state: reduced.state.state,
          lastActivity: {
            // The SAME rule the per-delivery status model applies, called
            // rather than re-derived: two surfaces that grade liveness
            // separately are two surfaces that eventually disagree.
            activity: gradeHostActivity({
              currentFence,
              lastObservedActivity:
                lastActivity === undefined
                  ? undefined
                  : {
                      activity: lastActivity.payload["activity"] as HostActivity,
                      fence: lastActivity.payload["fence"] as number,
                    },
              observationLifetimeSeconds: workspace?.observationLifetimeSeconds,
              observation,
              observedAt,
            }),
            // ONLY the stamp the grade itself accepted as evidence for this
            // fence. A heartbeat stamped under a SUPERSEDED fence is not this
            // invocation's freshness — `gradeHostActivity` discards it and
            // returns `unknown` — and reporting it anyway would tell an
            // operator "unknown, seen five seconds ago" during exactly the
            // re-fence window where no heartbeat for the current fence exists
            // at all. The fence advances on `invocation.fenced`; the heartbeat
            // is only rewritten on the host's next allowed PreToolUse.
            observedAt: observation?.fence === currentFence ? observation.observedAt : undefined,
          },
          pendingDecision: waiverLedgerOf(views).pending[0],
        });
      }
      return { ok: true, deliveries: listed, unreadable };
    },

    async nextCheckpoint({ deliveryId }) {
      const guarded = await guard(deliveryId);
      if (!("store" in guarded)) return guarded;
      return { ok: true, checkpoint: nextCheckpointOf(guarded.state, guarded.views) };
    },

    async submitStageResult({ deliveryId, stageId, resultBytes, fence }) {
      const expected: readonly DeliveryState[] = stageId === "plan" ? ["planning"] : ["compounding"];
      const guarded = await guard(deliveryId, { requireState: expected, verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const binding = workflowStageBindingFor(guarded.state);
      if (binding === undefined || binding.stageId !== stageId) {
        return refuse("wrong_stage", `Stage ${stageId} is not the bundled graph's checkpoint for ${guarded.state}.`, "Read `next-checkpoint`.");
      }
      const loaded = await loadGraph(guarded.generationRoot);
      if (!("graph" in loaded)) return loaded;

      const current = currentCandidateOf(guarded.views);
      if (stageId === "compound") {
        // No repository mutation may ride the compounding checkpoint.
        const treeSha = (await git(workspace.worktreeDir, "rev-parse", "HEAD^{tree}")).out;
        if (current !== undefined && treeSha !== current.treeSha) {
          const recorded = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "compounding", to: "validating" });
          if (!recorded.ok) return recorded;
          return { ok: true, state: "validating" };
        }
      }

      // The checkpoint reducer admits only a typed result validated against
      // the pinned graph, then evaluates the graph-declared prerequisites.
      const summaries = await retainedSummaries(deliveryId, guarded.views);
      const processed = processStageResult({
        resultBytes,
        graph: loaded.graph,
        graphSha256: loaded.graphSha256,
        stageId,
        deliveryId,
        ...(current === undefined ? {} : { currentCandidate: current.treeSha }),
        summaries,
        productRealized: binding.productRealizedPrerequisites,
      });
      if (!("result" in processed)) return processed;

      await writeOwned(persistedResultPath(await deliveryDir(deliveryId), processed.digest), processed.bytes);
      const stage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId,
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: processed.digest,
      });
      if (!stage.ok) return stage;

      if (processed.result.status !== "succeeded") {
        // A typed non-success result is persisted, then blocks with its own
        // actionable next step — it never advances the happy edge.
        await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
          code: `workflow.stage-${processed.result.status}`,
          summary: (processed.result.nextStep ?? `the ${stageId} stage reported ${processed.result.status}`).slice(0, 1900),
        });
        const blocked = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: guarded.state, to: "blocked" });
        if (!blocked.ok) return blocked;
        return { ok: true, state: "blocked" };
      }

      const to: DeliveryState = stageId === "plan" ? "implementing" : "admitting";
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: guarded.state, to });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: to };
    },

    async checkpointCandidate({ deliveryId, resultBytes, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["implementing", "remediating"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");

      const porcelain = await git(workspace.worktreeDir, "status", "--porcelain");
      if (porcelain.code !== 0 || porcelain.out !== "") {
        return refuse(
          "candidate_uncommitted",
          "The worktree carries uncommitted work; the host commits through its native git tooling before a checkpoint.",
          "Commit the mutation in the worktree, then checkpoint.",
        );
      }
      const treeSha = (await git(workspace.worktreeDir, "rev-parse", "HEAD^{tree}")).out;
      const branchRefValue = (await git(workspace.worktreeDir, "rev-parse", `refs/heads/${workspace.branchRef}`)).out;
      const previous = currentCandidateOf(guarded.views);

      // A candidate checkpoints only under a typed `implement` success whose
      // candidate reference is the INDEPENDENTLY captured tree above — the
      // released produced-on-success rule; a result cannot nominate its own.
      const loaded = await loadGraph(guarded.generationRoot);
      if (!("graph" in loaded)) return loaded;
      const summaries = await retainedSummaries(deliveryId, guarded.views);
      const processed = processStageResult({
        resultBytes,
        graph: loaded.graph,
        graphSha256: loaded.graphSha256,
        stageId: "implement",
        deliveryId,
        ...(previous === undefined ? {} : { currentCandidate: previous.treeSha }),
        producedCandidate: treeSha,
        summaries,
      });
      if (!("result" in processed)) return processed;
      if (processed.result.status !== "succeeded") {
        return refuse(
          "stage_result_rejected",
          "checkpointCandidate records a PRODUCED candidate; a non-success implement result checkpoints nothing.",
          "Checkpoint only a produced candidate; a blocked implementation is reported without a checkpoint.",
        );
      }

      const recaptured = await appendEntry(guarded.store, deliveryId, "candidate.recaptured", { treeSha, branchRefValue });
      if (!recaptured.ok) return recaptured;
      // A candidate change since a pending waiver/amendment proposal voids
      // the stale proposal with a typed blocker record — its criterion
      // binding must be re-evaluated against the new candidate. The delivery
      // does not leave its state for this; blocker.recorded alone never
      // suspends.
      if (previous === undefined || previous.treeSha !== treeSha) {
        // Exactly the proposals still pending — never one already consumed or
        // already voided; the ledger is the single reading of that.
        for (const pending of waiverLedgerOf(guarded.views).pending) {
          await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
            code: "approval.proposal-voided",
            summary:
              `the candidate changed since criterion ${pending.criterionId} was proposed; the stale proposal is void and must be re-proposed against the new candidate`.slice(
                0,
                1900,
              ),
          });
        }
      }
      // Every checkpointed revision — first implementation AND each
      // remediation — records its typed `implement` result: the graph's
      // produce-or-revise-candidate stage covers both.
      await writeOwned(persistedResultPath(await deliveryDir(deliveryId), processed.digest), processed.bytes);
      const stage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId: "implement",
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: processed.digest,
      });
      if (!stage.ok) return stage;
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", {
        from: guarded.state,
        to: "validating",
      });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "validating", treeSha };
    },

    async runSensor({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["validating"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");

      // The TRUSTED-BASE copy governs — never the candidate's tracked file.
      const trustedSensor = path.join(await deliveryDir(deliveryId), "trusted-sensor.mjs");
      const run = await exec.run({ command: process.execPath, args: [trustedSensor], cwd: workspace.worktreeDir });
      const outcome: "passed" | "failed" = run.code === 0 ? "passed" : "failed";
      const treeSha = (await git(workspace.worktreeDir, "rev-parse", "HEAD^{tree}")).out;
      const summaryRaw = `${run.stdout}\n${run.stderr}`.trim().slice(0, 1900);
      const result = {
        spec: "sensor-result/1",
        capabilityId: policyBinding.sensor.capabilityId,
        outcome,
        summary: summaryRaw.length > 0 ? summaryRaw : `sensor ${outcome} with no output`,
        candidateTreeSha: treeSha,
      };
      const shape = validateSensorResult(result);
      if (!shape.ok) {
        return refuse("sensor_result_rejected", "The sensor result is outside its frozen shape.", "Inspect the trusted sensor's output.");
      }
      const recorded = await appendEntry(guarded.store, deliveryId, "operation.result.recorded", {
        capabilityId: result.capabilityId,
        result,
      });
      if (!recorded.ok) return recorded;
      const to: DeliveryState = outcome === "passed" ? "reviewing" : "remediating";
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "validating", to });
      if (!transitioned.ok) return transitioned;
      return { ok: true, outcome, state: to };
    },

    async prepareProviderReviewHandoff({
      deliveryId,
      expectedFence,
      expectedWorkspaceId,
      nativeSessionId,
      nativeRunId,
      finalPassId,
      lensId,
      reviewWorkspaceDir,
      reviewInstructionsBytes,
      bindingCapability,
      invocationCapability,
    }) {
      const guarded = await guard(deliveryId, {
        requireState: ["reviewing"],
        verifyWorkspace: true,
        invokingFence: expectedFence,
        fenceRequired: true,
      });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      if (workspace.workspaceId !== expectedWorkspaceId || workspace.fence !== expectedFence) {
        return refuse(
          "provider_review_scope_mismatch",
          "The expected workspace or fence is no longer the standing invocation.",
          "Discard the delayed callback and prepare from the current host binding.",
        );
      }
      const authority = await readJson<ProviderReviewAuthorityState>(providerAuthorityStatePath(deliveryId));
      const grantDigest = stageGrantDigest;
      const currentTrust = await readTrust();
      if (
        currentTrust === undefined ||
        authority === undefined ||
        authority.deliveryId !== deliveryId ||
        authority.workspaceId !== workspace.workspaceId ||
        authority.fence !== workspace.fence ||
        authority.discoveryConfigurationDigest !== workspace.discoveryConfigurationDigest ||
        authority.grantDigest !== grantDigest ||
        authority.productTrustRevocationEpoch !== currentTrust.revocationEpoch
      ) {
        return refuse(
          "provider_binding_authority_unavailable",
          "The installation-owned provider-review authority is absent, stale, or disagrees with the admitted sandbox grant.",
          "Re-bind the workspace from the operator-owned host; repository state cannot recreate this authority.",
        );
      }
      if (!capabilityShape(bindingCapability) || bindingCapability.id !== authority.bindingCapability.id ||
        capabilityDigest({
          domain: "workspace",
          capability: bindingCapability,
          deliveryId,
          workspaceId: workspace.workspaceId,
          fence: workspace.fence,
          discoveryConfigurationDigest: workspace.discoveryConfigurationDigest,
          grantDigest,
          productTrustRevocationEpoch: currentTrust.revocationEpoch,
        }) !== authority.bindingCapability.digest) {
        return refuse(
          "provider_binding_capability_refused",
          "The caller cannot prove the operator-owned provider-review binding for this delivery and fence.",
          "Only the host that retained the root capability may prepare a native reviewer invocation.",
        );
      }
      if (!capabilityShape(invocationCapability)) {
        return refuse(
          "provider_invocation_capability_invalid",
          "The native invocation capability is missing or malformed.",
          "Have the operator-owned host create a fresh high-entropy capability for this one reviewer invocation.",
        );
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(nativeSessionId)) {
        return refuse("provider_session_invalid", "The expected native session identity is empty or unsafe.", "Use the exact host-native session identifier.");
      }
      if (reviewInstructionsBytes.length === 0) {
        return refuse("provider_context_invalid", "The exact reviewer prompt/context bytes are empty.", "Bind the exact bytes the host will submit to the native reviewer.");
      }
      const current = currentCandidateOf(guarded.views);
      if (current === undefined) return refuse("no_candidate", "No candidate is checkpointed.", "Checkpoint a candidate first.");

      const providerRegistration = config.providers[0];
      if (providerRegistration === undefined) {
        return refuse("no_provider", "The repository gate registers no provider.", "Register the review provider in the harness config.");
      }
      const artifacts = createArtifactsPort();
      const allocation = await artifacts.allocateRunRoot({ providerId: providerRegistration.id, runId: nativeRunId });
      if (!allocation.ok) {
        return refuse(
          "provider_run_invalid",
          `The native run identity cannot name an evidence run root: ${allocation.reason}.`,
          "Use the native host's safe run identifier without rewriting it into a path.",
        );
      }
      if (finalPassId.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(finalPassId)) {
        return refuse("provider_pass_invalid", "The native final-pass identity is empty or unsafe.", "Use the native host's final-pass identifier.");
      }

      let mutableRoot: string;
      let reviewRoot: string;
      try {
        [mutableRoot, reviewRoot] = await Promise.all([realpath(workspace.worktreeDir), realpath(reviewWorkspaceDir)]);
      } catch {
        return refuse("provider_review_workspace_invalid", "The host-created review snapshot is absent or unresolved.", "Create a distinct linked review snapshot before preparing the handoff.");
      }
      if (reviewRoot === mutableRoot || reviewRoot.startsWith(`${mutableRoot}${path.sep}`) || mutableRoot.startsWith(`${reviewRoot}${path.sep}`)) {
        return refuse("provider_review_workspace_invalid", "The review snapshot overlaps the mutable delivery worktree.", "Have the trusted operator-owned host create a distinct snapshot outside every model/reviewer writable root.");
      }
      const commonReview = await git(reviewRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const commonMutable = await git(mutableRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
      if (commonReview.code !== 0 || commonReview.out !== commonMutable.out) {
        return refuse("provider_review_workspace_invalid", "The review snapshot is not a linked workspace of the bound repository.", "Create it from the bound repository's common Git directory.");
      }
      const mutableCapture = await captureFor(mutableRoot, config, candidateRunner, storageGitRunner);
      if (!mutableCapture.ok) return mutableCapture.failure;
      const capture = await captureFor(reviewRoot, config, candidateRunner, storageGitRunner);
      if (!capture.ok) return capture.failure;
      if (mutableCapture.candidate.treeSha !== current.treeSha || capture.candidate.treeSha !== current.treeSha) {
        return refuse("candidate_moved", "The worktree moved before the native review handoff.", "Re-checkpoint the candidate, then prepare the review handoff again.");
      }

      const productTrustRevocationEpoch = currentTrust.revocationEpoch;

      const lens = guarded.meta.policy.reviewLenses.find((entry) => entry.lensId === lensId);
      if (lens === undefined) {
        return refuse("provider_lens_unselected", `Review lens ${lensId} is not selected by policy.`, "Prepare exactly one policy-selected reviewer invocation.");
      }
      const charterPath = path.join(await deliveryDir(deliveryId), "personas", `${lens.personaId}.md`);
      let charterBytes: string;
      try {
        charterBytes = await readFile(charterPath, "utf8");
      } catch {
        return refuse("reviewer_charter_unavailable", `The trusted pre-run copy of reviewer charter ${lens.personaId} is missing.`, "Re-prepare the delivery from the trusted base.");
      }
      if (sha256Hex(charterBytes) !== lens.personaDigest) {
        return refuse("reviewer_charter_unavailable", `The trusted reviewer charter ${lens.personaId} no longer matches policy.`, "Quarantine and re-prepare the delivery.");
      }

      const candidate = {
        vcs: capture.candidate.vcs,
        treeSha: capture.candidate.treeSha,
        headSha: capture.candidate.headSha,
        deliverable: capture.candidate.deliverable,
        base: capture.candidate.base,
        workspaceId: capture.candidate.workspaceId,
      } as const;
      const sensorEvidence = sensorResultsOf(guarded.views).filter((result) => result.candidateTreeSha === current.treeSha);
      const handoff = createProviderReviewHandoff({
        handoffId: `handoff-${hex(8)}`,
        deliveryId,
        provider: {
          id: providerRegistration.id,
          version: input.hostVersion,
          runId: nativeRunId,
          finalPassId,
        },
        nativeSessionId,
        workspaceId: workspace.workspaceId,
        fence: guarded.lastFence,
        productTrustRevocationEpoch,
        candidate,
        reviewInstructionsBytes,
        contractBytes: `${JSON.stringify(guarded.meta.contract, null, 2)}\n`,
        sensorEvidenceBytes: `${JSON.stringify(sensorEvidence, null, 2)}\n`,
        reviewer: {
          attemptId: `attempt-${hex(8)}`,
          lensId: lens.lensId,
          personaId: lens.personaId,
          personaDigest: lens.personaDigest,
          personaBytes: charterBytes,
        },
      });
      const handoffDir = path.join(await deliveryDir(deliveryId), "binding", "provider-review-handoffs");
      const handoffPath = path.join(handoffDir, `${handoff.handoffId}.json`);
      const invocationCapabilityBinding: CapabilityBinding = {
        id: invocationCapability.id,
        digest: capabilityDigest({
          domain: "review-invocation",
          capability: invocationCapability,
          deliveryId,
          workspaceId: workspace.workspaceId,
          fence: workspace.fence,
          handoffId: handoff.handoffId,
          nativeSessionId,
          nativeRunId,
          promptContextDigest: handoff.promptContextDigest,
          productTrustRevocationEpoch,
          reviewWorkspaceId: handoff.candidate.workspaceId,
        }),
      };
      await artifacts.writeTextFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, { mode: OWNER_FILE });
      await writeOwned(
        providerHandoffAuthorityPath(deliveryId, handoff.handoffId),
        `${JSON.stringify({ handoff, invocationCapability: invocationCapabilityBinding, reviewWorkspaceDir: reviewRoot } satisfies StoredProviderReviewHandoff, null, 2)}\n`,
      );
      return { ok: true, handoff, handoffPath };
    },

    async ingestProviderReviewResult({ deliveryId, handoffId, resultBytes, fence, invocationCapability }) {
      const guarded = await guard(deliveryId, {
        requireState: ["reviewing"],
        verifyWorkspace: true,
        invokingFence: fence,
        fenceRequired: true,
      });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");

      const stored = await readJson<StoredProviderReviewHandoff>(providerHandoffAuthorityPath(deliveryId, handoffId));
      if (stored === undefined) {
        return refuse("provider_handoff_missing", `Provider result ${handoffId} has no binding-owned handoff.`, "Prepare the native reviewer invocation first.");
      }
      const handoff = stored.handoff;
      const currentTrust = await readTrust();
      const trustEpochFailure = (): FacadeFailure => refuse(
        "provider_trust_epoch_mismatch",
        "The product trust revocation epoch advanced after this provider binding was prepared.",
        "Discard this callback. Use the existing operator-authorized takeover into a fresh host-created workspace and prepare review again, or cancel this delivery and start a replacement.",
      );
      if (!capabilityShape(invocationCapability) || invocationCapability.id !== stored.invocationCapability.id ||
        capabilityDigest({
          domain: "review-invocation",
          capability: invocationCapability,
          deliveryId,
          workspaceId: handoff.workspaceId,
          fence: handoff.fence,
          handoffId,
          nativeSessionId: handoff.nativeSessionId,
          nativeRunId: handoff.provider.runId,
          promptContextDigest: handoff.promptContextDigest,
          productTrustRevocationEpoch: handoff.productTrustRevocationEpoch,
          reviewWorkspaceId: handoff.candidate.workspaceId,
        }) !== stored.invocationCapability.digest) {
        return refuse(
          "provider_invocation_capability_refused",
          "The callback cannot prove the invocation-scoped capability bound before native review launch.",
          "Only the operator-owned host closure that launched this invocation may ingest its result.",
        );
      }
      if (handoff.deliveryId !== deliveryId || handoff.workspaceId !== workspace.workspaceId || handoff.fence !== fence) {
        return refuse(
          "provider_review_scope_mismatch",
          "The native callback belongs to a superseded delivery, workspace, or fence.",
          "Discard the delayed callback and prepare a new invocation from the standing workspace.",
        );
      }
      if (currentTrust === undefined || currentTrust.revocationEpoch !== handoff.productTrustRevocationEpoch) {
        return trustEpochFailure();
      }

      const parsed = parseProviderReviewResult(resultBytes);
      if (!parsed.ok) {
        await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
          code: "review.provider-result-invalid",
          summary: parsed.message,
        });
        return refuse(parsed.code, parsed.message, "Have the qualified host binding emit the complete provider-review-result/1 envelope.");
      }
      const result = parsed.result;
      if (result.handoffId !== handoffId) {
        return refuse("provider_result_binding_mismatch", "The result names a different handoff.", "Submit the result to its exact invocation handoff.");
      }

      const artifacts = createArtifactsPort();
      const refuseResult = async (code: string, summary: string, remediation: string): Promise<FacadeFailure> => {
        await appendEntry(guarded.store, deliveryId, "blocker.recorded", { code: `review.${code.replaceAll("_", "-")}`, summary });
        return refuse(code, summary, remediation);
      };

      const { nativeEnvelopeBytes: _nativeEnvelopeBytes, nativeEnvelopeDigest: _nativeEnvelopeDigest, terminalState: _terminal, verdict: _verdict, findings: _findings, ...echoedResult } = result;
      const echoedHandoff = { ...echoedResult, spec: handoff.spec };
      if (digestCanonical(echoedHandoff) !== digestCanonical(handoff)) {
        return refuseResult(
          "provider_result_binding_mismatch",
          "The native result does not repeat its binding-owned provider, session, scope, candidate, persona, and context identities exactly.",
          "Discard the mismatched result and complete a fresh review from the standing handoff.",
        );
      }
      const normalizedResultBytes = `${JSON.stringify(result, null, 2)}\n`;
      const artifactDigest = sha256Hex(normalizedResultBytes);
      const providerRunKey = providerRunKeyOf(result);
      const runSuspendedFailure = (): FacadeFailure => refuse(
        "provider_result_run_suspended",
        `Provider run ${result.provider.runId}/${result.provider.finalPassId} is suspended by a conflicting replay.`,
        "Complete a coherent fresh run under new native run and final-pass identities.",
      );
      const ensureProviderRunSuspended = async (): Promise<{ readonly ok: true } | FacadeFailure> => {
        // A conflict marker is itself journal-fenced. Two distinct conflicts
        // may observe one revision; the loser reloads and appends against the
        // next revision until THIS exact tuple is durably observable.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const observed = await guarded.store.read();
          if (!observed.ok) {
            return refuse("journal_unreadable", "The delivery journal is unreadable while suspending a conflicted provider run.", "Inspect the durable journal file.");
          }
          if (suspendedProviderRunKeysOf(viewsOf(observed.entries)).has(providerRunKey)) return { ok: true };
          const appended = await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
            code: "review.result-replay-conflict",
            summary: `handoff ${result.handoffId} was replayed with different provider-result bytes`,
            providerRunKey,
          });
          if (!appended.ok) continue;
        }
        const observed = await guarded.store.read();
        if (observed.ok && suspendedProviderRunKeysOf(viewsOf(observed.entries)).has(providerRunKey)) return { ok: true };
        return refuse(
          "journal_rejected",
          `The conflict marker for provider run ${result.provider.runId}/${result.provider.finalPassId} could not be made durable.`,
          "Reload the standing delivery journal; no result from this conflicted tuple may be accepted.",
        );
      };
      const replayAgainst = async (views: readonly JournalEntryView[]): Promise<
        | { readonly ok: true; readonly replay: "identical"; readonly disposition: "approved" | "changes_requested" }
        | FacadeFailure
        | undefined
      > => {
        if (suspendedProviderRunKeysOf(views).has(providerRunKey)) return runSuspendedFailure();
        const existingAttempt = recordedProviderAttemptsOf(views).find(
          (candidate) => candidate.attemptId === result.reviewer.attemptId,
        );
        if (existingAttempt === undefined) return undefined;
        const conflict =
          existingAttempt.lensId !== result.reviewer.lensId ||
          existingAttempt.contextDigest !== result.reviewer.contextDigest ||
          existingAttempt.personaDigest !== result.reviewer.personaDigest ||
          existingAttempt.artifactDigest !== artifactDigest;
        if (conflict) {
          const suspended = await ensureProviderRunSuspended();
          if (!suspended.ok) return suspended;
          return refuse(
            "provider_result_replay_conflict",
            `Handoff ${result.handoffId} already has a different immutable result.`,
            "Treat the native run as conflicted and complete a fresh run under a new handoff.",
          );
        }
        const accepted = await acceptedProviderResultsOf(deliveryId, views);
        if (!accepted.ok) return accepted;
        const existing = accepted.results.find((candidate) => candidate.reviewer.attemptId === result.reviewer.attemptId);
        if (existing === undefined) {
          return refuse(
            "provider_result_artifact_unavailable",
            `Accepted provider result ${result.reviewer.attemptId} cannot be reconstructed from its journaled content address.`,
            "Restore the exact content-addressed result bytes; never append a replacement acceptance.",
          );
        }
        return { ok: true, replay: "identical", disposition: existing.verdict };
      };
      const replay = await replayAgainst(guarded.views);
      if (replay !== undefined) return replay;
      const current = currentCandidateOf(guarded.views);
      if (current === undefined) return refuse("no_candidate", "No candidate is checkpointed.", "Checkpoint a candidate first.");
      const captures = await captureProviderPair(workspace.worktreeDir, stored.reviewWorkspaceDir);
      if (!captures.ok) {
        return refuseResult("provider_result_review_workspace_unavailable", "The mutable candidate or host-created review snapshot is missing or invalid at ingestion.", "The trusted operator-owned host must retain the exact reviewer-read-only snapshot until its native result is ingested.");
      }
      const mutableCapture = { candidate: captures.mutable };
      const capture = { candidate: captures.review };
      const currentCandidate = {
        vcs: capture.candidate.vcs,
        treeSha: capture.candidate.treeSha,
        headSha: capture.candidate.headSha,
        deliverable: capture.candidate.deliverable,
        base: capture.candidate.base,
        workspaceId: capture.candidate.workspaceId,
      };
      if (current.treeSha !== mutableCapture.candidate.treeSha || current.treeSha !== capture.candidate.treeSha || digestCanonical(currentCandidate) !== digestCanonical(result.candidate)) {
        return refuseResult(
          "provider_result_candidate_moved",
          "The candidate or deliverable identity changed after the native review handoff.",
          "Checkpoint the changed candidate and complete a fresh native review.",
        );
      }
      if (result.terminalState !== "completed") {
        return refuseResult(
          "provider_result_not_completed",
          `The native provider run ended ${result.terminalState}; a partial or failed run qualifies no attempt.`,
          "Complete a fresh native review run successfully.",
        );
      }
      const reviewPayloadSpec = config.obligations.find((obligation) => obligation.id === "review.green")
        ?.acceptedPayloadSpecs.includes(REVIEW_GREEN_2) === true ? REVIEW_GREEN_2 : REVIEW_GREEN_1;
      const coherenceCodes = result.findings.flatMap(
        reviewPayloadSpec === REVIEW_GREEN_2 ? reviewFindingCoherenceCodesV2 : reviewFindingCoherenceCodes,
      );
      const verdictCoherent = result.verdict === "approved" ? coherenceCodes.length === 0 : result.findings.length > 0;
      if (!verdictCoherent) {
        return refuseResult(
          result.verdict === "approved" ? "provider_result_not_review_green" : "provider_result_verdict_incoherent",
          result.verdict === "approved"
            ? `The approved provider result contradicts review-green coherence: ${[...new Set(coherenceCodes)].join(", ")}.`
            : "The provider verdict, reviewer verdicts, and findings do not describe one complete terminal result.",
          "Complete a fresh native review whose structured conclusion is internally coherent.",
        );
      }

      const allocation = await artifacts.allocateRunRoot({ providerId: result.provider.id, runId: result.provider.runId });
      if (!allocation.ok) {
        return refuseResult(
          "provider_run_invalid",
          `The provider run root is unavailable: ${allocation.reason}.`,
          "Complete a fresh run with a safe native run identity.",
        );
      }
      const acceptanceTrust = await readTrust();
      if (acceptanceTrust === undefined || acceptanceTrust.revocationEpoch !== handoff.productTrustRevocationEpoch) {
        return trustEpochFailure();
      }
      // The normalized bytes may be written first, but do not exist as
      // accepted evidence until this ONE append succeeds. The journal entry is
      // the sole acceptance/replay authority and contains the attempt binding
      // and its content address atomically.
      await writeOwned(persistedResultPath(await deliveryDir(deliveryId), artifactDigest), normalizedResultBytes);
      const recorded = await guarded.store.append({
        spec: "journal-entry/1",
        journal: "delivery",
        subjectId: deliveryId,
        expectedRevision: guarded.expectedRevision,
        idempotencyKey: `provider-attempt-${result.reviewer.attemptId}`,
        kind: "attempt.artifact.recorded",
        payload: {
          attemptId: result.reviewer.attemptId,
          lensId: result.reviewer.lensId,
          contextDigest: result.reviewer.contextDigest,
          personaDigest: result.reviewer.personaDigest,
          artifactDigest,
        },
      });
      if (!recorded.ok) {
        const raced = await guarded.store.read();
        if (!raced.ok) return refuse("journal_unreadable", "The delivery journal is unreadable after an acceptance race.", "Inspect the durable journal file.");
        const resolved = await replayAgainst(viewsOf(raced.entries));
        if (resolved !== undefined) return resolved;
        return refuse(
          "journal_rejected",
          `The guarded attempt acceptance lost its journal CAS: ${recorded.rejections.map((rejection) => rejection.message).join("; ")}`,
          "Reload the standing delivery journal and retry only from its current checkpoint.",
        );
      }
      // A convenient provider-run copy is retained only AFTER journal
      // acceptance. Its absence cannot create or revoke an accepted attempt.
      await artifacts.writeTextFile(
        path.join(allocation.runRoot.path, `provider-result-${result.reviewer.attemptId}.json`),
        normalizedResultBytes,
        { mode: OWNER_FILE },
      ).catch(() => undefined);
      return { ok: true, replay: "recorded", disposition: result.verdict };
    },

    async reduceReview({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["reviewing"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const current = currentCandidateOf(guarded.views);
      if (current === undefined) return refuse("no_candidate", "No candidate is checkpointed.", "Checkpoint a candidate first.");
      const accepted = await attemptsOf(deliveryId, guarded.views);
      if (!accepted.ok) return accepted;
      const attempts = accepted.attempts.filter((attempt) => attempt.candidateTreeSha === current.treeSha);

      const floor = checkReviewFloor({
        attempts,
        lenses: guarded.meta.policy.reviewLenses.map((selected) => ({
          lensId: selected.lensId,
          category: selected.category,
          personaDigest: selected.personaDigest,
        })),
        candidateTreeSha: current.treeSha,
      });
      if (!floor.ok) {
        return refuse(
          "review_floor_unmet",
          `The mandatory review floor is not met: ${floor.rejections.map((rejection) => rejection.message).join("; ")}`,
          "Complete both mandatory lenses as distinct attempts with independently constructed contexts.",
        );
      }

      const acceptedResults = accepted.results.filter((result) =>
        result.candidate.treeSha === current.treeSha && attempts.some((attempt) => attempt.attemptId === result.reviewer.attemptId),
      );
      const providerRuns = new Set(acceptedResults.map((result) =>
        `${result.provider.id}\u0000${result.provider.version}\u0000${result.provider.runId}\u0000${result.provider.finalPassId}`,
      ));
      const nativeSessions = new Set(acceptedResults.map((result) => result.nativeSessionId));
      if (providerRuns.size !== 1 || nativeSessions.size !== acceptedResults.length) {
        return refuse(
          "provider_result_unqualified",
          "Mandatory reviewer approvals must be distinct native child sessions of one exact provider run and final pass.",
          "Complete each selected reviewer as a distinct child invocation inside one provider run and final pass.",
        );
      }

      const loaded = await loadGraph(guarded.generationRoot);
      if (!("graph" in loaded)) return loaded;
      const summaries = await retainedSummaries(deliveryId, guarded.views);
      const dir = await deliveryDir(deliveryId);

      // A repair round follows recorded changes-requested evidence — the
      // graph's own repair-loop prerequisite, satisfied by the retained
      // review.reduce summary of the previous round.
      const repairLoop = summaries.get("review.reduce")?.outputKind === "review-round-changes-requested";

      // The product composes the review stage results itself, but they pass
      // through the SAME released-contract validation as host-submitted
      // results — the parity the qualification corpus freezes.
      const composeReviewResult = (stageId: "review.acquire" | "review.reduce", outputKind: string, evidence: unknown, evidenceRefs: readonly string[]) =>
        JSON.stringify({
          schemaVersion: WORKFLOW_STAGE_RESULT_SPEC,
          release: RELEASE_IDENTITY,
          graphSha256: loaded.graphSha256,
          stageId,
          subjectRef: { schemaVersion: WORKFLOW_SUBJECT_REF_SPEC, opaque: deliveryId },
          candidateRef: { schemaVersion: WORKFLOW_CANDIDATE_REF_SPEC, opaque: current.treeSha },
          status: "succeeded",
          output: { kind: outputKind, evidenceRef: digestCanonical(evidence) },
          evidenceRefs,
          limitations: [],
        });

      const acquisitionBytes = composeReviewResult(
        "review.acquire",
        "review-acquisition-envelope",
        attempts,
        attempts.map((attempt) => attempt.attemptId),
      );
      const processedAcquire = processStageResult({
        resultBytes: acquisitionBytes,
        graph: loaded.graph,
        graphSha256: loaded.graphSha256,
        stageId: "review.acquire",
        deliveryId,
        currentCandidate: current.treeSha,
        summaries,
        repairLoop,
      });
      if (!("result" in processedAcquire)) return processedAcquire;
      await writeOwned(persistedResultPath(dir, processedAcquire.digest), processedAcquire.bytes);
      const acquireStage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId: "review.acquire",
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: processedAcquire.digest,
      });
      if (!acquireStage.ok) return acquireStage;

      const qualified = qualifyReviewAttempts(attempts, current.treeSha).qualified;
      const anyFindings = qualified.some((attempt) => attempt.verdict === "findings");
      const roundKind = anyFindings ? "review-round-changes-requested" : "review-round-aligned";
      const reductionBytes = composeReviewResult("review.reduce", roundKind, qualified, []);
      const reduceSummaries = new Map(summaries);
      reduceSummaries.set("review.acquire", { status: "succeeded", outputKind: "review-acquisition-envelope" });
      const processedReduce = processStageResult({
        resultBytes: reductionBytes,
        graph: loaded.graph,
        graphSha256: loaded.graphSha256,
        stageId: "review.reduce",
        deliveryId,
        currentCandidate: current.treeSha,
        summaries: reduceSummaries,
      });
      if (!("result" in processedReduce)) return processedReduce;
      await writeOwned(persistedResultPath(dir, processedReduce.digest), processedReduce.bytes);
      const reduceStage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId: "review.reduce",
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: processedReduce.digest,
      });
      if (!reduceStage.ok) return reduceStage;

      if (anyFindings) {
        // Review repeats until the selected lenses approve — but bounded: a
        // findings round beyond the bound records a typed blocker instead of
        // spinning the loop unobserved.
        let changesRequestedRounds = 1; // this round
        for (const view of guarded.views) {
          if (view.kind !== "stage.result.recorded" || view.payload["stageId"] !== "review.reduce") continue;
          const persisted = await persistedResultOf(dir, view.payload["resultDigest"] as string);
          // The JOURNAL records that the round happened; the persisted document
          // only says which way it went. An unresolvable record therefore
          // counts — deleting or tampering the persistence must not reset the
          // bound and reopen an unbounded loop.
          if (persisted === undefined || persisted.outputKind === "review-round-changes-requested") changesRequestedRounds += 1;
        }
        if (changesRequestedRounds > REVIEW_ROUND_BOUND) {
          await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
            code: "review.loop-bound-reached",
            summary: `review round ${changesRequestedRounds} still requests changes; after ${REVIEW_ROUND_BOUND} findings-driven rounds the loop records a bounded blocker instead of repeating`,
          });
          const blocked = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "reviewing", to: "blocked" });
          if (!blocked.ok) return blocked;
          return { ok: true, state: "blocked" };
        }
      }

      const to: DeliveryState = anyFindings ? "remediating" : "compounding";
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "reviewing", to });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: to };
    },

    async admit({ deliveryId, recordedAtInstant, env, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["admitting"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const current = currentCandidateOf(guarded.views);
      if (current === undefined) return refuse("no_candidate", "No candidate is checkpointed.", "Checkpoint a candidate first.");

      // Vacuous satisfaction is excluded: the compiled policy's obligation set
      // is non-empty by construction, and admission evaluates every one.
      const accepted = await attemptsOf(deliveryId, guarded.views);
      if (!accepted.ok) return accepted;
      const attempts = accepted.attempts.filter((attempt) => attempt.candidateTreeSha === current.treeSha);
      const floor = checkReviewFloor({
        attempts,
        lenses: guarded.meta.policy.reviewLenses.map((selected) => ({
          lensId: selected.lensId,
          category: selected.category,
          personaDigest: selected.personaDigest,
        })),
        candidateTreeSha: current.treeSha,
      });
      if (!floor.ok) {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "review.floor-unmet",
          floor.rejections.map((rejection) => rejection.message).join("; ").slice(0, 1900),
          "blocked",
        );
        return refuse("review_floor_unmet", "The mandatory review floor is not met at admission.", "Complete both mandatory lenses on the exact candidate.");
      }

      const rootDir = workspace.worktreeDir;
      const capture = await captureFor(rootDir, config, candidateRunner, storageGitRunner);
      if (!capture.ok) return capture.failure;
      const captured = capture.candidate;
      if (captured.treeSha !== current.treeSha) {
        return refuse("candidate_moved", "The worktree moved after its last checkpoint.", "Re-checkpoint the candidate, then admit.");
      }

      const outcome = composeOutcomeVerification({
        contract: guarded.meta.contract,
        candidate: { treeSha: current.treeSha, deliverableDigest: captured.deliverable.digest },
        sensorResults: sensorResultsOf(guarded.views),
        attempts,
        // A waiver is candidate-bound evidence: one approved against an
        // earlier candidate says nothing about this one.
        waivedCriteria: waiverLedgerOf(guarded.views).consumed.filter(
          (waiver) => waiver.candidateTreeSha === current.treeSha,
        ),
      });

      const unresolved = outcome.criteria.filter((criterion) => criterion.disposition === "blocked");
      if (unresolved.length > 0) {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "outcome.criterion-unverified",
          `criterion mapping failed: ${unresolved.map((criterion) => `${criterion.criterionId} (${criterion.evidence.reference})`).join("; ")}`.slice(0, 1900),
          "blocked",
        );
        return refuse(
          "criterion_unverified",
          "An acceptance criterion carries no passing exact-candidate evidence; a green-but-unrelated change fails criterion mapping.",
          "Satisfy the criterion's sensor on the exact candidate, then re-validate.",
        );
      }

      // The blanket-waiver rule, stated at admission as well as at the finish
      // line: waiving every criterion is not a delivery that succeeded.
      const positive = checkPositiveCriterion(outcome.criteria);
      if (!positive.ok) {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "outcome.blanket-waiver",
          positive.blockers.map((blocker) => blocker.message).join("; ").slice(0, 1900),
          "blocked",
        );
        return refuse(
          "blanket_waiver",
          "No acceptance criterion passed; a blanket waiver cannot produce delivery success.",
          "Rescope or cancel the delivery; at least one positive criterion must actually pass.",
        );
      }

      // The EXISTING harness admission: preparation receipt, evidence
      // manifest from the two lens attempts, submission, and the gate.
      const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace, runGit: storageGitRunner });
      await publishPreparationReceipt(rootDir, { config, candidate: captured }, { storageNamespace: config.storageNamespace, runGit: storageGitRunner });

      const artifacts = createArtifactsPort();
      const qualified = qualifyReviewAttempts(attempts, current.treeSha).qualified;
      const qualifiedIds = new Set(qualified.map((attempt) => attempt.attemptId));
      const selectedLenses = [...guarded.meta.policy.reviewLenses.map((lens) => lens.lensId)].sort();
      const acceptedResults = accepted.results.filter((result) =>
        result.terminalState === "completed" &&
        result.verdict === "approved" &&
        result.candidate.treeSha === current.treeSha &&
        qualifiedIds.has(result.reviewer.attemptId),
      );
      const providerResults = selectedLenses.map((lensId) => {
        const matches = acceptedResults.filter((result) => result.reviewer.lensId === lensId);
        return matches.length === 1 ? matches[0] : undefined;
      });
      const providerRuns = new Set(acceptedResults.map((result) =>
        `${result.provider.id}\u0000${result.provider.version}\u0000${result.provider.runId}\u0000${result.provider.finalPassId}`,
      ));
      const nativeSessions = new Set(acceptedResults.map((result) => result.nativeSessionId));
      if (
        providerResults.some((result) => result === undefined) ||
        acceptedResults.length !== selectedLenses.length ||
        providerRuns.size !== 1 ||
        nativeSessions.size !== selectedLenses.length
      ) {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "review.provider-result-unqualified",
          "each mandatory lens requires one distinct native child invocation inside the same binding-owned provider run and final pass on the exact candidate",
          "blocked",
        );
        return refuse(
          "provider_result_unqualified",
          "Admission has no coherent one-run native invocation receipt set for every mandatory lens.",
          "Complete one distinct native child invocation per selected reviewer within one provider run and final pass, then re-enter admission.",
        );
      }
      const completeProviderResults = providerResults as ProviderReviewResult[];
      const providerResult = completeProviderResults[0];
      if (providerResult === undefined) throw new Error("unreachable provider result selection");
      const provider = providerResult.provider;
      const allocation = await artifacts.allocateRunRoot({ providerId: provider.id, runId: provider.runId });
      if (!allocation.ok) {
        return refuse("run_root_refused", `The artifacts port refused a run root: ${allocation.reason}`, "Inspect the artifacts port.");
      }
      const runRoot = allocation.runRoot.path;
      const candidateForManifest = {
        vcs: captured.vcs,
        treeSha: captured.treeSha,
        headSha: captured.headSha,
        deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
        base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
        workspaceId: captured.workspaceId,
      };
      const manifestArtifacts: { path: string; sha256: string; role: string }[] = [];
      await mkdir(path.join(runRoot, "provider-results"), { recursive: true });
      await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
      for (const result of completeProviderResults) {
        const reviewer = result.reviewer;
        const attempt = qualified.find((candidate) => candidate.attemptId === reviewer.attemptId);
        if (attempt === undefined) {
          return refuse("provider_result_unqualified", `Attempt ${reviewer.attemptId} no longer qualifies.`, "Complete a fresh native provider run.");
        }
        const normalizedProviderResultBytes = `${JSON.stringify(result, null, 2)}\n`;
        const providerResultRelative = `provider-results/${reviewer.lensId}.json`;
        await writeFile(path.join(runRoot, providerResultRelative), normalizedProviderResultBytes, "utf8");
        manifestArtifacts.push({ path: providerResultRelative, sha256: sha256Hex(normalizedProviderResultBytes), role: "provider-review-result" });
        // The reviewer-approval artifact keeps the recorder's closed grammar;
        // the attempt identity, context digest, and artifact digest are bound
        // in the delivery journal's attempt records, not smuggled in here.
        const approval = `${JSON.stringify({
          schemaVersion: 1,
          reviewerId: attempt.lensId,
          result: attempt.verdict === "approved" ? "approved" : "changes-requested",
          // The frozen delivery-evidence schema has one envelope provider.
          // Per-review native run identities remain exact in the adjacent
          // provider-result artifacts and in the journaled attempt digests.
          provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId },
          workspaceId: captured.workspaceId,
          candidate: candidateForManifest,
        }, null, 2)}\n`;
        const relative = `reviewers/${attempt.lensId}.json`;
        await writeFile(path.join(runRoot, relative), approval, "utf8");
        manifestArtifacts.push({ path: relative, sha256: sha256Hex(approval), role: "reviewer-approval" });
      }
      const manifest = {
        spec: "delivery-evidence/1",
        provider,
        candidate: candidateForManifest,
        repository: null,
        runHistory: [{ preparedTreeSha: captured.treeSha, evaluatedInPassId: provider.finalPassId }],
        artifacts: manifestArtifacts,
        attestation: { level: "self", signatures: [] },
        recordedAt: recordedAtInstant,
        claims: [
          {
            obligation: "review.green",
            payloadSpec: config.obligations.find((obligation) => obligation.id === "review.green")
              ?.acceptedPayloadSpecs.includes(REVIEW_GREEN_2) === true ? REVIEW_GREEN_2 : REVIEW_GREEN_1,
            payload: {
              verdict: "green",
              finalized: true,
              editedAfterFinalPass: false,
              reviewers: {
                selected: selectedLenses,
                completed: completeProviderResults.map((result) => result.reviewer.lensId).sort(),
                failed: [],
                timedOut: [],
              },
              findings: completeProviderResults.flatMap((result) => result.findings),
              telemetry: {
                iterationCount: 1,
                findingCounts: Object.fromEntries(
                  ["P0", "P1", "P2", "P3"].map((severity) => [
                    severity,
                    completeProviderResults.flatMap((result) => result.findings).filter((finding) => finding.severity === severity).length,
                  ]),
                ),
                deferredExpansionCount: completeProviderResults.flatMap((result) => result.findings).filter((finding) => finding.disposition === "deferred").length,
                deferredIssueIds: [
                  ...new Set(
                    completeProviderResults.flatMap((result) => result.findings)
                      .filter((finding) => finding.disposition === "deferred")
                      .map((finding) => finding.deferredIssueId)
                      .filter((issueId): issueId is string => issueId !== undefined),
                  ),
                ].sort(),
              },
            },
          },
        ],
      };
      const manifestPath = path.join(runRoot, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const submission = await submitManifest(
        { rootDir, manifestPath, config },
        { captureCandidate: capture.captureCandidate, artifacts, storageNamespace: config.storageNamespace, runGit: storageGitRunner },
      );
      if (submission.status !== "accepted") {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "evidence.rejected",
          submission.blockers.map((blocker) => blocker.summary).join("; ").slice(0, 1900),
          "blocked",
        );
        return refuseWith(submission.blockers);
      }

      const admission = await runAdmission(
        { rootDir, config, context: classifyExecutionContext({ config, env, stdinIsTTY: false, stdoutIsTTY: false }) },
        {
          captureCandidate: capture.captureCandidate,
          projectActivation: (candidate: CapturedCandidate) => evaluateCandidateActivation({ rootDir, candidate, config, run: candidateRunner }),
          storageNamespace: config.storageNamespace,
          runGit: storageGitRunner,
        },
      );
      if (!admission.admitted) {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "admission.refused",
          admission.blockers.map((blocker) => blocker.summary).join("; ").slice(0, 1900),
          "blocked",
        );
        return refuseWith(admission.blockers);
      }

      const record = submission.records[0];
      const referenced = await appendEntry(guarded.store, deliveryId, "evidence.reference.recorded", {
        recordId: record === undefined ? sha256Hex("") : record.recordId,
        manifestDigest: submission.manifestDigest,
      });
      if (!referenced.ok) return referenced;

      await writeOwned(path.join(await deliveryDir(deliveryId), "outcome.json"), `${JSON.stringify(outcome)}\n`);

      // WHICH OBLIGATIONS ACTUALLY COMPLETED. The finish line binds them, so
      // they are retained here rather than re-derived later from a policy that
      // only says which obligations were ACTIVATED. The facade completes
      // `outcome.verification` itself — criterion mapping plus the
      // positive-criterion rule above — and the admission gate completes the
      // rest. Only a BLOCKED resolution completed nothing: `not_applicable` is
      // the ordinary answer for an obligation this candidate never activated,
      // and treating it as incomplete would deadlock the finish line on work
      // nothing was ever supposed to run.
      const completedObligations = [
        ...new Set([
          "outcome.verification",
          ...(admission.decision?.resolutions ?? [])
            .filter((resolution) => resolution.kind !== "blocked")
            .map((resolution) => resolution.obligationId),
        ]),
      ].sort();
      await writeOwned(
        path.join(await deliveryDir(deliveryId), "admission.json"),
        `${JSON.stringify({ completedObligations })}\n`,
      );

      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "admitting", to: "recording" });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "recording" };
    },

    async prepareTrackedRecord({ deliveryId, env, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["recording"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const rootDir = workspace.worktreeDir;
      const capture = await captureFor(rootDir, config, candidateRunner, storageGitRunner);
      if (!capture.ok) return capture.failure;

      const admission = await runAdmission(
        { rootDir, config, context: classifyExecutionContext({ config, env, stdinIsTTY: false, stdoutIsTTY: false }) },
        {
          captureCandidate: capture.captureCandidate,
          projectActivation: (candidate: CapturedCandidate) => evaluateCandidateActivation({ rootDir, candidate, config, run: candidateRunner }),
          storageNamespace: config.storageNamespace,
          runGit: storageGitRunner,
        },
      );
      if (!admission.admitted || admission.decision === undefined) {
        return refuseWith(admission.blockers);
      }
      const evidenceRecords = [];
      for (const obligation of config.obligations) {
        const discovery = await discoverRecords(rootDir, {
          gateId: config.gateId,
          obligationId: obligation.id,
          storageNamespace: config.storageNamespace,
          runGit: storageGitRunner,
        });
        evidenceRecords.push(...discovery.records);
      }
      const context = await capturePortableEvidenceContext(config, repositoryEvidenceReader(rootDir, createArtifactsPort()), await computePreparationFingerprint(rootDir, config), admission.decision.candidate.deliverable.digest);
      const built = buildDeliveryRecord({ config, decision: admission.decision, evidenceRecords, context });
      if (!built.ok) return refuseWith(built.blockers);
      const relativePath = deliveryRecordPathFor(config, admission.decision.candidate.deliverable.digest);
      await mkdir(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
      await writeFile(path.join(rootDir, relativePath), deliveryRecordBytes(built.record), "utf8");
      return { ok: true, relativePath };
    },

    async confirmTrackedRecord({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["recording"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const rootDir = workspace.worktreeDir;

      const porcelain = await git(rootDir, "status", "--porcelain");
      if (porcelain.code !== 0 || porcelain.out !== "") {
        return refuse("record_uncommitted", "The tracked record is not checkpoint-committed.", "Commit the record through the host's native git tooling.");
      }
      const capture = await captureFor(rootDir, config, candidateRunner, storageGitRunner);
      if (!capture.ok) return capture.failure;
      const captured = capture.candidate;

      /**
       * The return-to-validation leg. The recording commit already moved the
       * tree, so the candidate is RECAPTURED before the transition — exactly
       * as the success leg does. Without that, the fresh aligned review the
       * frozen matrix demands would bind to a candidate the worktree no
       * longer has, and admission could never accept it again.
       */
      const returnToValidation = async (code: string, summary: string): Promise<{ ok: true } | FacadeFailure> => {
        const recordedBlocker = await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
          code,
          summary: summary.slice(0, 1900),
        });
        if (!recordedBlocker.ok) return recordedBlocker;
        const movedTree = (await git(rootDir, "rev-parse", "HEAD^{tree}")).out;
        const movedBranch = (await git(rootDir, "rev-parse", `refs/heads/${workspace.branchRef}`)).out;
        const recaptured = await appendEntry(guarded.store, deliveryId, "candidate.recaptured", {
          treeSha: movedTree,
          branchRefValue: movedBranch,
        });
        if (!recaptured.ok) return recaptured;
        return appendEntry(guarded.store, deliveryId, "transition.committed", { from: "recording", to: "validating" });
      };

      // The delivery-owned path sets, first: a committed projection or
      // discovery-configuration path is a protected-authority-path violation
      // no record can excuse, and it is caught here as well as by the
      // external verifier below — two independent statements of one rule,
      // sharing one closed constant so they cannot drift.
      // `-z` and NUL separation, never newline splitting: without it git
      // quotes a path containing a newline, and the quoted form no longer
      // starts with the delivery-owned segment it is inside.
      const candidateTreePaths = (await candidateTreeEntries(rootDir)) ?? [];
      const owned = candidateTreePaths.filter(isDeliveryOwnedTreeEntry).map((entry) => entry.path);
      if (owned.length > 0) {
        const returned = await returnToValidation(
          "record.protected-authority-path",
          `the candidate tree carries delivery-owned paths: ${owned.join(", ")}`,
        );
        if (!returned.ok) return returned;
        return refuse(
          "record_protected_authority_path",
          `The candidate tree carries delivery-owned paths (${owned.join(", ")}); the delivery returns to validation.`,
          "Remove the projection or discovery-configuration path from the candidate tree; delivery-owned paths are never committed.",
        );
      }

      // BOTH-NEUTRAL VERIFICATION, before anything reads the record. The
      // recording commit may stage only policy-declared review-neutral AND
      // record-neutral artifacts; any other byte is a candidate change, and a
      // candidate change after the final aligned review returns the delivery
      // to validation rather than being recorded over.
      const admitted = currentCandidateOf(guarded.views);
      const recordTree = (await git(rootDir, "rev-parse", "HEAD^{tree}")).out;
      if (admitted !== undefined && admitted.treeSha !== recordTree) {
        const changed = await git(rootDir, "diff", "--name-only", "-z", admitted.treeSha, recordTree);
        const nonNeutral = changed.out
          .split("\u0000")
          .filter((entry) => entry.length > 0)
          .filter((repoPath) => !(isReviewNeutralPath(config, repoPath) && isRecordNeutralPath(config, repoPath)));
        if (nonNeutral.length > 0) {
          // The frozen matrix has a direct edge for exactly this: any
          // non-neutral byte or identity change returns to validation, and
          // from there to a fresh aligned final review.
          const returned = await returnToValidation(
            "record.non-neutral-change",
            `the recording commit changed non-neutral paths: ${nonNeutral.join(", ")}`,
          );
          if (!returned.ok) return returned;
          return refuse(
            "record_non_neutral",
            `The recording commit changed non-neutral paths (${nonNeutral.join(", ")}); the delivery returns to validation and a fresh final review.`,
            "Stage only review-neutral and record-neutral artifacts in the recording commit.",
          );
        }
      }

      const relativePath = deliveryRecordPathFor(config, captured.deliverable.digest);
      let recordText: string;
      try {
        recordText = await readFile(path.join(rootDir, relativePath), "utf8");
      } catch {
        return refuse("record_missing", `No tracked record at ${relativePath}.`, "Prepare and commit the tracked record first.");
      }
      const parsed = parseDeliveryRecord(recordText);
      if (!parsed.ok) return refuseWith(parsed.blockers);

      // The compiled external verifier's pure core — the same check the
      // repository's pull-request Action runs — over the committed tree's own
      // paths, so a candidate carrying a projection or discovery-configuration
      // path is rejected on the tree's evidence alone.
      const check = verifyDeliveryRecord(
        config,
        parsed.record,
        { deliverableDigest: captured.deliverable.digest, identityToken: captured.deliverable.identity },
        { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
        { candidateTreePaths, ...await capturePortableVerificationInputs(rootDir, config, captured, parsed.record, candidateRunner),
          executionContext: { kind: "agent", signal: "managed-delivery" } },
      );
      if (!check.ok) return refuseWith(check.blockers);

      const treeSha = (await git(rootDir, "rev-parse", "HEAD^{tree}")).out;
      const branchRefValue = (await git(rootDir, "rev-parse", `refs/heads/${workspace.branchRef}`)).out;
      const recaptured = await appendEntry(guarded.store, deliveryId, "candidate.recaptured", { treeSha, branchRefValue });
      if (!recaptured.ok) return recaptured;
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", {
        from: "recording",
        to: "ready",
        trackedRecord: { path: relativePath, sha256: sha256Hex(recordText) },
      });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "ready" };
    },

    async completeFinishLine({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["ready"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const dir = await deliveryDir(deliveryId);
      const outcome = await readJson<OutcomeVerification>(path.join(dir, "outcome.json"));
      if (outcome === undefined) {
        return refuse("outcome_missing", "No outcome verification is on file for this delivery.", "Admit the delivery first.");
      }
      const completed = await readJson<{ completedObligations: readonly string[] }>(path.join(dir, "admission.json"));
      if (completed === undefined || !Array.isArray(completed.completedObligations)) {
        return refuse("admission_missing", "No readable admission result is on file for this delivery.", "Admit the delivery first.");
      }

      // The tracked record's digest, as journaled on the `recording` edge, and
      // the candidate recaptured there.
      const recordingTransition = [...guarded.views]
        .reverse()
        .find((view) => view.kind === "transition.committed" && view.payload["trackedRecord"] !== undefined);
      const trackedRecord = recordingTransition?.payload["trackedRecord"] as { path: string; sha256: string } | undefined;
      const recordedCandidate = currentCandidateOf(guarded.views);
      if (trackedRecord === undefined || recordedCandidate === undefined) {
        return refuse("record_missing", "No tracked-record transition is journaled for this delivery.", "Record the delivery first.");
      }

      // TERMINAL SUCCESS IS A RECHECK SITE. The candidate and its base are
      // re-observed here, and the external verifier — the same pure core the
      // repository's pull-request Action runs — is re-run over the committed
      // record, so hosted and local merge-ready evidence are both current.
      const rootDir = workspace.worktreeDir;
      const capture = await captureFor(rootDir, config, candidateRunner, storageGitRunner);
      if (!capture.ok) return capture.failure;
      const captured = capture.candidate;

      // The record is read BEFORE the decision: it carries the base coordinates
      // it was written against, observed through the same capture path as the
      // base observed now, so the two are comparable values rather than two
      // refs resolved by different rules at different moments.
      //
      // The record path is keyed on the CURRENT deliverable digest, so a moved
      // candidate has no record at it. That is not reported as a missing
      // record: the verifier is simply unavailable, which blocks on its own,
      // and the decision below names the movement that actually happened. With
      // no record there is no recorded base to compare, so the observed one
      // stands in — it can never turn the blocked decision into a pass.
      let externalVerification: ExternalVerification = "unavailable";
      let recordedBaseTipSha = captured.base.tipSha;
      const relativePath = deliveryRecordPathFor(config, captured.deliverable.digest);
      let recordText: string | undefined;
      try {
        recordText = await readFile(path.join(rootDir, relativePath), "utf8");
      } catch {
        recordText = undefined;
      }
      if (recordText !== undefined) {
        // A record the verifier cannot read is a finding, never a skip.
        const parsed = parseDeliveryRecord(recordText);
        if (!parsed.ok) return refuseWith(parsed.blockers);
        recordedBaseTipSha = parsed.record.candidateBinding.baseTipSha;
        const candidateTreePaths = await candidateTreeEntries(rootDir);
        if (candidateTreePaths !== undefined) {
          // The verifier's protected-authority-path rule does not run over a
          // tree it could not list, and half a verification is not a pass — so
          // a failed listing leaves the verification unavailable.
          const check = verifyDeliveryRecord(
            config,
            parsed.record,
            { deliverableDigest: captured.deliverable.digest, identityToken: captured.deliverable.identity },
            { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
            { candidateTreePaths, ...await capturePortableVerificationInputs(rootDir, config, captured, parsed.record, candidateRunner),
          executionContext: { kind: "agent", signal: "managed-delivery" } },
          );
          externalVerification = check.ok ? "passed" : "failed";
        }
      }

      // The declared product-trust level, read verbatim from the pinned
      // generation's own manifest — never from anything the candidate carries.
      const generation = await loadPinnedGeneration({
        installationPath: input.installation.installationPath,
        generationDigest: guarded.meta.generationDigest,
      });
      const declaredProductTrustLabel = generation.ok
        ? String((generation.manifest["pin"] as Record<string, unknown> | undefined)?.["productTrustLabel"] ?? "")
        : "";

      const decision = decideFinishLine({
        deliveryId,
        contract: guarded.meta.contract,
        policy: guarded.meta.policy,
        outcome,
        record: { treeSha: recordedCandidate.treeSha, baseTipSha: recordedBaseTipSha, digest: trackedRecord.sha256 },
        observed: { treeSha: captured.treeSha, baseTipSha: captured.base.tipSha },
        admission: { admitted: true, completedObligations: completed.completedObligations },
        externalVerification,
        declaredProductTrustLabel,
      });
      if (decision.kind !== "completed") {
        // Merge-ready never falls through to an action here: an authorized
        // merge or deploy is the external-actions unit's, and this slice
        // invokes none, so anything but terminal success is a refusal.
        const detail =
          decision.kind === "blocked"
            ? decision.refusals.map((refusal) => refusal.message).join("; ")
            : `the contract requests a ${guarded.meta.contract.requestedFinishLine} finish line, whose ${decision.action} action no bound adapter can invoke`;
        return refuse(
          "finish_line_refused",
          `The merge-ready finish line was refused: ${detail}`.slice(0, 1900),
          "Resolve every criterion and obligation on the recorded candidate, then complete the finish line.",
        );
      }
      const recorded = await appendEntry(guarded.store, deliveryId, "finish.line.recorded", { result: decision.result });
      if (!recorded.ok) return recorded;
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "ready", to: "completed" });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "completed", resultDigest: digestCanonical(decision.result) };
    },

    async sessionEnded({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const appended = await appendEntry(guarded.store, deliveryId, "activity.observed", {
        activity: "paused",
        fence: guarded.lastFence,
      });
      if (!appended.ok) return appended;
      return { ok: true };
    },

    async recordTerminationProvenance({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;

      // The GRADE, read from the pinned generation's capability record — not
      // from this call, and not from anything a session can write.
      const descendantTeardown = await gradedDescendantTeardown({
        generationRoot: guarded.generationRoot,
        hostId: hostBinding.hostId,
        hostVersion: input.hostVersion,
      });
      const resumeEligibility = gradeResumeEligibility({ descendantTeardown });

      // One provenance record per invocation. A lifecycle integration that
      // retries, or a late callback arriving after a takeover was presented,
      // must not append again: the append advances the expected journal
      // revision, which would void a pending takeover authorization.
      const existing = lastOf(guarded.views, "termination.provenance.recorded");
      if (existing !== undefined && existing.payload["fence"] === guarded.lastFence) {
        // The DERIVED grade is returned, never the stored payload: this
        // operation reports what the graded record currently says, and reading
        // back a journal value would let a forged entry speak in its voice.
        return { ok: true, descendantTeardown, resumeEligibility };
      }

      // One trusted lifecycle event, two distinct facts. Activity becomes an
      // honest `paused`; the provenance record is the durable fact about the
      // ended invocation and is NOT an activity marker.
      const paused = await appendEntry(guarded.store, deliveryId, "activity.observed", {
        activity: "paused",
        fence: guarded.lastFence,
      });
      if (!paused.ok) return paused;
      const appended = await appendEntry(guarded.store, deliveryId, "termination.provenance.recorded", {
        fence: guarded.lastFence,
        hostVersion: input.hostVersion,
        // The host this delivery was actually bound to, read from the same
        // binding the grade above was looked up under, so the record says
        // whose teardown this verdict is about.
        hostId: hostBinding.hostId,
        provenance: "graceful",
        descendantTeardown,
        resumeEligibility,
      });
      if (!appended.ok) return appended;
      return { ok: true, descendantTeardown, resumeEligibility };
    },

    async recordProjectionConsumption({ deliveryId, category }) {
      // The canonical recheck first: an entry must never be written about a
      // delivery whose trust, installation, or projection binding no longer
      // holds. `verifyWorkspace` re-verifies the projection here for the same
      // reason every other workspace operation does.
      //
      // This operation deliberately does NOT bind the invocation fence. It
      // writes no delivery-journal entry, and the facade's own surface
      // invariant refuses a fence on an operation with nothing the fence could
      // be checked against. The protection a fence would add is already
      // structural: the consumption observation the writer requires is
      // fence-scoped and written only by the model-external interceptor of the
      // live session, and the fence it is looked up under is the binding's own
      // workspace record — so a superseded caller reaches no observation of
      // its own and can affirm nothing.
      const guarded = await guard(deliveryId, { verifyWorkspace: true });
      if (!("store" in guarded)) return guarded;
      if (guarded.workspace === undefined) {
        return refuse(
          "workspace_unbound",
          "No workspace is bound.",
          "Bind the host-supplied worktree first; a consumption record describes a materialized projection.",
        );
      }
      const emitted = await emitProjectionConsumptionRecord({
        // Neither target nor repository identity is caller-selectable. Both
        // are derived from the protected facade context after the canonical
        // delivery recheck, so a delivery cannot redirect its evidence into a
        // different adopter's comparison authority.
        gateRecordPath: path.join(input.repoDir, SHADOW_MILESTONE_GATE_RECORD_PATH),
        repositoryRoot: input.repoDir,
        expectedRepositoryId: guarded.meta.contract.repository.repositoryId,
        worktreeDir: guarded.workspace.worktreeDir,
        bindingDir: path.join(await deliveryDir(deliveryId), "binding"),
        // The run the record binds is the BINDING's, read from the workspace
        // record — the caller's fence has already been checked against the
        // journal, and this is the value the binding itself materialized under.
        deliveryId,
        fence: guarded.workspace.fence,
        category,
      });
      if (!emitted.ok) {
        const crossRepository = emitted.blockers.some(
          (blocker) => blocker.code === "gate_record_repository_mismatch",
        );
        return refuse(
          crossRepository
            ? "consumption_record_cross_repository_refused"
            : "consumption_record_write_failed",
          `Recording the projection-consumption entry failed: ${emitted.blockers.map((blocker) => blocker.message).join("; ")}`,
          crossRepository
            ? "Restore the canonical gate record's repositoryId to the accepted delivery repository; cross-repository targets are refused."
            : "Restore the consuming repository's canonical milestone gate-record artifact.",
        );
      }
      return emitted.emitted
        ? { ok: true, emitted: true, projectionDigest: emitted.record.projectionDigest }
        : { ok: true, emitted: false, reason: emitted.reason };
    },

    async tearDownWorkspaceProjection({ deliveryId }) {
      // Teardown destroys the binding's own receipts, so it runs through the
      // canonical recheck like every other workspace operation, so a delivery
      // whose trust or installation binding no longer holds cannot have its
      // binding receipts removed by a passing caller — and a delivery with a
      // takeover pending refuses outright. That workspace is quarantined
      // precisely because it is not trusted, and teardown would delete the
      // projection receipt that shows tampering while leaving the prior
      // invocation's state file behind.
      const guarded = await guard(deliveryId);
      if (!("store" in guarded)) return guarded;
      const dir = await deliveryDir(deliveryId);
      const workspace = await readJson<WorkspaceMeta>(path.join(dir, "workspace.json"));
      if (workspace === undefined) {
        return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      }
      const torn = await tearDownProjection({
        worktreeDir: workspace.worktreeDir,
        bindingDir: path.join(dir, "binding"),
        settingsPath: workspace.settingsPath,
        exec,
      });
      if (!torn.ok) {
        return refuse(
          "projection_teardown_failed",
          `Tearing the projection down failed: ${torn.blockers.map((blocker) => blocker.message).join("; ")}`,
          "Remove the projection subtree and the worktree-scoped exclusion before removing the worktree.",
        );
      }
      return { ok: true };
    },

    async recordApprovalRequest({ deliveryId, requestKind, criterionId, actorId, reason, fence }) {
      const guarded = await guard(deliveryId, {
        requireState: ["reviewing", "remediating", "admitting"],
        verifyWorkspace: true,
        invokingFence: fence,
        fenceRequired: true,
      });
      if (!("store" in guarded)) return guarded;
      const appended = await appendEntry(guarded.store, deliveryId, "approval.request.recorded", {
        requestKind,
        criterionId,
        actorId,
        reason,
      });
      if (!appended.ok) return appended;
      // The proposal and its pending marker are journaled; the delivery
      // remains in its current state. Consumption belongs to the
      // sensitive-approval lane, whose journal kind stays reserved here.
      return { ok: true, state: guarded.state };
    },

    async consumeWaiver({ deliveryId, approverId, outcomeChanging, fence, now, assertionSource }) {
      const guarded = await guard(deliveryId, {
        requireState: ["reviewing", "remediating", "admitting"],
        verifyWorkspace: true,
        invokingFence: fence,
        fenceRequired: true,
      });
      if (!("store" in guarded)) return guarded;
      const current = currentCandidateOf(guarded.views);
      if (current === undefined) return refuse("no_candidate", "No candidate is checkpointed.", "Checkpoint a candidate first.");

      // An outcome amendment forces full re-evaluation, and the only edges
      // that reach re-evaluation leave `reviewing` and `remediating`. At
      // `admitting` there is no review left to re-open, so the amendment is
      // refused rather than pretended.
      if (outcomeChanging && guarded.state === "admitting") {
        return refuse(
          "amendment_after_review",
          "An outcome amendment forces full re-evaluation; at admission there is no review left to re-open.",
          "Return the delivery to review, then confirm the amendment there.",
        );
      }

      const trust = await readTrust();
      if (trust === undefined) {
        return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
      }
      const binding = await registrationBinding({
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
      });
      if (!binding.ok) {
        return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
      }
      const providerConfig = await loadAssertionProviderConfig(input.installation.installationPath);
      if (!providerConfig.ok) {
        return refuse(
          "assertion_source_unavailable",
          "The assertion provider configuration is absent or corrupt; sensitive operations fail closed.",
          "An operator-performed installer repair re-establishes the assertion source.",
        );
      }
      const source = assertionSource ?? assertionSourceForKind(providerConfig.config.sourceKind);
      const availability = await source.probe();
      if (!availability.available) {
        return refuse(
          "assertion_source_unavailable",
          `The configured assertion source is unavailable: ${availability.detail}`,
          "An operator-performed installer repair re-establishes the assertion source.",
        );
      }

      const ledger = waiverLedgerOf(guarded.views);
      const pendingProposal = ledger.pending[0];
      const action = outcomeChanging ? "confirm-outcome-amendment" : "waive-criterion";
      const evaluation = await source.evaluate({
        action,
        disclosure:
          `Approve ${action} of criterion ${pendingProposal?.criterionId ?? "(none proposed)"} on delivery ${deliveryId}, ` +
          `candidate ${current.treeSha}, as ${approverId}`,
      });
      if (!evaluation.ok) {
        return refuse("assertion_refused", `The interactive evaluation was not granted: ${evaluation.reason}`, "The approver declined; the proposal stays pending.");
      }

      const assertion: Record<string, unknown> = {
        spec: SENSITIVE_APPROVAL_ASSERTION_SPEC,
        assertionClass: "delivery-bound",
        origin: `${WAIVER_APPROVAL_ORIGIN_PREFIX}${approverId}`,
        action,
        expiry: evaluation.expiry,
        nonce: evaluation.nonce,
        assertionSource: evaluation.sourceKind,
        productTrustRevocationEpoch: trust.revocationEpoch,
        repositoryAuthorityRevocationEpoch: guarded.meta.policy.repositoryAuthorityRevocationEpoch,
        deliveryId,
        candidateTreeSha: current.treeSha,
        policyDigest: guarded.meta.policy.policyDigest,
        invocationFence: guarded.lastFence,
        targetInstallationId: "absent-by-state",
        targetGenerationDigest: "absent-by-state",
        targetHighWaterMark: "absent-by-state",
        expectedJournalRevision: "absent-by-state",
      };

      const verdict = evaluateWaiverConsumption(assertion, {
        deliveryId,
        deliveryState: guarded.state,
        candidateTreeSha: current.treeSha,
        policyDigest: guarded.meta.policy.policyDigest,
        productTrustRevocationEpoch: trust.revocationEpoch,
        repositoryAuthorityRevocationEpoch: guarded.meta.policy.repositoryAuthorityRevocationEpoch,
        invocationFence: guarded.lastFence,
        proposal: pendingProposal,
        contractCriterionIds: guarded.meta.contract.acceptanceCriteria.map((criterion) => criterion.criterionId),
        outcomeAuthorities: policyBinding.outcomeAuthorities,
        currentProfile: binding.activeCompositionProfile,
        consumedNonces: consumedAssertionNoncesOf(guarded.views),
        now,
      });
      if (!verdict.ok) {
        // A proposal that went stale against a later candidate is retired
        // durably, so the pending marker cannot be carried forward silently.
        if (verdict.blockers.some((blocker) => blocker.code === "waiver_proposal_stale")) {
          await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
            code: "approval.proposal-voided",
            summary: `the candidate changed since criterion ${String(pendingProposal?.criterionId)} was proposed; the stale proposal is void`.slice(0, 1900),
          });
        }
        return refuseWith(
          verdict.blockers.map((blocker) =>
            createBlocker({
              code: blocker.code,
              source: SOURCE,
              summary: blocker.message,
              remediations: [
                {
                  id: `${blocker.code.replaceAll("_", "-")}-remediation`,
                  kind: "manual_action",
                  summary: "A waiver is valid only as a consumed sensitive approval bound to the current candidate; the proposal stays unapproved.",
                },
              ],
            }),
          ),
        );
      }

      const consumed = await appendEntry(guarded.store, deliveryId, "approval.assertion.consumed", {
        assertion,
        newRegisteringInstallationId: "absent-by-state",
      });
      if (!consumed.ok) return consumed;

      if (!verdict.outcomeChanging) {
        return { ok: true, criterionId: verdict.criterionId, outcomeChanging: false, contractId: guarded.meta.contract.contractId, state: guarded.state };
      }

      // A confirmed amendment creates a NEW contract identity, and the
      // delivery re-evaluates against it from the earliest state the frozen
      // matrix can reach.
      const previousContractId = guarded.meta.contract.contractId;
      // The new identity is derived from the consumed approval, so it is
      // reproducible from the journal and unique per amendment.
      const amendedContract: AcceptedContract = {
        ...guarded.meta.contract,
        contractId: `${previousContractId}.amended-${sha256Hex(evaluation.nonce).slice(0, 12)}`,
      };
      const amended = await appendEntry(guarded.store, deliveryId, "contract.amended", {
        previousContractId,
        contractId: amendedContract.contractId,
        contractDigest: digestCanonical(amendedContract),
        criterionId: verdict.criterionId,
        assertionNonce: evaluation.nonce,
      });
      if (!amended.ok) return amended;
      await writeOwned(
        path.join(await deliveryDir(deliveryId), "delivery.json"),
        `${JSON.stringify({ ...guarded.meta, contract: amendedContract } satisfies DeliveryMeta)}\n`,
      );
      const to: DeliveryState = guarded.state === "reviewing" ? "remediating" : "validating";
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: guarded.state, to });
      if (!transitioned.ok) return transitioned;
      return { ok: true, criterionId: verdict.criterionId, outcomeChanging: true, contractId: amendedContract.contractId, state: to };
    },

    async blockerInventory({ deliveryId }) {
      const guarded = await guard(deliveryId, { allowPendingTakeover: true });
      if (!("store" in guarded)) return guarded;
      return { ok: true, entries: composeBlockerInventory(guarded.views) };
    },

    async requestCancellation({ deliveryId }) {
      const guarded = await guard(deliveryId, { allowPendingTakeover: true });
      if (!("store" in guarded)) return guarded;
      if (guarded.state === "cancellation_requested") {
        return refuse(
          "cancellation_already_requested",
          "Cancellation is already requested; finalize it through quarantine or trusted termination.",
          "Call finalizeCancellation once the prior workspace is quarantined.",
        );
      }
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", {
        from: guarded.state,
        to: "cancellation_requested",
      });
      if (!transitioned.ok) return transitioned;

      // Fence revocation, immediately: the model-external interceptor is
      // deny-until-attested, so voiding the attestation in the binding state
      // re-denies every subsequent tool invocation — including a late
      // subagent's — without any callback plumbing. Native host cancellation
      // is then requested through the host's own primitive where one is
      // qualified; on this fixture host the revocation IS the request
      // (fence-revocation-only), and no claim of termination is made.
      const cancelBindingDir = path.join(await deliveryDir(deliveryId), "binding");
      await voidSupersededBindingStates(cancelBindingDir, Number.POSITIVE_INFINITY);
      if (guarded.lastFence > 0) {
        await appendEntry(guarded.store, deliveryId, "activity.observed", {
          activity: "cancellation_pending",
          fence: guarded.lastFence,
        });
      }
      return { ok: true, state: "cancellation_requested" };
    },

    async finalizeCancellation({ deliveryId }) {
      const guarded = await guard(deliveryId, { allowPendingTakeover: true });
      if (!("store" in guarded)) return guarded;
      if (guarded.state !== "cancellation_requested") {
        return refuse(
          "cancellation_not_requested",
          `finalizeCancellation completes a requested cancellation; the delivery is in ${guarded.state}.`,
          "Request cancellation first.",
        );
      }
      // Terminal cancellation through PERMANENT QUARANTINE of the prior
      // workspace and preservation of the last trusted candidate. Trusted
      // termination provenance is the other path, and its journal kind stays
      // reserved until the qualified host integration defines it — so this
      // record never claims that the prior task or its descendants stopped.
      const boundWorkspace = lastOf(guarded.views, "workspace.bound");
      const disposed = await appendEntry(guarded.store, deliveryId, "workspace.disposition.recorded", {
        workspaceId: (boundWorkspace?.payload["workspaceId"] as string | undefined) ?? "ws-unbound",
        disposition: "quarantined",
      });
      if (!disposed.ok) return disposed;
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", {
        from: "cancellation_requested",
        to: "cancelled",
      });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "cancelled" };
    },

    async exportDelivery({ deliveryId }) {
      const context = await retentionContext();
      if (!("namespaceDir" in context)) return context;
      const binding = await verifyDeliveryBinding(deliveryId);
      if (!binding.ok) return binding;
      const outcome = await runDeliveryExport(context, deliveryId);
      if (!outcome.ok) return refuse(outcome.code, outcome.summary, outcome.remediation);
      return { ok: true, exportPath: outcome.exportPath, artifactDigest: outcome.artifactDigest };
    },

    async deleteDelivery({ deliveryId }) {
      const context = await retentionContext();
      if (!("namespaceDir" in context)) return context;
      const binding = await verifyDeliveryBinding(deliveryId);
      if (!binding.ok) return binding;
      const outcome = await runDeliveryDeletion(context, deliveryId);
      if (!outcome.ok) return refuse(outcome.code, outcome.summary, outcome.remediation);
      return { ok: true, preservedAuditRecords: outcome.preservedAuditRecords };
    },

    async presentTakeover({ deliveryId, expiry }) {
      const guarded = await guard(deliveryId);
      if (!("store" in guarded)) return guarded;
      const trust = await readTrust();
      if (trust === undefined) {
        return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
      }
      const current = currentCandidateOf(guarded.views);
      const bound = lastOf(guarded.views, "workspace.bound");
      const targetBaseCommit =
        current !== undefined ? current.branchRefValue : (bound?.payload["baseTipSha"] as string | undefined);
      if (targetBaseCommit === undefined) {
        return refuse("no_trusted_commit", "No trusted commit exists to reconstruct from.", "Bind a workspace first.");
      }
      const nonce = `nonce-${hex(8)}`;
      // Branch names are repository-global; the delivery identity keeps two
      // deliveries' takeover branches from colliding in one repository.
      const takeoverBranchRef = `takeover-${deliveryId}-${guarded.lastFence + 1}`;
      // A pre-existing branch of that name is a collision: a takeover
      // reconstructs onto a DISTINCT branch and never adopts an existing ref,
      // however plausible its tip. Checkpointed and failed closed.
      const collision = await git(input.repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${takeoverBranchRef}`);
      if (collision.code === 0) {
        await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
          code: "workspace.branch-collision",
          summary: `branch ${takeoverBranchRef} already exists; a takeover reconstructs onto a fresh branch and never adopts an existing ref`,
        });
        return refuse(
          "branch_collision",
          `The takeover branch ${takeoverBranchRef} already exists in this repository.`,
          "Remove or rename the colliding branch through the host's native git tooling, then present the takeover again.",
        );
      }
      const confirmation = {
        spec: "operator-confirmation/1",
        confirmationClass: "takeover-authorization",
        origin: "managed-delivery.facade",
        action: "authorize-takeover",
        expiry,
        nonce,
        productTrustRevocationEpoch: trust.revocationEpoch,
        repositoryAuthorityRevocationEpoch: guarded.meta.policy.repositoryAuthorityRevocationEpoch,
        intakeDraftId: "absent-by-state",
        deliveryId,
        normalizedContractDigest: "absent-by-state",
        supersededInvocationFence: guarded.lastFence,
        expectedJournalRevision: guarded.expectedRevision,
        targetBaseCommit,
        boundInvocationFence: "absent-by-state",
        boundCandidateTreeSha: "absent-by-state",
      };
      const rendered = await renderChallenge(nonce, confirmation, deliveryId, expiry);
      if (!rendered.ok) return rendered;
      await writeOwned(
        path.join(await deliveryDir(deliveryId), "takeover-pending.json"),
        `${JSON.stringify({ nonce, targetBaseCommit, takeoverBranchRef, supersededFence: guarded.lastFence })}\n`,
      );
      return {
        ok: true,
        nonce,
        channelPath: confirmationPath(nonce),
        supersededFence: guarded.lastFence,
        expectedJournalRevision: guarded.expectedRevision,
        targetBaseCommit,
        takeoverBranchRef,
      };
    },

    async confirmTakeover({ deliveryId, echo }) {
      const guarded = await guard(deliveryId);
      if (!("store" in guarded)) return guarded;
      const dir = await deliveryDir(deliveryId);
      const pending = await readJson<PendingTakeover & { nonce: string }>(path.join(dir, "takeover-pending.json"));
      if (pending === undefined) {
        return refuse("takeover_unknown", "No presented takeover authorization is pending.", "Present the takeover first.");
      }
      const consumed = await consumeChallenge(pending.nonce, echo);
      if (!("confirmation" in consumed)) return consumed;

      // Consumption rechecks through the canonical helper's takeover
      // substitution: the superseded fence, expected journal revision, and
      // target base commit are evaluated IN PLACE OF the current fence and
      // the prior worktree's projection and discovery-configuration digests,
      // while every unsubstituted frozen value is still evaluated. Any
      // mismatch rejects; observation-only appends never advanced the bound
      // revision, so they never void a pending authorization.
      const confirmation = consumed.confirmation;
      if (confirmation["deliveryId"] !== deliveryId) {
        return refuse(
          "takeover_stale",
          "The takeover authorization binds a different delivery; nothing was consumed into the journal.",
          "Present a fresh takeover against current durable state.",
        );
      }
      const boundWorkspace = lastOf(guarded.views, "workspace.bound");
      const currentTrusted = currentCandidateOf(guarded.views);
      const observedTarget =
        currentTrusted !== undefined
          ? currentTrusted.branchRefValue
          : ((boundWorkspace?.payload["baseTipSha"] as string | undefined) ?? "no-trusted-commit");
      const consumptionRecheck = evaluateCanonicalRecheck({
        consumption: {
          kind: "takeover",
          supersededFence: { kind: "compare", expected: Number(confirmation["supersededInvocationFence"]), observed: guarded.lastFence },
          expectedJournalRevision: { kind: "compare", expected: Number(confirmation["expectedJournalRevision"]), observed: guarded.expectedRevision },
          targetBaseCommit: { kind: "compare", expected: String(confirmation["targetBaseCommit"]), observed: observedTarget },
        },
        values: {
          ...guarded.recheckValues,
          "invocation-fence": "absent-by-state",
          "projection-digest": "absent-by-state",
          "discovery-configuration-digest": "absent-by-state",
        },
      });
      if (!consumptionRecheck.ok) {
        return refuse(
          "takeover_stale",
          `The takeover authorization no longer matches durable state (${consumptionRecheck.failures.map((failure) => failure.value).join(", ")}); nothing was consumed into the journal.`,
          "Present a fresh takeover against current durable state.",
        );
      }

      const recorded = await appendEntry(guarded.store, deliveryId, "operator.confirmation.recorded", { confirmation });
      if (!recorded.ok) return recorded;
      const bound = lastOf(guarded.views, "workspace.bound");
      const priorWorkspace = (bound?.payload["workspaceId"] as string | undefined) ?? "ws-unbound";
      await appendEntry(guarded.store, deliveryId, "workspace.disposition.recorded", {
        workspaceId: priorWorkspace,
        disposition: "quarantined",
      });
      await writeOwned(
        path.join(dir, "takeover.json"),
        `${JSON.stringify({
          targetBaseCommit: pending.targetBaseCommit,
          takeoverBranchRef: pending.takeoverBranchRef,
          supersededFence: pending.supersededFence,
        } satisfies PendingTakeover)}\n`,
      );
      await rm(path.join(dir, "takeover-pending.json"), { force: true });
      return { ok: true, targetBaseCommit: pending.targetBaseCommit, takeoverBranchRef: pending.takeoverBranchRef };
    },

    async explainBlocker({ deliveryId }) {
      const binding = await verifyDeliveryBinding(deliveryId);
      if (!binding.ok) return binding;
      const store = await journalStoreFor(deliveryId);
      const read = await store.read();
      if (!read.ok) return refuse("journal_unreadable", "The delivery journal is unreadable.", "Inspect the durable journal file.");
      const blocker = lastOf(viewsOf(read.entries), "blocker.recorded");
      if (blocker === undefined) return { ok: true, blocker: undefined };
      const code = blocker.payload["code"] as string;
      const remediation = code.startsWith("trust.")
        ? "Restore local product trust through the operator maintenance lane, then resume."
        : code.startsWith("projection.")
          ? "Quarantine the workspace and resume through an authorized takeover into a fresh worktree."
          : code.startsWith("outcome.")
            ? "Satisfy the named acceptance criterion on the exact candidate, then re-validate."
            : code.startsWith("review.")
              ? "Complete both mandatory review lenses on the exact candidate, then re-admit."
              : "Read the summary; the journal carries the full typed record.";
      return { ok: true, blocker: { code, summary: blocker.payload["summary"] as string, remediation } };
    },

    async updateComposition(maintenance) {
      const outcome = await updateComposition({
        ...maintenance,
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
      });
      if (!outcome.ok) return substrateRefusal(outcome.blockers);
      return {
        ok: true,
        generationDigest: outcome.generationDigest,
        priorGenerationDigest: outcome.priorGenerationDigest,
        noOp: outcome.noOp,
      };
    },

    async rollbackComposition(maintenance) {
      const outcome = await rollbackComposition({
        ...maintenance,
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
      });
      if (!outcome.ok) return substrateRefusal(outcome.blockers);
      return { ok: true, generationDigest: outcome.generationDigest };
    },

    async maintainTrustState(maintenance) {
      const outcome = await maintainTrustState({
        ...maintenance,
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
      } as MaintainTrustStateInput);
      if (!outcome.ok) return substrateRefusal(outcome.blockers);
      return { ok: true, state: outcome.state };
    },

    async recoverSecurityBlocked({ deliveryId, targetGenerationDigest, assertionSource, now }) {
      const dir = await deliveryDir(deliveryId);
      const meta = await readJson<DeliveryMeta>(path.join(dir, "delivery.json"));
      if (meta === undefined) {
        return refuse("unknown_delivery", `No registered delivery ${deliveryId}.`, "Register a delivery through the contract handoff first.");
      }
      const store = await journalStoreFor(deliveryId);
      const reduced = await store.state();
      const read = await store.read();
      if (!reduced.ok || !read.ok) {
        return refuse("journal_rejected", "The durable journal does not reduce.", "Inspect the durable journal file.");
      }
      if (meta.policyBindingDigest !== policyBindingDigest || reduced.state.policyBindingDigest !== policyBindingDigest) {
        return refuse(
          "policy_binding_mismatch",
          "The current compiled adopter policy binding does not match this delivery's recorded binding.",
          "Use the exact binding captured at registration; drift requires a new owner-approved delivery.",
        );
      }
      if (reduced.state.state !== "security_blocked") {
        return refuse(
          "wrong_state",
          `Leaving security_blocked is a maintenance-lane operation; the delivery is in ${reduced.state.state}.`,
          "Read `status` for the next valid checkpoint.",
        );
      }
      const views = viewsOf(read.entries);
      const recorded = recordedBindingOf(views);
      const recordedPin = reduced.state.generationDigest;
      if (recorded === undefined || recordedPin === undefined) {
        return refuse("unregistered", "The delivery has no recorded registration binding or generation pin.", "Register the delivery first.");
      }
      const binding = await registrationBinding({
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
      });
      if (!binding.ok) {
        return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
      }
      const trust = await readTrust();
      if (trust === undefined) {
        return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
      }

      const target = targetGenerationDigest ?? recordedPin;
      const rebinding = binding.registeringInstallationId !== recorded.registeringInstallationId;
      const generationChange = target !== recordedPin;
      const mode = rebinding ? "rebinding-migration" : generationChange ? "generation-change-migration" : "re-preparation";

      if (mode === "re-preparation") {
        // Leaving security_blocked always requires CURRENT local trust
        // state: the recorded pin must be execution-eligible again (for
        // example after an explicit un-revocation).
        const load = await loadPinnedGeneration({
          installationPath: input.installation.installationPath,
          generationDigest: recordedPin,
        });
        if (!load.ok) {
          return refuse(
            "trust_ineligible",
            "The recorded generation pin is not execution-eligible under current local trust state.",
            "Restore trust through the operator maintenance lane, or migrate to an accepted generation.",
          );
        }
      } else {
        // The migration lane: one fresh interactive evaluation from the
        // installation's configured assertion source, consumed against the
        // exact bindings — and never a new invocation fence.
        const config = await loadAssertionProviderConfig(input.installation.installationPath);
        if (!config.ok) {
          return refuse(
            "assertion_source_unavailable",
            "The assertion provider configuration is absent or corrupt; sensitive operations fail closed.",
            "An operator-performed installer repair re-establishes the assertion source.",
          );
        }
        const source = assertionSource ?? assertionSourceForKind(config.config.sourceKind);
        const availability = await source.probe();
        if (!availability.available) {
          return refuse(
            "assertion_source_unavailable",
            `The configured assertion source is unavailable: ${availability.detail}`,
            "An operator-performed installer repair re-establishes the assertion source.",
          );
        }
        const evaluation = await source.evaluate({
          action: SECURITY_BLOCKED_MIGRATION_ACTION,
          disclosure: `Approve security-blocked migration of delivery ${deliveryId} at journal revision ${reduced.state.expectedRevision} to generation ${target} on installation ${binding.registeringInstallationId}`,
        });
        if (!evaluation.ok) {
          return refuse("assertion_refused", `The interactive evaluation was not granted: ${evaluation.reason}`, "The operator declined; the delivery remains security_blocked.");
        }
        const assertion: Record<string, unknown> = {
          spec: "sensitive-approval-assertion/1",
          assertionClass: "security-blocked-migration",
          origin: "managed-delivery.facade",
          action: SECURITY_BLOCKED_MIGRATION_ACTION,
          expiry: evaluation.expiry,
          nonce: evaluation.nonce,
          assertionSource: evaluation.sourceKind,
          productTrustRevocationEpoch: trust.revocationEpoch,
          repositoryAuthorityRevocationEpoch: "absent-by-state",
          deliveryId,
          candidateTreeSha: "absent-by-state",
          policyDigest: "absent-by-state",
          invocationFence: "absent-by-state",
          targetInstallationId: binding.registeringInstallationId,
          targetGenerationDigest: target,
          targetHighWaterMark: "absent-by-state",
          expectedJournalRevision: reduced.state.expectedRevision,
        };
        const consumption = evaluateMigrationConsumption(assertion, {
          deliveryId,
          expectedJournalRevision: reduced.state.expectedRevision,
          currentInstallationId: binding.registeringInstallationId,
          currentProfile: binding.activeCompositionProfile,
          recordedInstallationId: recorded.registeringInstallationId,
          recordedProfile: recorded.activeCompositionProfile,
          trustState: trust,
          consumedNonces: consumedAssertionNoncesOf(views),
          now,
        });
        if (!consumption.ok) {
          return refuseWith(
            consumption.blockers.map((blocker) =>
              createBlocker({
                code: blocker.code,
                source: SOURCE,
                summary: blocker.message,
                remediations: [
                  {
                    id: `${blocker.code.replaceAll("_", "-")}-remediation`,
                    kind: "manual_action",
                    summary: "The migration assertion rejects on any binding mismatch; the delivery remains security_blocked.",
                  },
                ],
              }),
            ),
          );
        }
        // The target must also be a retained, closure-verified root on this
        // installation.
        const load = await loadPinnedGeneration({
          installationPath: input.installation.installationPath,
          generationDigest: target,
        });
        if (!load.ok) {
          return refuse(
            "trust_ineligible",
            "The migration's target generation is not a retained, execution-eligible root on this installation.",
            "Install or update to the target generation first.",
          );
        }

        const consumed = await appendEntry(store, deliveryId, "approval.assertion.consumed", {
          assertion,
          newRegisteringInstallationId: rebinding ? binding.registeringInstallationId : "absent-by-state",
        });
        if (!consumed.ok) return consumed;
        if (target !== recordedPin) {
          const pinned = await appendEntry(store, deliveryId, "generation.pinned", {
            generationDigest: target,
            releaseId: PINNED_AGENT_SKILLS.releaseId,
            profile: binding.activeCompositionProfile,
          });
          if (!pinned.ok) return pinned;
        }
      }

      // Full re-preparation with invalidation of revoked-era candidate-bound
      // evidence: prior review attempts are quarantined out of the reduction
      // set (retained for audit under a dead name), and the workspace binding
      // is dropped so the delivery re-prepares from scratch.
      const attemptsDir = path.join(dir, "attempts");
      try {
        await readdir(attemptsDir);
        const { rename } = await import("node:fs/promises");
        await rename(attemptsDir, path.join(dir, `attempts-invalidated-r${reduced.state.expectedRevision}`));
      } catch {
        /* no attempts to invalidate */
      }
      await rm(path.join(dir, "workspace.json"), { force: true });
      await rm(path.join(dir, "takeover.json"), { force: true });

      const transitioned = await appendEntry(store, deliveryId, "transition.committed", {
        from: "security_blocked",
        to: "preparing",
      });
      if (!transitioned.ok) return transitioned;
      return { ok: true, mode, state: "preparing" };
    },
  };
}

// ── Small shared helpers ───────────────────────────────────────────────────

type CaptureOutcome =
  | { readonly ok: true; readonly candidate: CapturedCandidate; readonly captureCandidate: CaptureCandidate }
  | { readonly ok: false; readonly failure: FacadeFailure };

async function captureFor(
  rootDir: string,
  config: HarnessConfig,
  run: CandidateCommandRunner,
  runGit: (cwd: string, args: readonly string[]) => Promise<string>,
): Promise<CaptureOutcome> {
  const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace, runGit });
  const captureCandidate = createCandidateCapture({
    rootDir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
    run,
  });
  const capture = await captureCandidate();
  if (!capture.ok) {
    return { ok: false, failure: { ok: false, blockers: capture.blockers } };
  }
  return { ok: true, candidate: capture.candidate, captureCandidate };
}
