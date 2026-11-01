/**
 * The manifest rejection-code registry — the vocabulary a submitted
 * `delivery-evidence/1` manifest can be rejected in.
 *
 * This is the spec's Appendix D registry restated as an exhaustive `Record`
 * witness: every code names the rules that produce it, so a code with no rule
 * and a rule with no code are both compile-time or test-time errors rather than
 * discoveries. Appendix D is the source; the tests beside this file check the
 * transcription in both directions.
 *
 * DISJOINT FROM THE GATE'S VOCABULARY. `blockers.ts` owns
 * `GATE_STRUCTURAL_FINDING_CODES` — what the *evaluator* concludes about
 * evidence it already has. These codes are what the *validator* concludes about
 * a submission it is being offered. The two vocabularies never mix, and nothing
 * here is a blocker code.
 *
 * WHERE THE LINE IS. Four codes are not this validator's to emit. The reason is
 * a scope boundary, not an inability: what they judge is the recorder's
 * surface — the run root it allocates (SUB-3), the record store it publishes
 * into (SUB-4), and the artifact bytes it reads through its fs port (ENV-10's
 * realpath clause, ENV-11). Byte-level artifact verification is the clearest
 * case: it is a filesystem operation over files at declared paths, and a digest
 * taken over whatever string map a caller assembled is a different operation
 * with a different meaning — running it here would report a verification that
 * never happened. The codes are registered anyway, because the registry is the
 * whole registry, and carry `emitter: "recorder"` so the split is a stated fact
 * with a test behind it. The conformance kit's five recorder-dependent vectors
 * are exactly the vectors whose expectations sit on that side of the line;
 * their coverage arrives with integration mode.
 */
import type { NonEmptyTuple } from "../blockers.ts";

// ── Version tokens ─────────────────────────────────────────────────────────

/**
 * The envelope spec this validator implements. Version strings are exact-match
 * domain-separation tokens (§10), single-sourced here so the docs, the kit
 * runner and the validator cannot drift apart.
 */
export const DELIVERY_EVIDENCE_1 = "delivery-evidence/1";

/** The original payload spec. Its expansion-only deferral rule is immutable. */
export const REVIEW_GREEN_1 = "review.green/1";

/** The payload spec that also admits tracked in-contract P2/P3 deferrals. */
export const REVIEW_GREEN_2 = "review.green/2";

/** Envelope specs the validator implements, whatever a config accepts (GEN-2). */
export const SUPPORTED_ENVELOPE_SPECS: readonly string[] = Object.freeze([DELIVERY_EVIDENCE_1]);

/** Payload specs the validator implements, whatever a config accepts (ENV-14). */
export const SUPPORTED_PAYLOAD_SPECS: readonly string[] = Object.freeze([REVIEW_GREEN_1, REVIEW_GREEN_2, "checks.passed/1", "installed-data.applicable/1"]);

/**
 * The one attestation level `delivery-evidence/1` fully specifies (§7). The
 * other two levels are defined but unimplementable until a signing profile
 * exists, so a validator that accepted them would be laundering level-`self`
 * evidence as something stronger (§11.4).
 */
export const CONFORMING_ATTESTATION_LEVEL = "self";

// ── Rules ──────────────────────────────────────────────────────────────────

/** Every rule id in spec §8 and §9.3, in spec order. */
export const MANIFEST_RULE_IDS = [
  "GEN-1",
  "GEN-2",
  "GEN-3",
  "GEN-4",
  "GEN-5",
  "ENV-1",
  "ENV-2",
  "ENV-3",
  "ENV-4",
  "ENV-5",
  "ENV-6",
  "ENV-7",
  "ENV-8",
  "ENV-9",
  "ENV-10",
  "ENV-11",
  "ENV-12",
  "ENV-13",
  "ENV-14",
  "SUB-1",
  "SUB-2",
  "SUB-3",
  "SUB-4",
  "SUB-5",
  "RG-1",
  "RG-2",
  "RG-3",
  "RG-4",
  "RG-5",
  "RG-6",
  "RG-7",
  "RG-8",
  "RG-9",
  "RG-10",
] as const;

export type ManifestRuleId = (typeof MANIFEST_RULE_IDS)[number];

/**
 * The rules that produce no code because they constrain the validator rather
 * than the manifest: atomicity (GEN-3), the time ban (GEN-5), and
 * all-violations reporting (SUB-5). They are observable in this
 * implementation — GEN-3 through the single all-or-nothing result, GEN-5
 * through the sensor's time ban and the digest test, SUB-5 through every
 * multi-code vector — but no manifest can violate them.
 */
export const META_RULE_IDS: readonly ManifestRuleId[] = Object.freeze(["GEN-3", "GEN-5", "SUB-5"]);

// ── Codes ──────────────────────────────────────────────────────────────────

/** Appendix D, in registry order. */
export const MANIFEST_REJECTION_CODES = [
  "unknown_member",
  "unsupported_envelope_spec",
  "malformed_field",
  "invalid_provider_id",
  "unregistered_provider",
  "invalid_run_id",
  "invalid_pass_id",
  "unsupported_vcs",
  "invalid_object_id",
  "unsupported_identity_version",
  "repository_required",
  "run_history_final_mismatch",
  "artifact_path_invalid",
  "artifact_path_duplicate",
  "artifact_outside_run_root",
  "artifact_digest_mismatch",
  "unsupported_attestation",
  "no_claims",
  "duplicate_claim",
  "obligation_not_configured",
  "unsupported_payload_spec",
  "candidate_mismatch",
  "candidate_unprepared",
  "manifest_outside_run_root",
  "record_conflict",
  "verdict_not_green",
  "not_finalized",
  "edited_after_final_pass",
  "reviewer_set_invalid",
  "reviewer_set_incomplete",
  "approval_missing",
  "approval_mismatch",
  "finding_invalid",
  "blocking_finding_present",
  "actionable_unresolved",
  "illegal_deferral",
  "telemetry_mismatch",
  "iteration_count_mismatch",
  "invalid_cost",
] as const;

export type ManifestRejectionCode = (typeof MANIFEST_REJECTION_CODES)[number];

/**
 * `validator` — decidable from the manifest, the repository configuration, and
 * the candidate observation the caller supplies.
 *
 * `recorder` — owned by the recorder's surface: the run root it allocates, the
 * records it publishes, and the artifact bytes it reads and hashes through its
 * fs port. A pure validator can be handed values that resemble those things,
 * which is exactly why it must not answer in their name: a caller would then
 * hold a verification nobody performed.
 */
export type RejectionEmitter = "validator" | "recorder";

export interface ManifestRejectionCodeEntry {
  readonly rules: NonEmptyTuple<ManifestRuleId>;
  readonly emitter: RejectionEmitter;
}

/**
 * Exhaustive by construction: the key type is the code union, so a code added
 * to the list above without an entry here fails to compile.
 */
export const MANIFEST_REJECTION_REGISTRY: Readonly<Record<ManifestRejectionCode, ManifestRejectionCodeEntry>> = Object.freeze({
  unknown_member: { rules: ["GEN-1"], emitter: "validator" },
  unsupported_envelope_spec: { rules: ["GEN-2"], emitter: "validator" },
  malformed_field: { rules: ["GEN-4", "ENV-7"], emitter: "validator" },
  invalid_provider_id: { rules: ["ENV-1"], emitter: "validator" },
  unregistered_provider: { rules: ["ENV-1"], emitter: "validator" },
  invalid_run_id: { rules: ["ENV-2"], emitter: "validator" },
  invalid_pass_id: { rules: ["ENV-3"], emitter: "validator" },
  unsupported_vcs: { rules: ["ENV-4"], emitter: "validator" },
  invalid_object_id: { rules: ["ENV-5"], emitter: "validator" },
  unsupported_identity_version: { rules: ["ENV-6"], emitter: "validator" },
  repository_required: { rules: ["ENV-8"], emitter: "validator" },
  run_history_final_mismatch: { rules: ["ENV-9"], emitter: "validator" },
  artifact_path_invalid: { rules: ["ENV-10"], emitter: "validator" },
  artifact_path_duplicate: { rules: ["ENV-10"], emitter: "validator" },
  artifact_outside_run_root: { rules: ["ENV-10"], emitter: "recorder" },
  artifact_digest_mismatch: { rules: ["ENV-11"], emitter: "recorder" },
  unsupported_attestation: { rules: ["ENV-12", "ENV-13"], emitter: "validator" },
  no_claims: { rules: ["ENV-14"], emitter: "validator" },
  duplicate_claim: { rules: ["ENV-14"], emitter: "validator" },
  obligation_not_configured: { rules: ["ENV-14"], emitter: "validator" },
  unsupported_payload_spec: { rules: ["ENV-14"], emitter: "validator" },
  candidate_mismatch: { rules: ["SUB-1"], emitter: "validator" },
  candidate_unprepared: { rules: ["SUB-2"], emitter: "validator" },
  manifest_outside_run_root: { rules: ["SUB-3"], emitter: "recorder" },
  record_conflict: { rules: ["SUB-4"], emitter: "recorder" },
  verdict_not_green: { rules: ["RG-1"], emitter: "validator" },
  not_finalized: { rules: ["RG-1"], emitter: "validator" },
  edited_after_final_pass: { rules: ["RG-1"], emitter: "validator" },
  reviewer_set_invalid: { rules: ["RG-2"], emitter: "validator" },
  reviewer_set_incomplete: { rules: ["RG-3"], emitter: "validator" },
  approval_missing: { rules: ["RG-4"], emitter: "validator" },
  approval_mismatch: { rules: ["RG-4"], emitter: "validator" },
  finding_invalid: { rules: ["RG-5"], emitter: "validator" },
  blocking_finding_present: { rules: ["RG-6"], emitter: "validator" },
  actionable_unresolved: { rules: ["RG-6"], emitter: "validator" },
  illegal_deferral: { rules: ["RG-7"], emitter: "validator" },
  telemetry_mismatch: { rules: ["RG-8"], emitter: "validator" },
  iteration_count_mismatch: { rules: ["RG-9"], emitter: "validator" },
  invalid_cost: { rules: ["RG-10"], emitter: "validator" },
});

/** Codes this unit's validator can produce. */
export const VALIDATOR_EMITTED_CODES: readonly ManifestRejectionCode[] = Object.freeze(
  MANIFEST_REJECTION_CODES.filter((code) => MANIFEST_REJECTION_REGISTRY[code].emitter === "validator"),
);

/** Codes only the recorder can reach, because only it observes the state they judge. */
export const RECORDER_EMITTED_CODES: readonly ManifestRejectionCode[] = Object.freeze(
  MANIFEST_REJECTION_CODES.filter((code) => MANIFEST_REJECTION_REGISTRY[code].emitter === "recorder"),
);

export function isManifestRejectionCode(value: unknown): value is ManifestRejectionCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MANIFEST_REJECTION_REGISTRY, value);
}

// ── Rejections ─────────────────────────────────────────────────────────────

/**
 * One violated rule. `pointer` is an RFC 6901 JSON pointer into the submitted
 * manifest, so a caller can show the offending member without the validator
 * formatting anything for a screen — that is the renderer's job, and the
 * messages here are constant strings that never interpolate provider-authored
 * text. A pointer can still carry a submitted member name (an unknown member is
 * named by the pointer to it), which is why display goes through the shared
 * renderer's neutralization (§11.2) like any other evidence text.
 */
export interface ManifestRejection {
  readonly code: ManifestRejectionCode;
  readonly rule: ManifestRuleId;
  readonly pointer: string;
  readonly message: string;
}

/**
 * Validation is atomic (GEN-3): one verdict for the whole submission, carrying
 * every violated rule (SUB-5). There is no partial acceptance and no
 * first-failure short circuit.
 */
export type ManifestValidation<T> =
  | { readonly ok: true; readonly manifest: T }
  | { readonly ok: false; readonly rejections: NonEmptyTuple<ManifestRejection> };
