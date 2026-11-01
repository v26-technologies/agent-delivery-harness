/**
 * The harness configuration: one object, injected everywhere, validated once.
 *
 * Nothing in the kernel reaches for ambient policy. Every dimension a module
 * needs — which gate this is, which specs it accepts, which paths are narration,
 * which finding codes a human may waive — arrives as a parameter, and the
 * import-boundary sensor enforces that no kernel module imports a config module
 * by name. `defineHarnessConfig` is the one door into that object.
 *
 * WHY THE INVARIANTS LIVE HERE. A config is policy, and inconsistent policy is
 * not a runtime surprise to be discovered at the gate — it is a defect the
 * author should learn about while editing the file. So the rules that relate one
 * member to another (a waiver flag that contradicts the resolution kinds it
 * governs, a delivery-record path the identity rules would exclude from one set
 * but not the other, a finding code no obligation classifies) are checked at
 * load time, all of them, and reported together. Reporting the first failure
 * only would turn one editing session into five.
 *
 * WHY THE CODE UNIVERSE IS INJECTED. The partition invariant needs to know every
 * finding code an obligation can emit. That universe is the structural registry
 * from the blocker contract plus the finding codes the config's own providers
 * declare — both available here. It is deliberately *not* obtained by importing
 * the validator or the evaluator: the loader must not depend on the modules
 * whose vocabulary it is checking, or the check becomes circular and the
 * validator becomes unable to change without the loader agreeing.
 *
 * PURITY. This module is on the kernel-import allowlist that pure modules draw
 * from, so it must stay pure itself: it imports the blocker contract and nothing
 * else — no filesystem, no process, no clock. Reading a config file from disk is
 * the job of the command surfaces; what happens here is validation of a value
 * that has already been handed over.
 *
 * WHO READS WHAT. Every member below names the module that reads it, because a
 * member nothing reads is dead policy that will drift out of truth unnoticed:
 *
 *   gateId                      evidence record store (record identity + filenames)
 *   baseRef                     candidate capture
 *   storageNamespace            evidence record store, preparation receipts
 *   acceptedEnvelopeSpecs       manifest validator (envelope spec rule)
 *   identityVersions            manifest validator (identity-version rule)
 *   computingIdentityVersion    deliverable identity
 *   reviewNeutral               deliverable identity — the only set that
 *                               excludes entries from the deliverable digest
 *   recordNeutral               deliverable identity — a separate predicate that
 *                               never affects the digest
 *   pathClassification          activation projection
 *   sensitivePaths              activation projection
 *   activationThreshold         activation projection
 *   providers[].findingCodes    this loader's partition invariant, admission adapter
 *   agentEnvSignals             execution-context classification
 *   ciPolicies                  execution-context classification
 *   ciPolicyEnvKey              execution-context classification
 *   preparationWiringPaths      preparation receipts (fingerprint input)
 *   obligations[].activation    activation projection, gate evaluator
 *   obligations[].freshness     gate evaluator
 *   obligations[].providers     gate evaluator, admission adapter
 *   obligations[].providerPolicy
 *                               gate evaluator — the quantifier over the
 *                               obligation's providers; capture and projection
 *                               never read it
 *   obligations[].acceptedPayloadSpecs
 *                               manifest validator (claim payload rule)
 *   obligations[].allowedResolutionKinds
 *                               gate evaluator
 *   obligations[].humanWaiverAllowed
 *                               gate evaluator, admission adapter
 *   obligations[].minimumAttestationLevel
 *                               this loader's scope invariant; the manifest
 *                               validator becomes the behavioral reader when
 *                               levels above `self` are specified
 *   obligations[].ciDelegationPolicyIds
 *                               gate evaluator
 *   obligations[].remediation   gate evaluator (blocker remediation catalog)
 *   obligations[].waivableCodes / nonWaivableCodes
 *                               gate evaluator, admission adapter
 *   deliveryRecordPath          the record command, the CI verification action
 *   deliveryRecordVerification  the delivery-record verify core only — never the
 *                               gate evaluator, so the local gate can never be
 *                               more permissive than CI
 */
import { normalizeInstalledDataResourceRequests, type InstalledDataResourceRequest } from "./installed-data-resources.ts";
import { digestCanonical } from "./digest.ts";
import { createBlocker, GATE_STRUCTURAL_FINDING_CODES, type Blocker, BlockedError, type NonEmptyTuple, type Remediation } from "./blockers.ts";

// ── Closed vocabularies ────────────────────────────────────────────────────

/** The identity token this version of the deliverable digest is defined for. */
export const DELIVERABLE_TREE_V1 = "deliverable-tree/v1";

/**
 * The narration set `deliverable-tree/v1` is defined over.
 *
 * The identity token binds this set, in both directions. A digest computed
 * while excluding some *other* set of paths is a different function, and naming
 * it `deliverable-tree/v1` would make two incompatible digests share one token —
 * exactly the confusion a version string exists to prevent. The converse holds
 * too: excluding precisely this set and calling it something else forks the
 * namespace for a function that already has a name.
 */
export const DELIVERABLE_TREE_V1_NARRATION_SET: readonly NeutralMatcher[] = Object.freeze([
  Object.freeze({ prefix: "docs/reports/" }),
  Object.freeze({ prefix: "docs/solutions/" }),
  Object.freeze({ prefix: "telemetry/delivery-runs/" }),
]);

/** The three levels the evidence spec defines. Only `self` is specified in v1. */
export const ATTESTATION_LEVELS = ["self", "provider-signed", "independently-verified"] as const;
export type AttestationLevel = (typeof ATTESTATION_LEVELS)[number];

/** The only level this version can enforce; higher levels await a signing profile. */
export const V1_ATTESTATION_LEVEL: AttestationLevel = "self";

/**
 * The resolutions a config may permit. `blocked` is absent on purpose: it is
 * what happens when nothing else applies, never something policy grants.
 */
export const RESOLUTION_KINDS = [
  "satisfied_live_fact",
  "satisfied_evidence",
  "waived",
  "delegated",
  "not_applicable",
] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

/** Integrity failures are never discharged by policy exceptions. */
export const NON_WAIVABLE_INTEGRITY_CODES: readonly string[] = Object.freeze([
  "ambiguous_records", "malformed_record", "unknown_provider", "stale_evidence", "resolution_not_allowed",
]);

/** When an obligation applies to a candidate. */
export const ACTIVATION_KINDS = ["always", "relevant_change"] as const;
export type ActivationKind = (typeof ACTIVATION_KINDS)[number];

/**
 * The evaluator's quantifier over an obligation's providers. `"all"` demands
 * every approved provider be accounted for; `"existential"` is satisfied by any
 * one of them. Absent means `"all"` — the fail-closed reading, and the only
 * quantifier the evaluator implemented before this member existed.
 */
export const PROVIDER_POLICIES = ["all", "existential"] as const;
export type ProviderPolicy = (typeof PROVIDER_POLICIES)[number];

/**
 * What evidence must be bound to. `exact_candidate` obligations are satisfied by
 * evidence recorded against this candidate's identity; `live` obligations are
 * facts the gate observes now and never inherits from a prior invocation.
 */
export const FRESHNESS_KINDS = ["live", "exact_candidate"] as const;
export type FreshnessKind = (typeof FRESHNESS_KINDS)[number];

/** Whether a moved base invalidates a tracked delivery record. */
export const BASE_MOVEMENT_POLICIES = ["stale", "allow"] as const;
export type BaseMovementPolicy = (typeof BASE_MOVEMENT_POLICIES)[number];

/** Path matchers outside the neutral sets carry their kind explicitly. */
export const PATH_MATCHER_KINDS = ["prefix", "glob"] as const;
export type PathMatcherKind = (typeof PATH_MATCHER_KINDS)[number];

// ── Defaults ───────────────────────────────────────────────────────────────

/** Evidence lives under the git directory, not the worktree. */
export const DEFAULT_STORAGE_NAMESPACE = "delivery-harness/";

export const DEFAULT_BASE_REF = "origin/main";

/** A moved base stales a delivery record unless the config says otherwise. */
export const DEFAULT_BASE_MOVEMENT_POLICY: BaseMovementPolicy = "stale";

// ── Shapes ─────────────────────────────────────────────────────────────────

/**
 * Neutral-set matchers are prefix-anchored, with an optional suffix. They are
 * deliberately weaker than the classification matchers below: these decide what
 * leaves a content digest, and a glob there would make identity depend on the
 * subtleties of a pattern engine.
 */
export interface NeutralMatcher {
  readonly prefix: string;
  readonly suffix?: string;
}

export interface PathMatcher {
  readonly kind: PathMatcherKind;
  readonly value: string;
}

export interface SensitivePathGroup {
  readonly id: string;
  readonly patterns: readonly PathMatcher[];
}

export interface PathClassification {
  readonly generated: readonly PathMatcher[];
  readonly test: readonly PathMatcher[];
  readonly lockfile: readonly PathMatcher[];
}

export interface ProviderRegistration {
  readonly id: string;
  /** Every finding code this provider can report. Half of the code universe. */
  readonly findingCodes: readonly string[];
  /** Optional stdio provider-rail executable, expressed as argv and never a shell string. */
  readonly command?: NonEmptyTuple<string>;
  /** Deterministic bounded check executed by the product, not a provider protocol. */
  readonly check?: { readonly command: NonEmptyTuple<string>; readonly timeoutMs: number; readonly outputs?: readonly string[]; readonly scope?: ScopedCheckDefinition; readonly installedData?: InstalledDataConsumerDefinition };
}

/** Explicit opt-in. Lists are repository-relative; memberships are directory prefixes. */
export interface ScopedCheckDefinition {
  readonly version: "scoped-check/1";
  readonly files: readonly string[];
  readonly memberships: readonly string[];
  readonly tests: readonly string[];
  readonly cwd: string;
  readonly profile: string;
  readonly environment: readonly { readonly name: string; readonly kind: "flag" | "credential" }[];
}

export function isScopedCheckDefinition(value: unknown): value is ScopedCheckDefinition {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "cwd,environment,files,memberships,profile,tests,version" || value["version"] !== "scoped-check/1") return false;
  const safePath = (p: unknown): p is string => typeof p === "string" && p.length > 0 && !p.includes("\\") && !p.includes("\0") && !p.startsWith("/") && !p.split("/").some(v => v === "." || v === ".." || v === "");
  const paths = (v: unknown, prefix = false) => Array.isArray(v) && new Set(v).size === v.length && v.every(p => safePath(prefix && typeof p === "string" && p.endsWith("/") ? p.slice(0, -1) : p) && (!prefix || p.endsWith("/")));
  const env = value["environment"];
  return paths(value["files"]) && paths(value["tests"]) && paths(value["memberships"], true) &&
    (value["cwd"] === "." || safePath(value["cwd"])) && typeof value["profile"] === "string" && /^[a-zA-Z0-9_.-]+$/.test(value["profile"]) &&
    Array.isArray(env) && env.every(e => isRecord(e) && Object.keys(e).sort().join(",") === "kind,name" && typeof e["name"] === "string" && /^[A-Z_][A-Z0-9_]*$/.test(e["name"]) && !/^(?:GIT_|DELIVERY_CHECK_)/.test(e["name"]) && !["PATH", "HOME", "TMPDIR", "TMP", "TEMP"].includes(e["name"]) && (e["kind"] === "flag" || e["kind"] === "credential")) && new Set(env.map(e => e.name)).size === env.length;
}

/** Guarded source applicability declaration; this field alone grants no omission. */
export interface InstalledDataConsumerDefinition {
  readonly version: "installed-data-consumer/1";
  readonly consumerId: string;
  readonly requests: readonly InstalledDataResourceRequest[];
  readonly source: ScopedCheckDefinition;
  readonly guards: Readonly<Record<string, string>>;
}
export function isInstalledDataConsumerDefinition(value: unknown): value is InstalledDataConsumerDefinition {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "consumerId,guards,requests,source,version" || value["version"] !== "installed-data-consumer/1" || typeof value["consumerId"] !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value["consumerId"]) || !isScopedCheckDefinition(value["source"]) || !isRecord(value["guards"])) return false;
  const source = value["source"], guards = value["guards"];
  const paths = [...new Set([...source.files, ...source.tests])].sort();
  if (Object.keys(guards).length === 0 || Object.keys(guards).some(file => !paths.includes(file)) || !Object.values(guards).every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) return false;
  try {
    const requests = normalizeInstalledDataResourceRequests(value["requests"]);
    return requests.every(request => source.tests.includes(request.issuer) && Object.hasOwn(guards, request.issuer));
  } catch { return false; }
}

/** Supported private executor profiles; old runtimes reject this opt-in. */
export interface ScopedExecutionProfile {
  /** Full Git context is conservative; none permits file-scoped reuse without Git metadata. */
  readonly gitContext?: "full" | "none";
  readonly id: string;
  readonly dependencyInputs: readonly string[];
  readonly dependencies?: { readonly command: NonEmptyTuple<string>; readonly timeoutMs: number };
  readonly mutableOutputs: readonly string[];
  readonly credentialIdentities: Readonly<Record<string, string>>;
}
export interface ScopedExecutionDefinition {
  readonly version: "scoped-execution/1";
  readonly profiles: readonly ScopedExecutionProfile[];
  readonly mechanicalProviders: readonly string[];
  /** Explicit source repair before capture; preparationCommands remain validators. */
  readonly repairCommands?: readonly PreparationCommand[];
  /** How many scoped checks may run at once, each in a snapshot its worker owns; unset means one. */
  readonly concurrency?: number;
}
function isScopedExecution(value: unknown): value is ScopedExecutionDefinition {
  if (!isRecord(value) || Object.keys(value).some(k => !["mechanicalProviders", "profiles", "version", "repairCommands", "concurrency"].includes(k)) || value["version"] !== "scoped-execution/1" || !Array.isArray(value["profiles"]) || !Array.isArray(value["mechanicalProviders"])) return false;
  if (value["concurrency"] !== undefined && (!Number.isSafeInteger(value["concurrency"]) || Number(value["concurrency"]) < 1)) return false;
  const repairs = value["repairCommands"];
  if (repairs !== undefined && (!Array.isArray(repairs) || new Set(repairs.map(r => isRecord(r) ? r["id"] : null)).size !== repairs.length || !repairs.every(r => isRecord(r) && Object.keys(r).sort().join(",") === "command,id,timeoutMs" && typeof r["id"] === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r["id"]) && Array.isArray(r["command"]) && r["command"].length > 0 && r["command"].every(a => typeof a === "string" && a.length > 0 && !a.includes("\0")) && Number.isSafeInteger(r["timeoutMs"]) && Number(r["timeoutMs"]) > 0 && Number(r["timeoutMs"]) <= 3600000))) return false;
  const safe = (v: unknown) => typeof v === "string" && v.length > 0 && !v.startsWith("/") && !v.includes("\\") && !v.includes("\0") && !v.replace(/\/$/, "").split("/").some(p => p === ".." || p === "." || p === "") && !v.split("/").includes(".git") && !v.split("/").includes("node_modules");
  const list = (v: unknown) => Array.isArray(v) && new Set(v).size === v.length && v.every(safe);
  return new Set(value["mechanicalProviders"]).size === value["mechanicalProviders"].length && value["mechanicalProviders"].every(v => typeof v === "string") &&
    new Set(value["profiles"].map(p => isRecord(p) ? p["id"] : null)).size === value["profiles"].length && value["profiles"].every(p => {
      if (!isRecord(p) || Object.keys(p).some(k => !["id", "dependencyInputs", "dependencies", "mutableOutputs", "credentialIdentities", "gitContext"].includes(k)) || typeof p["id"] !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(p["id"]) || !list(p["dependencyInputs"]) || !list(p["mutableOutputs"]) || !isRecord(p["credentialIdentities"]) || !Object.entries(p["credentialIdentities"]).every(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === "string" && v.length > 0)) return false;
      if (p["gitContext"] !== undefined && p["gitContext"] !== "full" && p["gitContext"] !== "none") return false;
      const dep = p["dependencies"];
      return dep === undefined || (isRecord(dep) && Object.keys(dep).sort().join(",") === "command,timeoutMs" && Array.isArray(dep["command"]) && dep["command"].length > 0 && dep["command"].every(v => typeof v === "string" && v.length > 0 && !v.includes("\0")) && Number.isSafeInteger(dep["timeoutMs"]) && Number(dep["timeoutMs"]) > 0 && Number(dep["timeoutMs"]) <= 3600000);
    });
}

export interface PreparationCommand {
  readonly id: string;
  /** Executed directly from the repository root, in declaration order. */
  readonly command: NonEmptyTuple<string>;
  readonly timeoutMs: number;
}

export interface EnvironmentRequirement {
  readonly variable: string;
  readonly equals: string;
}

/**
 * A CI policy is selected by name (the value of `ciPolicyEnvKey`) and then
 * corroborated by `requiredEnv`. A selection whose corroboration fails is an
 * unauthorized automation, never a downgrade to an anonymous context.
 */
export interface CiPolicy {
  readonly id: string;
  readonly requiredEnv: readonly EnvironmentRequirement[];
}

export interface RemediationCatalog {
  readonly default: readonly Remediation[];
  readonly byCode?: Readonly<Record<string, readonly Remediation[]>>;
}

/**
 * When an obligation applies, and how the `relevant_change` signals may be
 * narrowed. The three optional members are read by the activation projection's
 * `isObligationActive` and nothing else, and every one of them defaults to the
 * widened, fail-closed reading:
 *
 *   `sensitiveGroupIds`  absent: every declared sensitive-path group activates
 *                        this obligation. Present: only the named groups do —
 *                        and an empty list opts the obligation out of the
 *                        sensitive signal entirely. Each id must name a group
 *                        in `sensitivePaths`; the loader rejects a dangling
 *                        reference the same way it rejects a dangling provider.
 *   `relevantBinaryChangeActivates`
 *                        absent or true: a reviewable binary change activates.
 *   `relevantZeroLineChangeActivates`
 *                        absent or true: a reviewable change that counts no
 *                        lines (a mode flip, a pure rename) activates.
 *
 * The two flags are deliberately separate members: they name independent
 * signals. A security-review obligation may not care about a `chmod` yet care
 * intensely about a replaced binary; a licence obligation is the reverse.
 * None of the three narrows an `always` obligation, which ignores the
 * projection entirely.
 */
export interface ObligationActivation {
  readonly kind: ActivationKind;
  readonly sensitiveGroupIds?: readonly string[];
  readonly relevantBinaryChangeActivates?: boolean;
  readonly relevantZeroLineChangeActivates?: boolean;
}

export interface ObligationPolicy {
  readonly id: string;
  readonly activation: ObligationActivation;
  readonly freshness: FreshnessKind;
  readonly providers: readonly string[];
  /**
   * The evaluator's quantifier over `providers`. Absent means `"all"`, which is
   * byte-for-byte the behavior the evaluator had before this member existed —
   * the member is additive, and only `"existential"` changes anything.
   */
  readonly providerPolicy?: ProviderPolicy;
  readonly acceptedPayloadSpecs: readonly string[];
  readonly allowedResolutionKinds: readonly ResolutionKind[];
  readonly humanWaiverAllowed: boolean;
  readonly minimumAttestationLevel: AttestationLevel;
  readonly ciDelegationPolicyIds: readonly string[];
  readonly remediation: RemediationCatalog;
  readonly waivableCodes: readonly string[];
  readonly nonWaivableCodes: readonly string[];
}

export interface DeliveryRecordVerification {
  readonly baseMovement: BaseMovementPolicy;
}

/** Repository-selected review policy, added to the installed default charters. */
export interface AdditionalReviewLens {
  readonly lensId: string;
  readonly reviewerId: string;
  readonly charterPath: string;
}

export interface HarnessConfig {
  readonly gateId: string;
  readonly baseRef: string;
  readonly storageNamespace: string;
  readonly acceptedEnvelopeSpecs: readonly string[];
  readonly identityVersions: readonly string[];
  readonly computingIdentityVersion: string;
  readonly reviewNeutral: readonly NeutralMatcher[];
  readonly recordNeutral: readonly NeutralMatcher[];
  readonly pathClassification: PathClassification;
  readonly sensitivePaths: readonly SensitivePathGroup[];
  readonly activationThreshold: number;
  readonly providers: readonly ProviderRegistration[];
  readonly agentEnvSignals: readonly string[];
  readonly ciPolicies: readonly CiPolicy[];
  readonly ciPolicyEnvKey: string;
  /**
   * An explicitly empty list supports minimal consumers with no repository
   * wiring to fingerprint. Their preparation fingerprint binds the harness
   * version and any preparation commands, but no repository file contents;
   * file-wiring-change and missing-path checks are inapplicable.
   */
  readonly preparationWiringPaths: readonly string[];
  readonly preparationCommands?: readonly PreparationCommand[];
  readonly scopedExecution?: ScopedExecutionDefinition;
  readonly additionalReviewLenses?: readonly AdditionalReviewLens[];
  readonly obligations: readonly ObligationPolicy[];
  readonly deliveryRecordPath: string;
  readonly deliveryRecordVerification: DeliveryRecordVerification;
}

/** The three members that carry defaults are optional at the authoring site. */
export type HarnessConfigInput = Omit<HarnessConfig, "baseRef" | "storageNamespace" | "deliveryRecordVerification"> &
  Partial<Pick<HarnessConfig, "baseRef" | "storageNamespace" | "deliveryRecordVerification">>;

export type HarnessConfigValidation =
  | { readonly ok: true; readonly config: HarnessConfig }
  | { readonly ok: false; readonly blockers: NonEmptyTuple<Blocker> };

// ── Finding codes ──────────────────────────────────────────────────────────

/**
 * What a config can be wrong about. Each code is produced by exactly one rule,
 * so a falsification row can name the rule it is falsifying rather than
 * asserting on prose.
 */
export const CONFIG_FINDING_CODES = [
  // Grammar
  "config_unknown_member",
  "config_missing_member",
  "config_invalid_member",
  "config_duplicate_id",
  "config_code_collision",
  // References
  "config_dangling_provider",
  "config_dangling_ci_policy",
  "config_dangling_sensitive_group",
  // Not a dangling reference: it fires on an obligation that accepts *no*
  // payload spec, so nothing can ever bind to it.
  "config_no_payload_spec",
  // Policy coherence
  "config_waiver_policy_mismatch",
  "config_empty_remediation",
  "config_unclassified_finding_code",
  "config_double_classified_finding_code",
  "config_stale_finding_code",
  // Identity and neutrality
  "config_record_neutral_not_subset",
  "config_delivery_record_not_neutral",
  "config_identity_version_not_accepted",
  "config_identity_token_requires_v1_neutral_set",
  "config_v1_neutral_set_requires_v1_token",
  // Scope
  "config_no_obligations",
  "config_unsupported_attestation_level",
] as const;

export type ConfigFindingCode = (typeof CONFIG_FINDING_CODES)[number];

// ── Grammars ───────────────────────────────────────────────────────────────

/** Gate, obligation, provider, policy and group ids share one grammar. */
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Finding codes: the blocker contract's grammar, no dots. */
const FINDING_CODE_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

const REMEDIATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `delivery-evidence/1`, `review.green/1`, `deliverable-tree/v1`. */
const SPEC_TOKEN_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9][a-z0-9.-]*$/;

const ENV_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A git ref or refspec: printable, no whitespace, not an option. */
const REF_PATTERN = /^[!-,.-~][!-~]*$/;

const REMEDIATION_KINDS = ["command", "manual_action", "code_change", "retry"] as const;

/**
 * Repo-relative POSIX paths only. A backslash is rejected rather than rewritten:
 * on a case-folding or path-rewriting host, a config that says `docs\reports\`
 * and an identity computation that says `docs/reports/` would disagree silently,
 * and the disagreement would show up as an unexplained digest change. A NUL is
 * rejected for a duller reason: no such path can exist, so one in a config is a
 * mangled string rather than a location.
 */
function isRepoRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.includes("\\") || value.includes("\u0000")) return false;
  if (value.trim() !== value) return false;
  return value.split("/").every((segment, index, segments) => {
    if (segment === "." || segment === "..") return false;
    // A trailing slash (a directory prefix) is legal; an interior empty segment
    // is a doubled slash and is not.
    return segment !== "" || index === segments.length - 1;
  });
}

// ── Finding collection ─────────────────────────────────────────────────────

interface ConfigFinding {
  readonly code: ConfigFindingCode;
  /** Dotted member path, used verbatim in the blocker summary. */
  readonly member: string;
  readonly detail: string;
}

class FindingList {
  readonly entries: ConfigFinding[] = [];

  add(code: ConfigFindingCode, member: string, detail: string): void {
    this.entries.push({ code, member, detail });
  }

  get length(): number {
    return this.entries.length;
  }
}

/**
 * Config findings are blockers like every other failure in the harness, so they
 * render through the one renderer and carry a way forward. The way forward is
 * always the same shape — edit the config — but naming the exact member is what
 * makes it actionable, so the remediation is built per finding rather than
 * shared.
 *
 * The member name is backtick-quoted, and that is load-bearing rather than
 * decorative. Blocker construction redacts credential-shaped text, and a member
 * whose name ends in `Key`, `Token`, `Secret` or `Password` followed by `: `
 * reads exactly like a credential assignment — `ciPolicyEnvKey: is required`
 * renders as `ciPolicyEnvKey: [REDACTED]`, destroying the diagnostic to protect
 * a secret that was never there. A quote between the name and the separator
 * cannot complete that match, so the operator keeps the sentence.
 */
function toBlocker(finding: ConfigFinding, sourceId: string): Blocker {
  return createBlocker({
    code: finding.code,
    source: { kind: "config", id: sourceId },
    summary: `\`${finding.member}\`: ${finding.detail}`,
    remediations: [
      {
        id: "correct-harness-config",
        kind: "code_change",
        summary: `Correct \`${finding.member}\` in the harness config.`,
        details: finding.detail,
      },
    ],
  });
}

// ── Shape validation ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects members the grammar does not name. The grammar is closed everywhere. */
function checkClosed(findings: FindingList, member: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      findings.add("config_unknown_member", `${member}.${key}`, "is not a member of the config grammar");
    }
  }
}

function readString(
  findings: FindingList,
  member: string,
  value: unknown,
  check: { readonly pattern?: RegExp; readonly path?: boolean; readonly describe: string },
): string | undefined {
  if (typeof value !== "string") {
    findings.add("config_invalid_member", member, `must be a string (${check.describe})`);
    return undefined;
  }
  if (check.pattern !== undefined && !check.pattern.test(value)) {
    findings.add("config_invalid_member", member, `${JSON.stringify(value)} is not ${check.describe}`);
    return undefined;
  }
  if (check.path === true && !isRepoRelativePath(value)) {
    findings.add("config_invalid_member", member, `${JSON.stringify(value)} is not a repo-relative POSIX path`);
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(findings: FindingList, member: string, value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  findings.add("config_invalid_member", member, `must be one of ${allowed.join(", ")}`);
  return undefined;
}

function readBoolean(findings: FindingList, member: string, value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  findings.add("config_invalid_member", member, "must be a boolean");
  return undefined;
}

function readArray(findings: FindingList, member: string, value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  findings.add("config_invalid_member", member, "must be an array");
  return undefined;
}

function readStringArray(
  findings: FindingList,
  member: string,
  value: unknown,
  check: { readonly pattern?: RegExp; readonly path?: boolean; readonly describe: string },
): readonly string[] | undefined {
  const array = readArray(findings, member, value);
  if (array === undefined) return undefined;
  const out: string[] = [];
  let sound = true;
  array.forEach((entry, index) => {
    const read = readString(findings, `${member}[${index}]`, entry, check);
    if (read === undefined) sound = false;
    else out.push(read);
  });
  return sound ? out : undefined;
}

function readNeutralMatchers(findings: FindingList, member: string, value: unknown): readonly NeutralMatcher[] | undefined {
  const array = readArray(findings, member, value);
  if (array === undefined) return undefined;
  const out: NeutralMatcher[] = [];
  let sound = true;
  array.forEach((entry, index) => {
    const at = `${member}[${index}]`;
    if (!isRecord(entry)) {
      findings.add("config_invalid_member", at, "must be an object naming a prefix and an optional suffix");
      sound = false;
      return;
    }
    checkClosed(findings, at, entry, ["prefix", "suffix"]);
    const prefix = readString(findings, `${at}.prefix`, entry["prefix"], { path: true, describe: "a repo-relative path prefix" });
    const suffix = entry["suffix"] === undefined ? undefined : readString(findings, `${at}.suffix`, entry["suffix"], { describe: "a path suffix" });
    if (prefix === undefined || (entry["suffix"] !== undefined && suffix === undefined)) {
      sound = false;
      return;
    }
    // An empty suffix constrains nothing, so it is normalized away here rather
    // than carried. Two consumers read a suffix differently — the subset check
    // compares it, the set-equality check keys on it — and an author's `""`
    // meaning "no suffix" has to mean that to both of them.
    out.push(suffix === undefined || suffix === "" ? { prefix } : { prefix, suffix });
  });
  return sound ? out : undefined;
}

function readPathMatchers(findings: FindingList, member: string, value: unknown): readonly PathMatcher[] | undefined {
  const array = readArray(findings, member, value);
  if (array === undefined) return undefined;
  const out: PathMatcher[] = [];
  let sound = true;
  array.forEach((entry, index) => {
    const at = `${member}[${index}]`;
    if (!isRecord(entry)) {
      findings.add("config_invalid_member", at, "must be an object naming a matcher kind and a value");
      sound = false;
      return;
    }
    checkClosed(findings, at, entry, ["kind", "value"]);
    const kind = readEnum(findings, `${at}.kind`, entry["kind"], PATH_MATCHER_KINDS);
    const matcherValue = readString(findings, `${at}.value`, entry["value"], { describe: "a non-empty matcher value" });
    if (kind === undefined || matcherValue === undefined || matcherValue === "") {
      if (matcherValue === "") findings.add("config_invalid_member", `${at}.value`, "must be non-empty");
      sound = false;
      return;
    }
    out.push({ kind, value: matcherValue });
  });
  return sound ? out : undefined;
}

function readRemediations(findings: FindingList, member: string, value: unknown): readonly Remediation[] | undefined {
  const array = readArray(findings, member, value);
  if (array === undefined) return undefined;
  const out: Remediation[] = [];
  let sound = true;
  array.forEach((entry, index) => {
    const at = `${member}[${index}]`;
    if (!isRecord(entry)) {
      findings.add("config_invalid_member", at, "must be a remediation object");
      sound = false;
      return;
    }
    checkClosed(findings, at, entry, ["id", "kind", "summary", "details", "command"]);
    const id = readString(findings, `${at}.id`, entry["id"], { pattern: REMEDIATION_ID_PATTERN, describe: "a kebab-case remediation id" });
    const kind = readEnum(findings, `${at}.kind`, entry["kind"], REMEDIATION_KINDS);
    const summary = readString(findings, `${at}.summary`, entry["summary"], { describe: "a one-line summary" });
    const details = entry["details"] === undefined ? undefined : readString(findings, `${at}.details`, entry["details"], { describe: "remediation details" });
    let command: readonly string[] | undefined;
    if (kind === "command" || (kind === "retry" && entry["command"] !== undefined)) {
      command = readStringArray(findings, `${at}.command`, entry["command"], { describe: "an argv element" });
      if (command !== undefined && command.length === 0) {
        findings.add("config_invalid_member", `${at}.command`, "must be a non-empty argv array");
        command = undefined;
      }
    } else if (entry["command"] !== undefined) {
      findings.add("config_invalid_member", `${at}.command`, `is only meaningful on a command or retry remediation, not on ${String(entry["kind"])}`);
      sound = false;
    }
    if (id === undefined || kind === undefined || summary === undefined) {
      sound = false;
      return;
    }
    if ((kind === "command" || (kind === "retry" && entry["command"] !== undefined)) && command === undefined) {
      sound = false;
      return;
    }
    const base = { id, summary, ...(details === undefined ? {} : { details }) };
    if (kind === "command") out.push({ ...base, kind, command: command as NonEmptyTuple<string> });
    else if (kind === "retry" && command !== undefined) out.push({ ...base, kind, command: command as NonEmptyTuple<string> });
    else if (kind === "retry") out.push({ ...base, kind });
    else out.push({ ...base, kind });
  });
  return sound ? out : undefined;
}

function readRemediationCatalog(findings: FindingList, member: string, value: unknown): RemediationCatalog | undefined {
  if (!isRecord(value)) {
    findings.add("config_invalid_member", member, "must be an object with a default catalog and an optional per-code catalog");
    return undefined;
  }
  checkClosed(findings, member, value, ["default", "byCode"]);
  const fallback = readRemediations(findings, `${member}.default`, value["default"]);
  let byCode: Record<string, readonly Remediation[]> | undefined;
  if (value["byCode"] !== undefined) {
    if (!isRecord(value["byCode"])) {
      findings.add("config_invalid_member", `${member}.byCode`, "must be an object keyed by finding code");
      return undefined;
    }
    byCode = {};
    for (const [code, entry] of Object.entries(value["byCode"])) {
      if (!FINDING_CODE_PATTERN.test(code)) {
        findings.add("config_invalid_member", `${member}.byCode.${code}`, "is not a finding-code identifier");
        continue;
      }
      const read = readRemediations(findings, `${member}.byCode.${code}`, entry);
      if (read !== undefined) byCode[code] = read;
    }
  }
  if (fallback === undefined) return undefined;
  return byCode === undefined ? { default: fallback } : { default: fallback, byCode };
}

const REQUIRED_OBLIGATION_MEMBERS = [
  "id",
  "activation",
  "freshness",
  "providers",
  "acceptedPayloadSpecs",
  "allowedResolutionKinds",
  "humanWaiverAllowed",
  "minimumAttestationLevel",
  "ciDelegationPolicyIds",
  "remediation",
  "waivableCodes",
  "nonWaivableCodes",
] as const;

/** `providerPolicy` is the one optional member: absence means `"all"`. */
const OBLIGATION_MEMBERS = [...REQUIRED_OBLIGATION_MEMBERS, "providerPolicy"] as const;

/**
 * `kind` is required; the three narrowing members are optional because their
 * absence *is* the widened policy — see {@link ObligationActivation}.
 */
const ACTIVATION_MEMBERS = ["kind", "sensitiveGroupIds", "relevantBinaryChangeActivates", "relevantZeroLineChangeActivates"] as const;

function readActivation(findings: FindingList, member: string, value: Record<string, unknown>): ObligationActivation | undefined {
  checkClosed(findings, member, value, ACTIVATION_MEMBERS);
  const kind = readEnum(findings, `${member}.kind`, value["kind"], ACTIVATION_KINDS);
  const sensitiveGroupIds =
    value["sensitiveGroupIds"] === undefined
      ? undefined
      : readStringArray(findings, `${member}.sensitiveGroupIds`, value["sensitiveGroupIds"], {
          pattern: ID_PATTERN,
          describe: "a sensitive-path group id",
        });
  const relevantBinaryChangeActivates =
    value["relevantBinaryChangeActivates"] === undefined
      ? undefined
      : readBoolean(findings, `${member}.relevantBinaryChangeActivates`, value["relevantBinaryChangeActivates"]);
  const relevantZeroLineChangeActivates =
    value["relevantZeroLineChangeActivates"] === undefined
      ? undefined
      : readBoolean(findings, `${member}.relevantZeroLineChangeActivates`, value["relevantZeroLineChangeActivates"]);
  if (kind === undefined) return undefined;
  if (value["sensitiveGroupIds"] !== undefined && sensitiveGroupIds === undefined) return undefined;
  if (value["relevantBinaryChangeActivates"] !== undefined && relevantBinaryChangeActivates === undefined) return undefined;
  if (value["relevantZeroLineChangeActivates"] !== undefined && relevantZeroLineChangeActivates === undefined) return undefined;
  return {
    kind,
    ...(sensitiveGroupIds === undefined ? {} : { sensitiveGroupIds }),
    ...(relevantBinaryChangeActivates === undefined ? {} : { relevantBinaryChangeActivates }),
    ...(relevantZeroLineChangeActivates === undefined ? {} : { relevantZeroLineChangeActivates }),
  };
}

function readObligation(findings: FindingList, member: string, value: unknown): ObligationPolicy | undefined {
  if (!isRecord(value)) {
    findings.add("config_invalid_member", member, "must be an obligation object");
    return undefined;
  }
  checkClosed(findings, member, value, OBLIGATION_MEMBERS);
  for (const name of REQUIRED_OBLIGATION_MEMBERS) {
    if (value[name] === undefined) findings.add("config_missing_member", `${member}.${name}`, "is required");
  }

  const id =
    value["id"] === undefined ? undefined : readString(findings, `${member}.id`, value["id"], { pattern: ID_PATTERN, describe: "a lowercase obligation id" });

  let activation: ObligationActivation | undefined;
  if (isRecord(value["activation"])) {
    activation = readActivation(findings, `${member}.activation`, value["activation"]);
  } else if (value["activation"] !== undefined) {
    findings.add("config_invalid_member", `${member}.activation`, "must be an object naming an activation kind");
  }

  const freshness = value["freshness"] === undefined ? undefined : readEnum(findings, `${member}.freshness`, value["freshness"], FRESHNESS_KINDS);
  const providerPolicy =
    value["providerPolicy"] === undefined ? undefined : readEnum(findings, `${member}.providerPolicy`, value["providerPolicy"], PROVIDER_POLICIES);
  const providers =
    value["providers"] === undefined
      ? undefined
      : readStringArray(findings, `${member}.providers`, value["providers"], { pattern: ID_PATTERN, describe: "a provider id" });
  const acceptedPayloadSpecs =
    value["acceptedPayloadSpecs"] === undefined
      ? undefined
      : readStringArray(findings, `${member}.acceptedPayloadSpecs`, value["acceptedPayloadSpecs"], {
          pattern: SPEC_TOKEN_PATTERN,
          describe: "a payload spec token",
        });
  let allowedResolutionKinds: readonly ResolutionKind[] | undefined;
  if (value["allowedResolutionKinds"] !== undefined) {
    const array = readArray(findings, `${member}.allowedResolutionKinds`, value["allowedResolutionKinds"]);
    if (array !== undefined) {
      const read = array.map((entry, index) => readEnum(findings, `${member}.allowedResolutionKinds[${index}]`, entry, RESOLUTION_KINDS));
      if (read.every((entry): entry is ResolutionKind => entry !== undefined)) allowedResolutionKinds = read;
    }
  }
  const humanWaiverAllowed = value["humanWaiverAllowed"] === undefined ? undefined : readBoolean(findings, `${member}.humanWaiverAllowed`, value["humanWaiverAllowed"]);
  const minimumAttestationLevel =
    value["minimumAttestationLevel"] === undefined
      ? undefined
      : readEnum(findings, `${member}.minimumAttestationLevel`, value["minimumAttestationLevel"], ATTESTATION_LEVELS);
  const ciDelegationPolicyIds =
    value["ciDelegationPolicyIds"] === undefined
      ? undefined
      : readStringArray(findings, `${member}.ciDelegationPolicyIds`, value["ciDelegationPolicyIds"], { pattern: ID_PATTERN, describe: "a CI policy id" });
  const remediation = value["remediation"] === undefined ? undefined : readRemediationCatalog(findings, `${member}.remediation`, value["remediation"]);
  const waivableCodes =
    value["waivableCodes"] === undefined
      ? undefined
      : readStringArray(findings, `${member}.waivableCodes`, value["waivableCodes"], { pattern: FINDING_CODE_PATTERN, describe: "a finding code" });
  const nonWaivableCodes =
    value["nonWaivableCodes"] === undefined
      ? undefined
      : readStringArray(findings, `${member}.nonWaivableCodes`, value["nonWaivableCodes"], { pattern: FINDING_CODE_PATTERN, describe: "a finding code" });

  if (
    id === undefined ||
    activation === undefined ||
    freshness === undefined ||
    providers === undefined ||
    acceptedPayloadSpecs === undefined ||
    allowedResolutionKinds === undefined ||
    humanWaiverAllowed === undefined ||
    minimumAttestationLevel === undefined ||
    ciDelegationPolicyIds === undefined ||
    remediation === undefined ||
    waivableCodes === undefined ||
    nonWaivableCodes === undefined
  ) {
    return undefined;
  }
  return {
    id,
    activation,
    freshness,
    providers,
    ...(providerPolicy === undefined ? {} : { providerPolicy }),
    acceptedPayloadSpecs,
    allowedResolutionKinds,
    humanWaiverAllowed,
    minimumAttestationLevel,
    ciDelegationPolicyIds,
    remediation,
    waivableCodes,
    nonWaivableCodes,
  };
}

const CONFIG_MEMBERS = [
  "gateId",
  "baseRef",
  "storageNamespace",
  "acceptedEnvelopeSpecs",
  "identityVersions",
  "computingIdentityVersion",
  "reviewNeutral",
  "recordNeutral",
  "pathClassification",
  "sensitivePaths",
  "activationThreshold",
  "providers",
  "agentEnvSignals",
  "ciPolicies",
  "ciPolicyEnvKey",
  "preparationWiringPaths",
  "preparationCommands",
  "additionalReviewLenses",
  "scopedExecution",
  "obligations",
  "deliveryRecordPath",
  "deliveryRecordVerification",
] as const;

/** Members the author may omit. Optional extensions stay absent when unused. */
const DEFAULTED_MEMBERS = ["baseRef", "storageNamespace", "deliveryRecordVerification", "preparationCommands", "additionalReviewLenses", "scopedExecution"] as const;

function readAdditionalReviewLenses(findings: FindingList, value: unknown): readonly AdditionalReviewLens[] | undefined {
  const entries = readArray(findings, "additionalReviewLenses", value);
  if (entries === undefined) return undefined;
  const lenses: AdditionalReviewLens[] = [];
  for (const [index, entry] of entries.entries()) {
    const member = `additionalReviewLenses[${index}]`;
    if (!isRecord(entry)) {
      findings.add("config_invalid_member", member, "must name a lens, reviewer, and repository charter path");
      continue;
    }
    checkClosed(findings, member, entry, ["lensId", "reviewerId", "charterPath"]);
    const lensId = readString(findings, `${member}.lensId`, entry["lensId"], { pattern: ID_PATTERN, describe: "a lens id" });
    const reviewerId = readString(findings, `${member}.reviewerId`, entry["reviewerId"], { pattern: ID_PATTERN, describe: "a reviewer id" });
    const charterPath = readString(findings, `${member}.charterPath`, entry["charterPath"], { path: true, describe: "a repo-relative charter file" });
    if (charterPath?.endsWith("/")) findings.add("config_invalid_member", `${member}.charterPath`, "must name a file, not a directory prefix");
    if (lensId !== undefined && reviewerId !== undefined && charterPath !== undefined) lenses.push({ lensId, reviewerId, charterPath });
  }
  checkDuplicateIds(findings, "additionalReviewLenses.lensId", lenses.map((lens) => lens.lensId));
  checkDuplicateIds(findings, "additionalReviewLenses.reviewerId", lenses.map((lens) => lens.reviewerId));
  return lenses;
}

function readShape(findings: FindingList, input: unknown): HarnessConfig | undefined {
  if (!isRecord(input)) {
    findings.add("config_invalid_member", "<config>", "must be an object");
    return undefined;
  }
  checkClosed(findings, "<config>", input, CONFIG_MEMBERS);
  for (const name of CONFIG_MEMBERS) {
    if (input[name] === undefined && name !== "preparationCommands" && !(DEFAULTED_MEMBERS as readonly string[]).includes(name)) {
      findings.add("config_missing_member", name, "is required");
    }
  }

  const gateId =
    input["gateId"] === undefined ? undefined : readString(findings, "gateId", input["gateId"], { pattern: ID_PATTERN, describe: "a lowercase gate id" });
  const baseRef =
    input["baseRef"] === undefined ? DEFAULT_BASE_REF : readString(findings, "baseRef", input["baseRef"], { pattern: REF_PATTERN, describe: "a git ref" });
  const storageNamespace =
    input["storageNamespace"] === undefined
      ? DEFAULT_STORAGE_NAMESPACE
      : readString(findings, "storageNamespace", input["storageNamespace"], { path: true, describe: "a repo-relative storage namespace" });
  const acceptedEnvelopeSpecs =
    input["acceptedEnvelopeSpecs"] === undefined
      ? undefined
      : readStringArray(findings, "acceptedEnvelopeSpecs", input["acceptedEnvelopeSpecs"], { pattern: SPEC_TOKEN_PATTERN, describe: "an envelope spec token" });
  const identityVersions =
    input["identityVersions"] === undefined
      ? undefined
      : readStringArray(findings, "identityVersions", input["identityVersions"], { pattern: SPEC_TOKEN_PATTERN, describe: "an identity version token" });
  const computingIdentityVersion =
    input["computingIdentityVersion"] === undefined
      ? undefined
      : readString(findings, "computingIdentityVersion", input["computingIdentityVersion"], { pattern: SPEC_TOKEN_PATTERN, describe: "an identity version token" });
  const reviewNeutral = input["reviewNeutral"] === undefined ? undefined : readNeutralMatchers(findings, "reviewNeutral", input["reviewNeutral"]);
  const recordNeutral = input["recordNeutral"] === undefined ? undefined : readNeutralMatchers(findings, "recordNeutral", input["recordNeutral"]);

  let pathClassification: PathClassification | undefined;
  if (isRecord(input["pathClassification"])) {
    checkClosed(findings, "pathClassification", input["pathClassification"], ["generated", "test", "lockfile"]);
    const generated = readPathMatchers(findings, "pathClassification.generated", input["pathClassification"]["generated"]);
    const test = readPathMatchers(findings, "pathClassification.test", input["pathClassification"]["test"]);
    const lockfile = readPathMatchers(findings, "pathClassification.lockfile", input["pathClassification"]["lockfile"]);
    if (generated !== undefined && test !== undefined && lockfile !== undefined) pathClassification = { generated, test, lockfile };
  } else if (input["pathClassification"] !== undefined) {
    findings.add("config_invalid_member", "pathClassification", "must be an object naming generated, test and lockfile matchers");
  }

  let sensitivePaths: readonly SensitivePathGroup[] | undefined;
  if (input["sensitivePaths"] !== undefined) {
    const array = readArray(findings, "sensitivePaths", input["sensitivePaths"]);
    if (array !== undefined) {
      const groups: SensitivePathGroup[] = [];
      let sound = true;
      array.forEach((entry, index) => {
        const at = `sensitivePaths[${index}]`;
        if (!isRecord(entry)) {
          findings.add("config_invalid_member", at, "must be an object naming an id and its patterns");
          sound = false;
          return;
        }
        checkClosed(findings, at, entry, ["id", "patterns"]);
        const id = readString(findings, `${at}.id`, entry["id"], { pattern: ID_PATTERN, describe: "a sensitive-path group id" });
        const patterns = readPathMatchers(findings, `${at}.patterns`, entry["patterns"]);
        if (id === undefined || patterns === undefined) sound = false;
        else groups.push({ id, patterns });
      });
      if (sound) sensitivePaths = groups;
    }
  }

  let activationThreshold: number | undefined;
  if (input["activationThreshold"] !== undefined) {
    const value = input["activationThreshold"];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) activationThreshold = value;
    else findings.add("config_invalid_member", "activationThreshold", "must be a non-negative integer line count");
  }

  let providers: readonly ProviderRegistration[] | undefined;
  if (input["providers"] !== undefined) {
    const array = readArray(findings, "providers", input["providers"]);
    if (array !== undefined) {
      const registrations: ProviderRegistration[] = [];
      let sound = true;
      array.forEach((entry, index) => {
        const at = `providers[${index}]`;
        if (!isRecord(entry)) {
          findings.add("config_invalid_member", at, "must be an object naming a provider id and its finding codes");
          sound = false;
          return;
        }
        checkClosed(findings, at, entry, ["id", "findingCodes", "command", "check"]);
        const id = readString(findings, `${at}.id`, entry["id"], { pattern: ID_PATTERN, describe: "a provider id" });
        const findingCodes = readStringArray(findings, `${at}.findingCodes`, entry["findingCodes"], {
          pattern: FINDING_CODE_PATTERN,
          describe: "a finding code",
        });
        let command: NonEmptyTuple<string> | undefined;
        if (entry["command"] !== undefined) {
          const values = readStringArray(findings, `${at}.command`, entry["command"], { describe: "a provider command argument" });
          if (values === undefined || values.length === 0 || values.some((value) => value.length === 0)) {
            if (values !== undefined) findings.add("config_invalid_member", `${at}.command`, "must be a non-empty argv array of non-empty strings");
            sound = false;
          } else {
            command = values as NonEmptyTuple<string>;
          }
        }
        let check: ProviderRegistration["check"];
        if (entry["check"] !== undefined) {
          const value = entry["check"];
          if (!isRecord(value)) { findings.add("config_invalid_member", `${at}.check`, "must be an object"); sound = false; }
          else {
            checkClosed(findings, `${at}.check`, value, ["command", "timeoutMs", "outputs", "scope", "installedData"]);
            const argv = value["command"], timeout = value["timeoutMs"], outputs = value["outputs"];
            if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string" || argv[0].trim().length === 0 || argv.some(v => typeof v !== "string" || v.includes("\0")) ||
                typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000 ||
                (outputs !== undefined && (!Array.isArray(outputs) || outputs.length > 64 || new Set(outputs).size !== outputs.length || outputs.some(v => typeof v !== "string" || v.length === 0 || v.startsWith("/") || v.includes("\\") || v.split("/").some((part: string) => part === ".." || part === "." || part === ""))))) {
              findings.add("config_invalid_member", `${at}.check`, "requires non-empty argv, timeoutMs from 1 to 3600000 and at most 64 unique safe relative output paths"); sound = false;
            } else check = { command: argv as unknown as NonEmptyTuple<string>, timeoutMs: timeout, ...(outputs === undefined ? {} : { outputs: outputs as string[] }) };
            if (value["scope"] !== undefined) {
              if (!isScopedCheckDefinition(value["scope"])) { findings.add("config_invalid_member", `${at}.check.scope`, "requires the supported scoped-check/1 contract"); sound = false; }
              else if (check !== undefined) check = { ...check, scope: value["scope"] };
            }
            if (value["installedData"] !== undefined) {
              const resource = value["installedData"];
              if (!isInstalledDataConsumerDefinition(resource) || !check?.scope || resource.source.profile !== check.scope.profile || resource.source.cwd !== check.scope.cwd || digestCanonical(resource.source.environment) !== digestCanonical(check.scope.environment)) {
                findings.add("config_invalid_member", `${at}.check.installedData`, "requires a guarded installed-data consumer matching the actual scoped execution context"); sound = false;
              } else check = { ...check, installedData: resource };
            }
            if (command !== undefined) { findings.add("config_invalid_member", at, "command and check are mutually exclusive"); sound = false; }
          }
        }
        if (id === undefined || findingCodes === undefined) sound = false;
        else registrations.push({ id, findingCodes, ...(command === undefined ? {} : { command }), ...(check === undefined ? {} : { check }) });
      });
      if (sound) providers = registrations;
    }
  }

  const agentEnvSignals =
    input["agentEnvSignals"] === undefined
      ? undefined
      : readStringArray(findings, "agentEnvSignals", input["agentEnvSignals"], { pattern: ENV_VARIABLE_PATTERN, describe: "an environment variable name" });

  let ciPolicies: readonly CiPolicy[] | undefined;
  if (input["ciPolicies"] !== undefined) {
    const array = readArray(findings, "ciPolicies", input["ciPolicies"]);
    if (array !== undefined) {
      const policies: CiPolicy[] = [];
      let sound = true;
      array.forEach((entry, index) => {
        const at = `ciPolicies[${index}]`;
        if (!isRecord(entry)) {
          findings.add("config_invalid_member", at, "must be an object naming a policy id and its required environment");
          sound = false;
          return;
        }
        checkClosed(findings, at, entry, ["id", "requiredEnv"]);
        const id = readString(findings, `${at}.id`, entry["id"], { pattern: ID_PATTERN, describe: "a CI policy id" });
        const requiredArray = readArray(findings, `${at}.requiredEnv`, entry["requiredEnv"]);
        const requirements: EnvironmentRequirement[] = [];
        let requirementsSound = requiredArray !== undefined;
        requiredArray?.forEach((requirement, requirementIndex) => {
          const requirementAt = `${at}.requiredEnv[${requirementIndex}]`;
          if (!isRecord(requirement)) {
            findings.add("config_invalid_member", requirementAt, "must be an object naming a variable and the value it must equal");
            requirementsSound = false;
            return;
          }
          checkClosed(findings, requirementAt, requirement, ["variable", "equals"]);
          const variable = readString(findings, `${requirementAt}.variable`, requirement["variable"], {
            pattern: ENV_VARIABLE_PATTERN,
            describe: "an environment variable name",
          });
          const equals = readString(findings, `${requirementAt}.equals`, requirement["equals"], { describe: "the value the variable must equal" });
          if (variable === undefined || equals === undefined) requirementsSound = false;
          else requirements.push({ variable, equals });
        });
        if (id === undefined || !requirementsSound) sound = false;
        else policies.push({ id, requiredEnv: requirements });
      });
      if (sound) ciPolicies = policies;
    }
  }

  const ciPolicyEnvKey =
    input["ciPolicyEnvKey"] === undefined
      ? undefined
      : readString(findings, "ciPolicyEnvKey", input["ciPolicyEnvKey"], { pattern: ENV_VARIABLE_PATTERN, describe: "an environment variable name" });
  const preparationWiringPaths =
    input["preparationWiringPaths"] === undefined
      ? undefined
      : readStringArray(findings, "preparationWiringPaths", input["preparationWiringPaths"], { path: true, describe: "a repo-relative path" });
  if (preparationWiringPaths !== undefined) checkDuplicateIds(findings, "preparationWiringPaths", preparationWiringPaths);
  const additionalReviewLenses = input["additionalReviewLenses"] === undefined ? undefined : readAdditionalReviewLenses(findings, input["additionalReviewLenses"]);

  const scopedExecution = input["scopedExecution"];
  if (scopedExecution !== undefined && !isScopedExecution(scopedExecution)) findings.add("config_invalid_member", "scopedExecution", "requires the supported scoped-execution/1 profiles");
  if (isScopedExecution(scopedExecution)) {
    for (const provider of providers ?? []) {
      if (provider.check?.scope && !scopedExecution.profiles.some(p => p.id === provider.check!.scope!.profile)) findings.add("config_invalid_member", "scopedExecution.profiles", "every scoped check requires its declared execution profile");
    }
    if (scopedExecution.mechanicalProviders.some(id => !providers?.some(p => p.id === id && p.check?.scope))) findings.add("config_invalid_member", "scopedExecution.mechanicalProviders", "mechanical providers must name scoped check providers");
  }

  let preparationCommands: PreparationCommand[] | undefined;
  if (input["preparationCommands"] !== undefined) {
    const entries = readArray(findings, "preparationCommands", input["preparationCommands"]);
    preparationCommands = [];
    const ids = new Set<string>();
    entries?.forEach((entry, index) => {
      const at = `preparationCommands[${index}]`;
      if (!isRecord(entry)) {
        findings.add("config_invalid_member", at, "must be a command object");
        return;
      }
      checkClosed(findings, at, entry, ["id", "command", "timeoutMs"]);
      const id = readString(findings, `${at}.id`, entry["id"], { pattern: REMEDIATION_ID_PATTERN, describe: "a kebab-case check id" });
      const command = entry["command"];
      const timeoutMs = entry["timeoutMs"];
      if (!Array.isArray(command) || command.length === 0 ||
          command.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
          typeof command[0] !== "string" || command[0].trim().length === 0) {
        findings.add("config_invalid_member", `${at}.command`, "must be a non-empty argv array with a nonblank executable and no NUL bytes");
        return;
      }
      if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
        findings.add("config_invalid_member", `${at}.timeoutMs`, "must be a positive integer no greater than 2147483647");
        return;
      }
      if (id === undefined) return;
      if (ids.has(id)) {
        findings.add("config_invalid_member", `${at}.id`, "must be unique among preparation commands");
        return;
      }
      ids.add(id);
      preparationCommands!.push({ id, command: command as [string, ...string[]], timeoutMs });
    });
  }

  let obligations: readonly ObligationPolicy[] | undefined;
  if (input["obligations"] !== undefined) {
    const array = readArray(findings, "obligations", input["obligations"]);
    if (array !== undefined) {
      const read = array.map((entry, index) => readObligation(findings, `obligations[${index}]`, entry));
      if (read.every((entry): entry is ObligationPolicy => entry !== undefined)) obligations = read;
    }
  }

  const resourceProviders = (providers ?? []).filter(provider => provider.check?.installedData);
  if (resourceProviders.length > 1) findings.add("config_invalid_member", "providers", "installed data v1 supports one resource provider and setup");
  for (const provider of resourceProviders) {
    if (!isScopedExecution(scopedExecution) || scopedExecution.mechanicalProviders.includes(provider.id)) findings.add("config_invalid_member", "scopedExecution", "installed data requires a configured non-mechanical resource provider");

  }

  const deliveryRecordPath =
    input["deliveryRecordPath"] === undefined
      ? undefined
      : readString(findings, "deliveryRecordPath", input["deliveryRecordPath"], { path: true, describe: "a repo-relative path" });

  let deliveryRecordVerification: DeliveryRecordVerification | undefined = { baseMovement: DEFAULT_BASE_MOVEMENT_POLICY };
  if (input["deliveryRecordVerification"] !== undefined) {
    deliveryRecordVerification = undefined;
    if (isRecord(input["deliveryRecordVerification"])) {
      checkClosed(findings, "deliveryRecordVerification", input["deliveryRecordVerification"], ["baseMovement"]);
      const baseMovement = readEnum(
        findings,
        "deliveryRecordVerification.baseMovement",
        input["deliveryRecordVerification"]["baseMovement"],
        BASE_MOVEMENT_POLICIES,
      );
      if (baseMovement !== undefined) deliveryRecordVerification = { baseMovement };
    } else {
      findings.add("config_invalid_member", "deliveryRecordVerification", "must be an object naming a base-movement policy");
    }
  }

  if (
    gateId === undefined ||
    baseRef === undefined ||
    storageNamespace === undefined ||
    acceptedEnvelopeSpecs === undefined ||
    identityVersions === undefined ||
    computingIdentityVersion === undefined ||
    reviewNeutral === undefined ||
    recordNeutral === undefined ||
    pathClassification === undefined ||
    sensitivePaths === undefined ||
    activationThreshold === undefined ||
    providers === undefined ||
    agentEnvSignals === undefined ||
    ciPolicies === undefined ||
    ciPolicyEnvKey === undefined ||
    preparationWiringPaths === undefined ||
    obligations === undefined ||
    deliveryRecordPath === undefined ||
    deliveryRecordVerification === undefined
  ) {
    return undefined;
  }

  return {
    gateId,
    baseRef,
    storageNamespace,
    acceptedEnvelopeSpecs,
    identityVersions,
    computingIdentityVersion,
    reviewNeutral,
    recordNeutral,
    pathClassification,
    sensitivePaths,
    activationThreshold,
    providers,
    agentEnvSignals,
    ciPolicies,
    ciPolicyEnvKey,
    preparationWiringPaths: additionalReviewLenses === undefined ? preparationWiringPaths :
      [...new Set([...preparationWiringPaths, ...additionalReviewLenses.map((lens) => lens.charterPath)])],
    ...(additionalReviewLenses === undefined ? {} : { additionalReviewLenses }),
    ...(preparationCommands === undefined ? {} : { preparationCommands }),
    ...(isScopedExecution(scopedExecution) ? { scopedExecution } : {}),
    obligations,
    deliveryRecordPath,
    deliveryRecordVerification,
  };
}

// ── Neutral-set helpers ────────────────────────────────────────────────────

/**
 * The one place a neutral matcher is interpreted. The identity computation reads
 * this rather than reimplementing it, so the predicate the loader checks the
 * delivery-record path against is the predicate that decides what leaves the
 * digest — a second implementation is a second answer waiting to happen.
 */
export function matchesNeutralSet(matchers: readonly NeutralMatcher[], path: string): boolean {
  return matchers.some((matcher) => path.startsWith(matcher.prefix) && (matcher.suffix === undefined || path.endsWith(matcher.suffix)));
}

/**
 * The candidate-keyed delivery-record path: `deliveryRecordPath` with the
 * deliverable digest spliced in before its extension.
 *
 * WHY THIS LIVES IN CONFIG AND NOT BESIDE THE RECORD. The derived path is what
 * actually gets written, so it — not the configured path — is what has to be
 * neutral to both predicates. The loader must therefore be able to check it, and
 * the loader cannot import the delivery-record module (it is d2; this file is
 * d1). The derivation is pure string work over a member this file already owns,
 * so it belongs here and the record module consumes it from here. One
 * derivation, one place, checked at load time.
 *
 * THE DOT AT POSITION ZERO IS NOT AN EXTENSION. `.deliveryrecord` is a dotfile
 * whose whole basename is its name; reading the leading dot as an extension
 * separator would leave an empty stem and splice the digest into a file named
 * `--<digest>.deliveryrecord` — a different basename in a different directory
 * than the operator configured. Only a dot *after* the first character of the
 * basename separates an extension.
 */
export function deriveDeliveryRecordPath(deliveryRecordPath: string, deliverableDigest: string): string {
  const lastSlash = deliveryRecordPath.lastIndexOf("/");
  const lastDot = deliveryRecordPath.lastIndexOf(".");
  // `lastDot > lastSlash + 1` rather than `> lastSlash`: the extra character is
  // the basename's first, which a dot may not occupy and still be a separator.
  const hasExtension = lastDot > lastSlash + 1;
  const stem = hasExtension ? deliveryRecordPath.slice(0, lastDot) : deliveryRecordPath;
  const extension = hasExtension ? deliveryRecordPath.slice(lastDot) : "";
  return `${stem}--${deliverableDigest}${extension}`;
}

/** {@link deriveDeliveryRecordPath} over a loaded config's own record path. */
export function deliveryRecordPathFor(config: HarnessConfig, deliverableDigest: string): string {
  return deriveDeliveryRecordPath(config.deliveryRecordPath, deliverableDigest);
}

/**
 * Digest-shaped probes for load-time validation, and why there are two of them.
 *
 * The splice *position* is digest-independent — every 64-hex digest lands in the
 * same place — so a matcher's prefix is decided identically under any probe. A
 * matcher's suffix is not. A suffix that reaches backwards past the extension
 * into the digest region asserts something about digest *characters*, and a
 * single probe answers that assertion only for itself: an all-zeros probe
 * satisfies exactly the suffixes made of zeros, so `record00.json` under suffix
 * `00.json` validates at load and then writes real records outside the neutral
 * set — the write moves the identity it attests, `verify` reports the record
 * missing, and the loop cannot be closed.
 *
 * Two probes differing in *every* position close that: a suffix reaching k > 0
 * characters into the digest region would have to be simultaneously `0` and `f`
 * at the same offset, which no string is. So a suffix survives both probes only
 * by staying entirely outside the digest region — which is exactly the property
 * that makes it digest-independent, and therefore true for every real candidate.
 */
const PROBE_DIGESTS: readonly string[] = ["0".repeat(64), "f".repeat(64)];

/**
 * Whether every path `narrow` matches is also matched by `wide`. Conservative on
 * purpose: a narrow matcher with no suffix under a wide matcher that has one
 * matches strictly more, so it is not subsumed even though most concrete paths
 * would satisfy both.
 */
function subsumes(wide: NeutralMatcher, narrow: NeutralMatcher): boolean {
  if (!narrow.prefix.startsWith(wide.prefix)) return false;
  return wide.suffix === undefined || narrow.suffix === wide.suffix;
}

/**
 * Two matchers are the same matcher when both halves agree. The separator is a
 * NUL because no path part can contain one, so `{prefix: "a/b", suffix: "c"}`
 * and `{prefix: "a/b\u0000c"}` cannot collide into one key.
 */
function matcherKey(matcher: NeutralMatcher): string {
  return `${matcher.prefix}\u0000${matcher.suffix ?? ""}`;
}

function sameMatcherSet(left: readonly NeutralMatcher[], right: readonly NeutralMatcher[]): boolean {
  const leftKeys = new Set(left.map(matcherKey));
  const rightKeys = new Set(right.map(matcherKey));
  if (leftKeys.size !== rightKeys.size) return false;
  for (const key of leftKeys) if (!rightKeys.has(key)) return false;
  return true;
}

// ── The emittable code universe ────────────────────────────────────────────

/**
 * Every finding code the named obligation can be blocked by: the gate's own
 * structural codes plus the codes declared by the providers *this obligation*
 * registers. An obligation that drops a provider drops that provider's codes,
 * which is what makes a leftover classification a stale entry rather than a
 * harmless extra.
 */
export function emittableFindingCodes(config: HarnessConfig, obligationId: string): readonly string[] {
  const obligation = config.obligations.find((candidate) => candidate.id === obligationId);
  if (obligation === undefined) {
    // Answering with the structural set would make a typo look like a policy: a
    // caller partitioning against it would classify exactly the right number of
    // codes for entirely the wrong obligation, and nothing downstream could
    // tell the difference.
    throw new Error(`No obligation ${JSON.stringify(obligationId)} is declared by this config.`);
  }
  const codes = new Set<string>(GATE_STRUCTURAL_FINDING_CODES);
  for (const providerId of obligation.providers) {
    const provider = config.providers.find((registration) => registration.id === providerId);
    for (const code of provider?.findingCodes ?? []) codes.add(code);
  }
  return [...codes];
}

// ── Cross-member invariants ────────────────────────────────────────────────

function checkDuplicateIds(findings: FindingList, member: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) findings.add("config_duplicate_id", member, `declares ${JSON.stringify(id)} more than once`);
    seen.add(id);
  }
}

function checkInvariants(findings: FindingList, config: HarnessConfig): void {
  // Unique ids, everywhere ids are declared.
  checkDuplicateIds(findings, "obligations", config.obligations.map((obligation) => obligation.id));
  checkDuplicateIds(findings, "providers", config.providers.map((provider) => provider.id));
  checkDuplicateIds(findings, "ciPolicies", config.ciPolicies.map((policy) => policy.id));
  checkDuplicateIds(findings, "sensitivePaths", config.sensitivePaths.map((group) => group.id));

  for (const member of ["acceptedEnvelopeSpecs", "identityVersions", "agentEnvSignals"] as const) {
    checkDuplicateIds(findings, member, config[member]);
  }
  for (const [index, provider] of config.providers.entries()) {
    const member = `providers[${index}].findingCodes`;
    checkDuplicateIds(findings, member, provider.findingCodes);
    for (const code of provider.findingCodes) {
      if ((GATE_STRUCTURAL_FINDING_CODES as readonly string[]).includes(code)) {
        findings.add("config_code_collision", member, `${JSON.stringify(code)} is reserved by the structural finding registry`);
      }
    }
  }

  // A gate with no obligations admits everything, which is the one outcome this
  // harness exists to make impossible.
  if (config.obligations.length === 0) {
    findings.add("config_no_obligations", "obligations", "must declare at least one obligation; a gate with none admits every candidate");
  }

  const providerIds = new Set(config.providers.map((provider) => provider.id));
  const policyIds = new Set(config.ciPolicies.map((policy) => policy.id));
  const sensitiveGroupIds = new Set(config.sensitivePaths.map((group) => group.id));

  for (const [index, obligation] of config.obligations.entries()) {
    const at = `obligations[${index}]`;

    for (const providerId of obligation.providers) {
      if (!providerIds.has(providerId)) {
        findings.add("config_dangling_provider", `${at}.providers`, `names ${JSON.stringify(providerId)}, which no provider registration declares`);
      }
    }
    const checkProviders = obligation.providers.map(id => config.providers.find(provider => provider.id === id)).filter(provider => provider?.check !== undefined);
    const permitsApplicability = obligation.providers.length > 0 && obligation.providers.every(id => config.providers.find(provider => provider.id === id)?.check?.installedData !== undefined);
    if ((checkProviders.length > 0 && (obligation.freshness !== "exact_candidate" || new Set(obligation.acceptedPayloadSpecs).size !== obligation.acceptedPayloadSpecs.length || !obligation.acceptedPayloadSpecs.includes("checks.passed/1") || obligation.acceptedPayloadSpecs.some(spec => spec !== "checks.passed/1" && !(permitsApplicability && spec === "installed-data.applicable/1")))) ||
        (obligation.acceptedPayloadSpecs.includes("installed-data.applicable/1") && !permitsApplicability)) {
      findings.add("config_invalid_member", at, "declared checks require exact_candidate freshness, checks.passed fallback, and applicability only for opted-in installed-data consumers");
    }
    for (const groupId of obligation.activation.sensitiveGroupIds ?? []) {
      if (!sensitiveGroupIds.has(groupId)) {
        findings.add(
          "config_dangling_sensitive_group",
          `${at}.activation.sensitiveGroupIds`,
          `names ${JSON.stringify(groupId)}, which no sensitive-path group declares`,
        );
      }
    }
    for (const policyId of obligation.ciDelegationPolicyIds) {
      if (!policyIds.has(policyId)) {
        findings.add("config_dangling_ci_policy", `${at}.ciDelegationPolicyIds`, `names ${JSON.stringify(policyId)}, which no CI policy declares`);
      }
    }
    if (obligation.acceptedPayloadSpecs.length === 0) {
      findings.add(
        "config_no_payload_spec",
        `${at}.acceptedPayloadSpecs`,
        "accepts no payload spec, so no claim can ever bind to this obligation",
      );
    }
    checkDuplicateIds(findings, `${at}.acceptedPayloadSpecs`, obligation.acceptedPayloadSpecs);
    checkDuplicateIds(findings, `${at}.waivableCodes`, obligation.waivableCodes);
    checkDuplicateIds(findings, `${at}.nonWaivableCodes`, obligation.nonWaivableCodes);

    // The waiver flag and the resolution kinds are two statements of one policy.
    const waivedAllowed = obligation.allowedResolutionKinds.includes("waived");
    if (obligation.humanWaiverAllowed !== waivedAllowed) {
      findings.add(
        "config_waiver_policy_mismatch",
        at,
        obligation.humanWaiverAllowed
          ? "sets humanWaiverAllowed but omits \"waived\" from allowedResolutionKinds"
          : "allows the \"waived\" resolution kind but leaves humanWaiverAllowed false",
      );
    }

    // Only `self` is specified; enforcing a level whose profile does not exist
    // would be a promise the harness cannot keep.
    if (obligation.minimumAttestationLevel !== V1_ATTESTATION_LEVEL) {
      findings.add(
        "config_unsupported_attestation_level",
        `${at}.minimumAttestationLevel`,
        `must be "self" in this version: levels above self require a signing profile that this scope does not define`,
      );
    }

    // Remediation catalogs must actually carry guidance.
    if (obligation.remediation.default.length === 0) {
      findings.add("config_empty_remediation", `${at}.remediation.default`, "must carry at least one remediation");
    }
    for (const [code, catalog] of Object.entries(obligation.remediation.byCode ?? {})) {
      if (catalog.length === 0) {
        findings.add("config_empty_remediation", `${at}.remediation.byCode.${code}`, "must carry at least one remediation");
      }
    }

    // The exact three-way partition.
    const universe = new Set(emittableFindingCodes(config, obligation.id));
    const waivable = new Set(obligation.waivableCodes);
    const nonWaivable = new Set(obligation.nonWaivableCodes);
    for (const code of universe) {
      const inWaivable = waivable.has(code);
      const inNonWaivable = nonWaivable.has(code);
      if (inWaivable && inNonWaivable) {
        findings.add(
          "config_double_classified_finding_code",
          at,
          `classifies ${JSON.stringify(code)} as both waivable and non-waivable; the lists must partition, not overlap`,
        );
      } else if (!inWaivable && !inNonWaivable) {
        findings.add(
          "config_unclassified_finding_code",
          at,
          `emits ${JSON.stringify(code)} but classifies it as neither waivable nor non-waivable`,
        );
      }
    }
    for (const [listName, list] of [["waivableCodes", waivable], ["nonWaivableCodes", nonWaivable]] as const) {
      for (const code of list) {
        if (!universe.has(code)) {
          findings.add(
            "config_stale_finding_code",
            `${at}.${listName}`,
            `classifies ${JSON.stringify(code)}, which this obligation cannot emit; a classification left behind by a removed provider or structural code is a lie about the policy`,
          );
        }
      }
    }
    for (const code of Object.keys(obligation.remediation.byCode ?? {})) {
      if (!universe.has(code)) {
        findings.add(
          "config_stale_finding_code",
          `${at}.remediation.byCode.${code}`,
          "keys a remediation on a code this obligation cannot emit",
        );
      }
    }
  }

  // Record-neutrality is the stricter of the two predicates, so every
  // record-neutral matcher must already be review-neutral. Otherwise a path
  // could be excluded from records while still changing the deliverable digest.
  for (const [index, matcher] of config.recordNeutral.entries()) {
    if (!config.reviewNeutral.some((wide) => subsumes(wide, matcher))) {
      findings.add(
        "config_record_neutral_not_subset",
        `recordNeutral[${index}]`,
        `${JSON.stringify(matcher.prefix)} is not covered by any reviewNeutral matcher; recordNeutral must be a subset of reviewNeutral`,
      );
    }
  }

  // The delivery record is the one sanctioned crossing out of the git-private
  // store, so writing it must move neither predicate.
  //
  // BOTH THE CONFIGURED PATH AND THE PATH THAT IS ACTUALLY WRITTEN. Records are
  // candidate-keyed: the digest is spliced into the configured path, and it is
  // the *derived* path that lands in the tree. Checking only the configured one
  // accepts configs whose real writes escape — a matcher naming the file exactly
  // (`delivery/record.json`), a prefix+suffix pair pinning the basename, a
  // dotfile — each double-neutral as configured and neutral to nothing once the
  // digest is spliced in. Such a config authorizes a write that changes the very
  // identity the record attests, which is the deadlock the two neutral sets
  // exist to prevent.
  // The derived path is checked under two probes that differ in every position,
  // so a matcher can only pass by being neutral independently of the digest —
  // see PROBE_DIGESTS. One finding is emitted for the derived path however many
  // probes it fails: the defect is the matcher, not the probe that caught it.
  const derivedProbePaths = PROBE_DIGESTS.map((probe) => deriveDeliveryRecordPath(config.deliveryRecordPath, probe));
  const candidatePaths: readonly (readonly [string, string])[] = [
    ["deliveryRecordPath", config.deliveryRecordPath],
    ...derivedProbePaths.map((derived) => ["deliveryRecordPath (derived)", derived] as const),
  ];
  let derivedReported = false;
  for (const [member, candidatePath] of candidatePaths) {
    const isDerived = member !== "deliveryRecordPath";
    if (isDerived && derivedReported) continue;
    const reviewNeutralRecord = matchesNeutralSet(config.reviewNeutral, candidatePath);
    const recordNeutralRecord = matchesNeutralSet(config.recordNeutral, candidatePath);
    if (reviewNeutralRecord && recordNeutralRecord) continue;
    if (isDerived) derivedReported = true;
    const derivedNote = isDerived
      ? ` — records are candidate-keyed, so ${JSON.stringify(config.deliveryRecordPath)} is written as this path`
      : "";
    findings.add(
      "config_delivery_record_not_neutral",
      member,
      reviewNeutralRecord
        ? `${JSON.stringify(candidatePath)} is review-neutral but not record-neutral; writing the record would change what records bind to${derivedNote}`
        : recordNeutralRecord
          ? `${JSON.stringify(candidatePath)} is record-neutral but not review-neutral; writing the record would change the deliverable identity${derivedNote}`
          : `${JSON.stringify(candidatePath)} is neutral to neither set; writing the record would invalidate the evidence it records${derivedNote}`,
    );
  }

  // A recorder must accept the identity it computes.
  if (!config.identityVersions.includes(config.computingIdentityVersion)) {
    findings.add(
      "config_identity_version_not_accepted",
      "computingIdentityVersion",
      `${JSON.stringify(config.computingIdentityVersion)} is not in identityVersions; a recorder must accept the identity it computes`,
    );
  }

  // The identity token binds the neutral set, in both directions.
  const isV1NarrationSet = sameMatcherSet(config.reviewNeutral, DELIVERABLE_TREE_V1_NARRATION_SET);
  if (config.computingIdentityVersion === DELIVERABLE_TREE_V1 && !isV1NarrationSet) {
    findings.add(
      "config_identity_token_requires_v1_neutral_set",
      "computingIdentityVersion",
      `claims ${JSON.stringify(DELIVERABLE_TREE_V1)} while reviewNeutral is not that token's narration set; declare a consumer-owned identity token instead`,
    );
  }
  if (config.computingIdentityVersion !== DELIVERABLE_TREE_V1 && isV1NarrationSet) {
    findings.add(
      "config_v1_neutral_set_requires_v1_token",
      "computingIdentityVersion",
      `declares the ${JSON.stringify(DELIVERABLE_TREE_V1)} narration set under ${JSON.stringify(config.computingIdentityVersion)}; the same exclusions computed under two tokens fork one identity for no reason`,
    );
  }
}

// ── Entry points ───────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
  }
  return value;
}

/**
 * The source id a config finding is attributed to. The gate id when it is
 * readable — that is the thing the operator recognizes — and the config itself
 * when the gate id is exactly what is broken.
 */
function sourceIdFor(input: unknown): string {
  if (isRecord(input) && typeof input["gateId"] === "string" && ID_PATTERN.test(input["gateId"])) return input["gateId"];
  return "harness.config";
}

/**
 * Validates a candidate config and returns either the loaded config or every
 * finding at once.
 *
 * Shape and coherence are two passes, and the second runs only when the first is
 * clean. This is not laziness: a cross-member rule reading a half-parsed value
 * reports noise — a partition against a code list that failed to parse, a
 * neutrality check against a path that is not a string — and noise in a list of
 * config errors is worse than a shorter list, because the author cannot tell
 * which entries are real.
 */
export function validateHarnessConfig(input: unknown): HarnessConfigValidation {
  const findings = new FindingList();
  const shaped = readShape(findings, input);
  if (shaped !== undefined && findings.length === 0) {
    checkInvariants(findings, shaped);
    if (findings.length === 0) return { ok: true, config: deepFreeze(shaped) };
  }
  const sourceId = sourceIdFor(input);
  const blockers = findings.entries.map((finding) => toBlocker(finding, sourceId));
  if (blockers.length === 0) {
    // Unreachable by construction: `shaped` is undefined only when a finding was
    // recorded. Kept because a future edit to `readShape` must not be able to
    // turn a rejected config into a silently accepted one.
    return {
      ok: false,
      blockers: [
        toBlocker({ code: "config_invalid_member", member: "<config>", detail: "could not be loaded" }, sourceId),
      ],
    };
  }
  const [first, ...rest] = blockers;
  return { ok: false, blockers: [first as Blocker, ...rest] };
}

/**
 * The authoring entry point. Returns the loaded config, or throws a
 * `BlockedError` carrying every finding — config files are loaded at a command
 * boundary that renders blockers, so throwing keeps the happy path free of
 * result-unwrapping while losing none of the diagnostics.
 */
export function defineHarnessConfig(input: HarnessConfigInput): HarnessConfig {
  const result = validateHarnessConfig(input);
  if (result.ok) return result.config;
  throw new BlockedError(result.blockers, "The harness config is not valid.");
}
