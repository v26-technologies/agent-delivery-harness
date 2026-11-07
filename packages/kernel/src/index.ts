/**
 * Delivery harness kernel.
 *
 * The kernel's modules — canonical.ts, digest.ts, config.ts, blockers.ts,
 * candidate.ts, identity.ts, records.ts, validator/, evaluator.ts, context.ts,
 * recorder.ts, admission.ts, delivery-record.ts — land incrementally. The purity
 * sensor already registers the not-yet-created paths as pending, so the change
 * that creates one has to promote it to an enforced protected class.
 */

export const PACKAGE_NAME = "@agent-delivery-harness/kernel";

// RFC 8785 canonical JSON and the digest helpers built on it.
export {
  CanonicalizationError,
  canonicalBytes,
  canonicalize,
  compareUtf16CodeUnits,
  type CanonicalErrorCode,
} from "./canonical.ts";
export {
  DigestError,
  assertSha256Hex,
  digestCanonical,
  digestsEqual,
  isSha256Hex,
  manifestDigest,
  sha256Hex,
  type DigestErrorCode,
} from "./digest.ts";

// The failure vocabulary: typed blockers, the gate's structural finding-code
// registry, and the one total renderer.
export * from "./blockers.ts";

// The injected policy surface: the config schema, its load-time invariants, and
// the neutral-matcher primitive the identity computation shares with it.
export * from "./config.ts";
export { capturePhysicalSource } from "./physical-source.ts";

// The posture a repository declares on its protected base. A repository that
// chooses its own checks by posture calls this.
export {
  DELIVERY_POSTURE_FALLBACK_SOURCE,
  DELIVERY_POSTURE_MAX_BYTES,
  DELIVERY_POSTURE_NETWORK_TIMEOUT_MS,
  DELIVERY_POSTURE_PATH,
  DELIVERY_POSTURE_SCHEMA,
  resolveDeliveryPosture,
  type DeliveryPosture,
  type DeliveryPostureCode,
  type DeliveryPostureResult,
  type ResolveDeliveryPostureInput,
} from "./delivery-posture.ts";

// The git-private evidence record store, and the fs-free shapes pure modules
// read it through. The store owns the storage-dir resolver — records and
// preparation receipts are two leaves of one workspace namespace.
export {
  RECORDS_LEAF,
  RECORD_SCHEMA_VERSION,
  computeRecordId,
  discoverRecords,
  publishRecord,
  recordFileName,
  recordIdentity,
  resolveRecordStorage,
  type GitRunner,
  type PublishOptions,
  type RecordSelector,
  type RecordStorageOptions,
} from "./records.ts";
export type {
  EvidenceRecord,
  EvidenceRecordIdentity,
  EvidenceResolution,
  IgnoredStoreEntry,
  PublishRecordInput,
  PublishStatus,
  PublishedRecord,
  QuarantinedRecord,
  RecordCandidateBinding,
  RecordDiscovery,
  RecordIdentity,
  RecordQuarantineReason,
  RecordResolution,
  WaiverResolution,
  WaiverScope,
  WaiverRecordIdentity,
  WorkspaceStorage,
} from "./records.types.ts";
export { RECORD_QUARANTINE_REASONS, WAIVER_SCOPES } from "./records.types.ts";

// The normative manifest validator: the rejection-code registry, the
// delivery-evidence/1 envelope, and the review.green/1 payload. The published
// JSON Schemas sit beside them in validator/schemas/ and are cross-checked
// against this implementation rather than consulted by it.
export {
  CONFORMING_ATTESTATION_LEVEL,
  DELIVERY_EVIDENCE_1,
  MANIFEST_REJECTION_CODES,
  MANIFEST_REJECTION_REGISTRY,
  MANIFEST_RULE_IDS,
  META_RULE_IDS,
  RECORDER_EMITTED_CODES,
  REVIEW_GREEN_1,
  REVIEW_GREEN_2,
  SUPPORTED_ENVELOPE_SPECS,
  SUPPORTED_PAYLOAD_SPECS,
  VALIDATOR_EMITTED_CODES,
  isManifestRejectionCode,
  type ManifestRejection,
  type ManifestRejectionCode,
  type ManifestRejectionCodeEntry,
  type ManifestRuleId,
  type ManifestValidation,
  type RejectionEmitter,
} from "./validator/codes.ts";
export {
  validateManifest,
  type DeclaredArtifact,
  type DeliveryEvidenceManifest,
  type ManifestArtifact,
  type ManifestAttestation,
  type ManifestBase,
  type ManifestCandidate,
  type ManifestClaim,
  type ManifestDeliverable,
  type ManifestProvider,
  type ManifestValidationContext,
  type RunHistoryEntry,
} from "./validator/envelope.ts";
export {
  FINDING_DISPOSITIONS,
  FINDING_SCOPES,
  FINDING_SEVERITIES,
  REVIEWER_APPROVAL_ROLE,
  validateReviewGreenClaim,
  type ReviewGreenClaimInput,
} from "./validator/review-green.ts";

// The candidate: what is about to be reviewed. The shapes and every decision
// that can be made about a candidate without touching a repository come from
// `candidate.types.ts`; the git-bound capture and projection sit beside them.
export {
  CANDIDATE_CAPTURE_CODES,
  CANDIDATE_DIFF_UNREADABLE,
  CANDIDATE_DRIFT_CLASSES,
  CANDIDATE_MODES,
  CANDIDATE_PATH_CLASSES,
  CANDIDATE_VCS,
  classifyCandidateDrift,
  classifyCandidatePath,
  isObligationActive,
  matchesPathMatcher,
  projectReviewActivation,
  sensitiveGroupsFor,
  type CandidateBase,
  type CandidateBinding,
  type CandidateCapture,
  type CandidateCaptureCode,
  type CandidateDeliverable,
  type CandidateDiffEntry,
  type CandidateDriftClass,
  type CandidateMode,
  type CandidatePathClass,
  type CandidateStatusEntry,
  type CandidateVcs,
  type CaptureCandidate,
  type CapturedCandidate,
  type ComputeIdentity,
  type DeliverableIdentityRequest,
  type ReviewActivationProjection,
} from "./candidate.types.ts";
export {
  DEFAULT_CAPTURE_ATTEMPTS,
  captureGitCandidate,
  createCandidateCapture,
  evaluateCandidateActivation,
  parseCandidateNumstat,
  runGitCommand,
  type CandidateActivationOptions,
  type CandidateCaptureOptions,
  type CandidateCommandResult,
  type CandidateCommandRunner,
} from "./candidate.ts";

// The deliverable identity: the digest review evidence is bound to, and the two
// neutral predicates. Only `reviewNeutral` reaches the digest; `recordNeutral`
// is exported beside it so the difference is read in one place rather than
// re-derived. Byte-compatible with Athena's `deliverable-tree/v1` under that
// token's narration set, which the goldens corpus pins.
export {
  IDENTITY_DOMAIN,
  IDENTITY_FINDING_CODES,
  computeDeliverableIdentity,
  digestDeliverableEntries,
  identityDefinitionOf,
  isRecordNeutralPath,
  isReviewNeutralPath,
  parseTreeEntries,
  withDeliverableIdentity,
  type DeliverableIdentityDefinition,
  type DeliverableIdentityOptions,
  type DeliverableTreeEntry,
  type IdentityFindingCode,
} from "./identity.ts";

// Preparation receipts: the ordering mechanism the review context and the gate
// both consult before anything else.
export {
  HARNESS_VERSION,
  PREPARATION_FAILURE_CLASSES,
  PREPARATION_RECEIPT_LEAF,
  PREPARATION_RECEIPT_SCHEMA_VERSION,
  computePreparationFingerprint,
  evaluatePreparationReceipt,
  invalidatePreparationReceipt,
  revokePreparationAttempt,
  publishPreparationReceipt,
  receiptFileName,
  resolveReceiptStorage,
  type PreparationCandidate,
  type PreparationEvaluation,
  type PreparationFailureClass,
  type PreparationInput,
  type PreparationOptions,
  type PreparationReceipt,
  type PublishedPreparationReceipt,
} from "./preparation.ts";

// Who is running the gate, and what that entitles them to. The classifier reads
// a *given* environment snapshot rather than the ambient process, so a caller
// decides what the gate is allowed to see.
export {
  EXECUTION_CONTEXT_KINDS,
  UNKNOWN_CONTEXT_REASONS,
  classifyExecutionContext,
  isEnvSignalPresent,
  type AgentExecutionContext,
  type CiExecutionContext,
  type ClassifyExecutionContextInput,
  type EnvSnapshot,
  type ExecutionContext,
  type ExecutionContextKind,
  type HumanExecutionContext,
  type UnknownContextReason,
  type UnknownExecutionContext,
} from "./context.ts";

// The pure gate evaluator: six outcomes that never stand in for one another,
// freshness judged by deliverable identity, and the waiver's narrow door.
export {
  RESOLUTION_OUTCOMES,
  enforceAllowedResolution,
  evaluateGate,
  isRecordFreshForCandidate,
  type BlockedResolution,
  type DelegatedResolution,
  type EvaluateGateInput,
  type GateDecision,
  type LiveProviderFinding,
  type LiveProviderResult,
  type NotApplicableResolution,
  type ObligationFinding,
  type ObligationResolution,
  type ResolutionOutcome,
  type SatisfiedEvidenceResolution,
  type SatisfiedLiveFactResolution,
  type UnreadableRecordInput,
  type WaivedResolution,
} from "./evaluator.ts";

// The filesystem port. Run roots, containment, artifact observation and one
// atomic write — the only place the submission path opens a file, which is what
// makes the no-ad-hoc-fs rule over the recorder enforceable.
export {
  ARTIFACT_OBSERVATION_STATUSES,
  RUN_ROOT_LEAF,
  RUN_ROOT_NAMESPACE,
  RUN_ROOT_REFUSAL_REASONS,
  createArtifactsPort,
  defaultRunRootBase,
  isInsideResolved,
  isSafeRelativePath,
  type ArtifactObservation,
  type ArtifactObservationStatus,
  type ArtifactsPort,
  type ArtifactsPortOptions,
  type RunRoot,
  type RunRootRefusalReason,
  type RunRootRequest,
  type RunRootResolution,
  type WriteFileOptions,
} from "./artifacts.ts";

// The submission flow: spec §8.3 from a manifest on disk to published records.
export {
  SUBMISSION_CANDIDATE_FIELDS,
  compareSubmissionCandidate,
  submitManifest,
  type CandidateComparison,
  type SubmissionInput,
  type SubmissionOptions,
  type SubmissionOutcome,
  type SubmissionRecord,
} from "./recorder.ts";

// The effectful admission adapter: store + context + caller-supplied live
// results mapped into the pure evaluator, with the two-pass waiver evaluation.
export {
  INVOCATION_WAIVER_SCOPE,
  runAdmission,
  type AdmissionInput,
  type AdmissionOptions,
  type AdmissionResult,
  type WaiverPrompt,
  type WaiverApproval,
  type WaiverPromptOutcome,
} from "./admission.ts";

// The tracked delivery record (`delivery-record/1`): the produce-only projection
// the `record` command writes through the fs port, and the pure verification
// core the `verify` command and the GitHub Action share.
export {
  ATTESTATION_LABEL,
  CLAUDE_SKILL_EXPOSURE_PREFIX,
  DELIVERY_OWNED_TREE_PREFIXES,
  DELIVERY_RECORD_DRIFT_CLASSES,
  DELIVERY_RECORD_VERSION,
  RECEIPTED_SKILLS_ROOT,
  bindingOf,
  buildDeliveryRecord,
  deliveryRecordBytes,
  deliveryRecordPathFor,
  isDeliveryOwnedTreeEntry,
  isDeliveryOwnedTreePath,
  isDeliveryRecordRunSpan,
  needsCommittedSymlinkTarget,
  parseCandidateTreeListing,
  parseDeliveryRecord,
  selectDeliveryRecordForIdentity,
  verifyDeliveryRecord,
  type BuildDeliveryRecordInput,
  type BuildDeliveryRecordResult,
  type CandidateTreeEntry,
  type DeliveryRecord,
  type DeliveryRecordAttestation,
  type DeliveryRecordCheck,
  type DeliveryRecordClaim,
  type DeliveryRecordDriftClass,
  type DeliveryRecordFile,
  type DeliveryRecordHostedChecks,
  type DeliveryRecordRunSpan,
  type RecordedHostedCheckExemption,
  type ListedTreeEntry,
  type ParseDeliveryRecordResult,
  type RecomputedIdentity,
  type VerificationBase,
  type VerifyDeliveryRecordOptions,
} from "./delivery-record.ts";

// ── The managed-delivery contract spine ─────────────────────────────────────
//
// The frozen M0-critical contract families, the closed (journal, kind) event
// vocabulary with the intake/delivery state discriminators, and the pure
// journal reducers. The spine and the evidence kernel stay independent — the
// import-boundary sensor enforces both directions — and meet only here, at
// the package barrel.
export {
  DELIVERY_STATES,
  EVENT_VOCABULARY,
  HOST_ACTIVITY_STATES,
  INTAKE_STATES,
  JOURNALS,
  OBSERVATION_ONLY_KINDS,
  SUSPENDED_DELIVERY_STATES,
  TERMINAL_DELIVERY_STATES,
  classifyEventKind,
  type DeliveryState,
  type EventClassification,
  type EventKindEntry,
  type HostActivityState,
  type IntakeState,
  type Journal,
} from "./spine/vocabulary.ts";
export {
  ABSENT_BY_STATE,
  SPINE_GIT_OID,
  SPINE_ID,
  SPINE_INSTANT,
  SPINE_SHA256,
  type SpineRejection,
  type SpineRejectionCode,
  type SpineVerdict,
} from "./spine/grammar.ts";
export {
  PINNED_AGENT_SKILLS,
  PRODUCT_COMPOSITION_PIN_SPEC,
  PRODUCT_TRUST_LABEL,
  PRODUCT_TRUST_STATE_SPEC,
  localDigestTrustPredicate,
  validateCompositionPin,
  validateProductTrustState,
  type ProductTrustPort,
  type ProductTrustState,
  type TrustDecision,
} from "./spine/composition.ts";
export {
  CRITERION_DISPOSITIONS,
  EVIDENCE_KINDS,
  FINISH_LINES,
  OUTCOME_VERIFICATION_SPEC,
  REVIEW_VERDICTS,
  SCOPED_DELIVERY_CONTRACT_SPEC,
  checkContractWithinPolicy,
  checkOutcomeCoversContract,
  validateAcceptedContract,
  validateOutcomeVerification,
  type AcceptedContract,
  type OutcomeCriterion,
  type OutcomeVerification,
  type PolicyGrantView,
} from "./spine/contract.ts";
export {
  POLICY_SNAPSHOT_SPEC,
  REVIEW_LENS_CATEGORIES,
  validatePolicySnapshot,
  type PolicySnapshot,
} from "./spine/policy.ts";
export {
  INVOCATION_FENCE_SPEC,
  REVIEWER_ATTEMPT_SPEC,
  validateInvocationFence,
  validateReviewerAttempt,
} from "./spine/invocation.ts";
export {
  EXECUTION_GRANT_SPEC,
  GRANT_ATTESTATION_SPEC,
  GRANT_PROFILES,
  grantDigest,
  validateExecutionGrant,
  validateGrantAttestation,
  type GrantProfile,
} from "./spine/grant.ts";
export {
  CONFIRMATION_CLASSES,
  OPERATOR_CONFIRMATION_SPEC,
  confirmationClassOf,
  validateOperatorConfirmation,
  type ConfirmationClass,
} from "./spine/confirmation.ts";
export {
  CAPABILITY_DESCRIPTOR_SPEC,
  CAPABILITY_KINDS,
  SENSOR_OUTCOMES,
  SENSOR_RESULT_SPEC,
  validateCapabilityDescriptor,
  validateSensorResult,
} from "./spine/capability.ts";
// The trusted host-control binding's model-external admission decisions:
// deny-until-attested grant admission, the per-invocation interceptor, the
// isolated confirmation channel's echo challenge, and assertion-source
// degradation. Consumes the spine's grant/attestation contracts; never
// re-authors them.
export {
  ADMISSION_DENIAL_CODES,
  CONFIRMATION_DENIAL_CODES,
  CONFIRMATION_OPERATION_PREFIX,
  TOOL_DENIAL_CODES,
  assertionLaneAvailability,
  evaluateConfirmationEcho,
  evaluateHostAdmission,
  evaluateToolInvocation,
  type AdmissionDecision,
  type AdmissionDenial,
  type AdmissionDenialCode,
  type AdmissionExpectation,
  type AdmittedInvocation,
  type AssertionSourceAvailability,
  type CheckpointAdmissionExpectation,
  type ConfirmationDenial,
  type ConfirmationDenialCode,
  type ConfirmationEchoAttempt,
  type ConfirmationEchoDecision,
  type DeniedInvocation,
  type IntakeAdmissionExpectation,
  type LaneAvailability,
  type RenderedConfirmationChallenge,
  type ToolDenial,
  type ToolDenialCode,
  type ToolInvocationDecision,
  type ToolInvocationRequest,
} from "./binding/host-admission.ts";

// The host-integration conformance contract — the standing contract any
// future host qualifies against, plus the fake host that exercises it with no
// host at all.
export {
  HOST_ADMISSION_SCENARIOS,
  HOST_CONFORMANCE_CASES,
  HOST_INTERCEPTION_SCENARIOS,
  runHostIntegrationConformance,
  type HostAdmissionScenario,
  type HostConformanceCase,
  type HostConformanceResult,
  type HostIntegrationPort,
  type HostInterceptionScenario,
  type NormalizedAdmission,
  type NormalizedInterception,
  type NormalizedTeardown,
  type NormalizedTermination,
} from "./host/conformance.ts";
export { createFakeHostConformancePort } from "./host/fake-host.ts";
export {
  PROVIDER_REVIEW_HANDOFF_SPEC,
  PROVIDER_REVIEW_RESULT_SPEC,
  adaptClaudeCodeReviewResult,
  createProviderReviewHandoff,
  parseProviderReviewResult,
  type ClaudeCodeReviewAdaptation,
  type NativeReviewConclusion,
  type ProviderReviewCandidate,
  type ProviderReviewCapability,
  type ProviderReviewFinding,
  type ProviderReviewHandoff,
  type ProviderReviewHandoffReviewer,
  type ProviderReviewParseResult,
  type ProviderReviewResult,
  type ProviderReviewTerminalState,
  type ProviderReviewVerdict,
} from "./host/provider-review-result.ts";

export {
  EXTERNAL_ACTIONS,
  FINISH_LINE_RESULT_SPEC,
  checkMergeReadyAgainstOutcome,
  validateFinishLineResult,
  type ExternalAction,
  type FinishLineResult,
} from "./spine/finish-line.ts";
export {
  ACTION_APPROVALS,
  ACTION_VERIFICATIONS,
  APPROVAL_REQUEST_KINDS,
  CONTROL_PLANE_CLAIM_KINDS,
  CONTROL_PLANE_DISPOSITIONS,
  DESCENDANT_TEARDOWN_STATUSES,
  EXTERNAL_ACTION_OUTCOMES,
  JOURNAL_ENTRY_SPEC,
  RESUME_ELIGIBILITIES,
  TERMINATION_PROVENANCE_KINDS,
  WORKSPACE_DISPOSITIONS,
  validateJournalEntry,
} from "./spine/journal.ts";
export {
  DELIVERY_TRANSITION_TABLE,
  isDeliveryTransitionValid,
  isIntakeTransitionValid,
  reduceDeliveryJournal,
  reduceIntakeJournal,
  type DeliveryJournalState,
  type DeliveryTransitionRow,
  type IntakeJournalState,
  type ReduceDeliveryResult,
  type ReduceIntakeResult,
} from "./spine/reducer.ts";

// ── The local composition substrate ─────────────────────────────────────────
//
// The minimum composition manifest (nesting the frozen pin), the pure
// trust-store decisions (fail-closed parsing, the first-install
// discriminator, no-downgrade), and the local pack/install/activate path
// with the walking skeleton's canonical trust check sites behind the
// spine's ProductTrustPort.
export {
  COMPOSITION_MANIFEST_SPEC,
  COMPOSITION_PROFILES,
  CONFIRMATION_FIXTURE_PROFILE,
  SUPPORTED_CONTRACT_VERSIONS,
  buildCompositionManifest,
  compositionManifestBytes,
  generationDigestOf,
  validateCompositionManifest,
  type BuildCompositionManifestInput,
  type CompositionInventoryEntry,
  type CompositionProfile,
  type SubstrateRejection,
  type SubstrateRejectionCode,
  type SubstrateVerdict,
} from "./substrate/manifest.ts";
export {
  OTHER_INSTALLATION_ARTIFACTS,
  checkNoDowngrade,
  discriminateInstall,
  parseTrustState,
  type ArtifactPresence,
  type InstallDiscrimination,
  type InstallationPresence,
  type NoDowngradeDecision,
  type OtherInstallationArtifact,
  type ParseTrustStateResult,
} from "./substrate/trust-store.ts";
export {
  ACTIVE_POINTER_SPEC,
  COMPOSITION_MANIFEST_FILE,
  INSTALL_RECEIPT_SPEC,
  PACKED_HARNESS_PACKAGES,
  SUBSTRATE_BLOCKER_CODES,
  checkMutationLane,
  installComposition,
  loadPinnedGeneration,
  packComposition,
  receiptPathFor,
  registrationBinding,
  resolveActiveGeneration,
  trustStorePathFor,
  // The closure audit an adopter runs against an installation they did not
  // pack. It is reachable HERE because this entry is the package's only
  // published one: a verifier the installer offers and the package does not
  // export is a verifier no installed copy can call.
  verifyGenerationClosure,
  type InstallCompositionInput,
  type InstallCompositionResult,
  type InstallReceipt,
  type LoadPinnedGenerationResult,
  type MutationLaneResult,
  type PackCompositionInput,
  type PackCompositionResult,
  type RegistrationBindingInput,
  type RegistrationBindingResult,
  type ResolveActiveGenerationResult,
  type SubstrateBlocker,
  type SubstrateBlockerCode,
  type SubstrateFailure,
  type TrustCheckInput,
  type VerifiedClosure,
} from "./substrate/installer.ts";
export {
  ASSERTION_CLASSES,
  ASSERTION_SOURCES,
  SECURITY_BLOCKED_MIGRATION_ACTION,
  SENSITIVE_APPROVAL_ASSERTION_SPEC,
  SENSITIVE_MAINTENANCE_ACTIONS,
  assertionClassOf,
  validateSensitiveApprovalAssertion,
  type AssertionClass,
  type AssertionSource,
  type SensitiveMaintenanceAction,
} from "./spine/assertion.ts";
export {
  ASSERTION_PROVIDER_SPEC,
  assertionProviderConfigPathFor,
  createOsNativeAssertionSource,
  createQualificationFixtureAssertionSource,
  loadAssertionProviderConfig,
  writeAssertionProviderConfig,
  type AssertionEvaluation,
  type AssertionEvaluationRequest,
  type AssertionProviderConfig,
  type AssertionAvailabilityProbe,
  type AssertionSourcePort,
} from "./substrate/assertion-source.ts";
export {
  garbageCollectGenerations,
  inspectInstallation,
  maintainTrustState,
  recoverInterruptedMaintenance,
  repairInstallation,
  rollbackComposition,
  updateComposition,
  type GarbageCollectInput,
  type InspectInstallationInput,
  type InspectedGeneration,
  type MaintainTrustStateInput,
  type RepairInstallationInput,
  type RollbackCompositionInput,
  type SensitiveLaneInput,
  type UpdateCompositionInput,
  type UpdateCompositionResult,
} from "./substrate/lifecycle.ts";
export {
  MINIMUM_NODE,
  MINIMUM_PYTHON,
  SUPPORTED_PLATFORMS,
  livePreflightProbes,
  type PreflightProbes,
} from "./substrate/preflight.ts";

// ── The walking skeleton's V-slice modules ──────────────────────────────────
//
// The final module boundaries of the managed delivery product — policy,
// checkpoint, workflow, host binding, evidence, finish line, and the facade —
// at their narrowest production slice: one compiled adopter policy binding and
// stage grant, one append-only checkpoint path, the exact bundled workflow graph,
// the qualified Claude Code admission composition, the mandatory review
// floor, the merge-ready finish line, and one typed status/resume surface.
export {
  DISPOSABLE_OUTCOME_AUTHORITIES,
  DISPOSABLE_REVIEW_LENSES,
  DISPOSABLE_SENSOR_CAPABILITY,
  DISPOSABLE_STAGE_GRANT,
  MANDATORY_LENS_CATEGORIES,
  compileDisposableCompiledPolicy,
  compileDisposablePolicy,
  type CompileDisposablePolicyInput,
} from "./policy/disposable.ts";

// ── The policy compiler and adapter SDK ─────────────────────────────────────
//
// Layered repository policy: a declarative document plus executable adapter
// descriptors, compiled with the portable defaults into one digest-bound
// snapshot; the harness admission configuration is derived from it; and the
// separate monotonic authority-revocation epoch is the emergency ceiling.
export {
  ADAPTER_CAPABILITY_SPEC,
  OPERATION_CLAIM_SPEC,
  OPERATION_RESULT_SPEC,
  POLICY_CAPABILITY_KINDS,
  PRIVILEGED_ACTIONS,
  PRIVILEGED_CAPABILITY_KINDS,
  READ_ONLY_CAPABILITY_KINDS,
  checkClaimAuthorized,
  validateAdapterCapability,
  validateAdapterSet,
  type AdapterCapability,
  type ClaimAuthorityView,
  type PolicyCapabilityKind,
  type PolicyRejection,
  type PolicyVerdict,
} from "./policy/capabilities.ts";
export {
  APPROVAL_REQUIREMENTS,
  REPOSITORY_POLICY_DOCUMENT_SPEC,
  TRACKER_ABSENCE_FALLBACKS,
  validateRepositoryPolicyDocument,
  type CheckpointOverride,
  type RepositoryPolicyDocument,
  type HostedCheckExemptionScope,
  type HostedCheckExemption,
  type HostedChecksPolicy,
  isHostedCheckExemption,
  isHostedCheckInstant,
  isHostedChecksPolicy,
} from "./policy/document.ts";
export {
  COMPILED_POLICY_SPEC,
  POLICY_COMPILE_CODES,
  PORTABLE_MODEL_DRIVEN_STAGES,
  PORTABLE_PRIVILEGED_CREDENTIALS,
  PORTABLE_INTAKE_GRANT,
  PORTABLE_STAGE_GRANT,
  TRACKER_POSTURES,
  checkBoundPolicy,
  compileRepositoryPolicy,
  trackerPostureOf,
  verifyCompiledPolicy,
  effectiveHostedChecksPolicy,
  type CompiledCheckpointGrant,
  type CompiledPolicy,
  type CompileRepositoryPolicyInput,
  type AvailablePersona,
  type CompileRepositoryPolicyResult,
  type TrackerPosture,
} from "./policy/compile.ts";
export {
  ARCHIVE_RELEASE_MANIFEST_ENTRY,
  PERSONA_MANIFEST_ENTRY,
  PERSONA_MANIFEST_SPEC,
  projectShippedPersonas,
  type ProjectShippedPersonasResult,
  type ShippedPersonaRejection,
  type ShippedPersonaRejectionCode,
} from "./policy/shipped-personas.ts";
export {
  AUTHORITY_REVOCATION_SPEC,
  checkActionAuthorization,
  effectiveDeliveryAuthority,
  observeAuthorityEpoch,
  validateAuthorityRevocation,
  type AuthorityGrantView,
  type AuthorityRevocation,
  type CheckActionAuthorizationInput,
  type EffectiveDeliveryAuthorityInput,
  type ObserveAuthorityEpochResult,
} from "./policy/authority.ts";
export {
  createIntakeJournalStore,
  createJournalStore,
  createMaintenanceJournalStore,
  type IntakeJournalStore,
  type JournalAppendResult,
  type JournalReadResult,
  type JournalStore,
  type MaintenanceJournalStore,
} from "./checkpoint/journal-store.ts";
export { ProcessLockRefused, withProcessLock } from "./checkpoint/append-only-file.ts";
export {
  RECHECKED_VALUES,
  evaluateCanonicalRecheck,
  type CompareCheck,
  type EligibleCheck,
  type RecheckConsumption,
  type RecheckFailure,
  type RecheckResult,
  type RecheckValues,
  type RecheckedValue,
  type ValueCheck,
} from "./checkpoint/recheck.ts";
export {
  SECRET_PATTERNS,
  applySecretDiscipline,
  redactSecretText,
  type SecretDisciplineResult,
  type SecretPattern,
} from "./checkpoint/redaction.ts";
// The run surface: a separate `run-event/1` family with its own validator,
// store, and completeness evaluator. Observability, never evidence — nothing
// authoritative reads any of it.
export {
  MAX_RUN_LABEL,
  MAX_RUN_LENSES,
  MAX_RUN_PATH,
  MAX_RUN_PROVIDER_ID,
  MAX_RUN_URL,
  RUN_ACTOR_ROLES,
  RUN_CANDIDATE_TREE_SHA,
  RUN_COMMAND_OUTCOMES,
  RUN_ENDED_RESULTS,
  RUN_EVENT_KINDS,
  RUN_EVENT_PAYLOAD_GRAMMAR_SPEC,
  RUN_EVENT_SPEC,
  RUN_FREE_TEXT_MEMBERS,
  RUN_GATE_REPORTED_OUTCOMES,
  RUN_PROVIDER_ID,
  RUN_STORE_ID,
  RUN_TICKET,
  describeRunEventPayload,
  isRunEventKind,
  isRunInstant,
  reduceToProviderId,
  runPrimaryTicket,
  validateRunEvent,
  validateRunEventInput,
  type RunActorRole,
  type RunCommandOutcome,
  type RunPreparationObservation,
  type RunEvent,
  type RunEventActor,
  type RunEventInput,
  type RunEventKind,
  type RunEventPayloadGrammar,
  type RunEventPayloadMemberGrammar,
  type RunEventRepo,
  type RunEventValueGrammar,
  type RunEventValueType,
} from "./checkpoint/run-event.ts";
export {
  RUN_JOURNAL_REQUIRED_ENTRIES,
  RUN_JOURNAL_ROUND_BINDINGS,
  RUN_JOURNAL_STATUSES,
  RUN_JOURNAL_VIOLATIONS,
  evaluateRunJournal,
  explainRunJournal,
  runJournalCarries,
  type RunJournalDiagnostics,
  type RunJournalEvaluation,
  type RunJournalExplanation,
  type RunJournalRequiredEntry,
  type RunJournalRoundBinding,
  type RunJournalRow,
  type RunJournalStatus,
  type RunJournalViolation,
} from "./checkpoint/run-journal-completeness.ts";
export {
  MANAGED_DELIVERY_NAMESPACE,
  RUN_STORE_DIRECTORY,
  gitNamespaceClearedEnvironment,
  resolveCommonDirectoryNamespace,
  resolveRunStoreLocation,
  runGitDirect,
  type NamespaceGitLaunch,
  type NamespaceGitRunner,
  type NamespaceResolution,
  type NamespaceResolutionInput,
  type RunStoreLocation,
} from "./checkpoint/run-namespace.ts";
export {
  createRunStore,
  type RunAllocateResult,
  type RunAppendResult,
  type RunCurrentResult,
  type RunDiscardResult,
  type RunMatch,
  type RunReadResult,
  type RunSetCurrentResult,
  type RunStore,
  type RunStoreRejection,
  type RunStoreRejectionCode,
} from "./checkpoint/run-store.ts";
export {
  deleteDelivery,
  exportDelivery,
  type DeleteDeliveryResult,
  type ExportDeliveryResult,
  type RetentionContext,
  type RetentionFailure,
} from "./checkpoint/retention.ts";
export { listArchiveEntries, readArchiveEntry } from "./workflow/archive.ts";
export {
  WORKFLOW_CHECKPOINT_BINDINGS,
  WORKFLOW_GRAPH_ENTRY,
  loadBundledWorkflowGraph,
  workflowStageBindingFor,
  type WorkflowCheckpointBinding,
  type WorkflowGraph,
  type WorkflowStage,
} from "./workflow/graph.ts";
export {
  HOST_BINDING_BLOCKER_CODES,
  claudeCodeBinding,
  composeClaudeCodeSession,
  materializeProjection,
  mintGrantAttestation,
  type HostBindingBlocker,
  type HostBindingBlockerCode,
} from "./host/claude-code.ts";
export type {
  ComposeHostSessionInput,
  ComposeHostSessionResult,
  ComposedHostSession,
  HostBindingRefusalDetail,
  HostSessionGrant,
  ManagedHostBinding,
} from "./host/managed-host-binding.ts";
export {
  CODEX_APPLIED_MISMATCH_CODES,
  CODEX_APP_SERVER_HOST_ID,
  CODEX_CHARACTERIZED_HOST_VERSION,
  CODEX_DISABLED_FEATURE_KEYS,
  CODEX_ESCALATION_REFUSAL_CODES,
  CODEX_HOOK_EVENT,
  CODEX_HOOK_EXECUTION_MODE,
  CODEX_HOOK_SUBCOMMAND,
  CODEX_HOST_TOOLS,
  CODEX_PINNED_HOST_VERSION,
  CODEX_THREAD_CONFIG_FILE,
  CODEX_UNENFORCEABLE_TOOL_SOURCES,
  codexAppServerBinding,
  codexEnabledToolsFor,
  codexEscalationTokens,
  codexHostTool,
  codexNamesDisabledSurface,
  codexPermissionProfileId,
  codexPermissionProfileOf,
  codexSubagentPosture,
  composeCodexAppServerThread,
  evaluateCodexEscalation,
  verifyAppliedCodexThreadConfiguration,
  type CodexAppliedMismatch,
  type CodexAppliedMismatchCode,
  type CodexAppliedThreadConfiguration,
  type CodexDisabledFeatureKey,
  type CodexEscalationRefusalCode,
  type CodexEscalationRequest,
  type CodexHostTool,
  type CodexPermissionProfile,
  type CodexThreadStartRequest,
  type CodexUnenforceableToolSource,
  type ComposeCodexAppServerThreadResult,
  type VerifyAppliedCodexThreadConfiguration,
} from "./host/codex-app-server.ts";
export {
  CODEX_HOOK_EVENT_NAME,
  codexHookDecision,
  codexHookTurn,
  codexToolIsLocallyEnforceable,
  codexWrittenPaths,
  decideCodexHookInvocation,
  parseCodexHookInput,
  renderCodexHookDecision,
  type CodexHookInput,
} from "./host/codex-app-server-hook.ts";
export {
  createCodexAppServerConformancePort,
  faithfullyAppliedCodexConfiguration,
  type CodexAppServerConformancePortInput,
} from "./host/codex-app-server-conformance.ts";
export {
  PROJECTION_DIR,
  PROJECTION_RECEIPT_FILE,
  readConsumptionMarker,
  verifyProjection,
  type ConsumptionMarker,
  type ReadConsumptionMarkerResult,
  type VerifyProjectionResult,
} from "./host/projection.ts";
// The binding's gate-record contract. Mutation stays internal to the
// repository-bound managed-delivery facade.
export {
  CONSUMPTION_GATE_RECORD_BLOCKER_CODES,
  SHADOW_MILESTONE_GATE_RECORD_SPEC,
  SHADOW_MILESTONE_GATE_RECORD_SPEC_SUFFIX,
  type ConsumptionGateRecordBlockerCode,
  type EmitProjectionConsumptionResult,
  type ProjectionConsumptionRecord,
  type ProjectionConsumptionUnobserved,
} from "./host/consumption-gate-record.ts";
export {
  PROJECTION_CONSUMPTION_OBSERVATION_SPEC,
  parseProjectionConsumptionObservation,
  projectionConsumptionObservationFile,
  type ProjectionConsumptionObservation,
} from "./projection-consumption-observation.ts";
export { createExecPort, type ExecInvocation, type ExecOutcome, type ExecPort } from "./host/exec-port.ts";
export { entryHref, invokedDirectly } from "./host/entry.ts";
export {
  checkReviewFloor,
  composeOutcomeVerification,
  qualifyReviewAttempts,
  type ConsumedWaiver,
  type QualifiedAttempts,
  type RecordedReviewAttempt,
  type RecordedSensorResult,
  type ReviewRejection,
  type ReviewVerdict,
} from "./evidence/review.ts";
// The waiver doctrine: every waiver a consumed sensitive approval, never a
// disposition an agent writes for itself.
export {
  WAIVER_ACTIONS,
  WAIVER_APPROVAL_ORIGIN_PREFIX,
  checkPositiveCriterion,
  evaluateWaiverConsumption,
  type PositiveCriterionVerdict,
  type WaiverAction,
  type WaiverConsumptionContext,
  type WaiverConsumptionVerdict,
  type WaiverProposal,
  type WaiverRefusal,
} from "./evidence/waiver.ts";
// The blocker/remediation inventory — the audit surface for review loops.
export {
  DELIVERY_BLOCKER_REMEDIATIONS,
  composeBlockerInventory,
  remediationFor,
  type BlockerInventoryEntry,
} from "./evidence/blocker-inventory.ts";
// The finish-line reducer and the operation port merge/deploy would bind to.
export {
  EXTERNAL_VERIFICATIONS,
  FINISH_LINE_ACTIONS,
  UNBOUND_EXTERNAL_ACTION_PORT,
  authorizeFinishLineAction,
  decideFinishLine,
  type ExternalActionIntent,
  type ExternalActionInvocation,
  type ExternalActionPort,
  type ExternalVerification,
  type FinishLineDecision,
  type FinishLineInput,
  type FinishLineRefusal,
} from "./finish-line/merge-ready.ts";
// The external-actions unit: the only sequence by which an authorized merge
// or deployment is actually taken — bind, journal, revalidate, invoke once,
// reconcile before any retry.
export {
  ACTION_APPROVAL_ORIGIN_PREFIX,
  EXTERNAL_ACTION_RESULT_SPEC,
  RECONCILIATION_FINDINGS,
  actionChainDigest,
  checkDeployPreconditions,
  classifyActionOutcome,
  evaluateActionApproval,
  invokeExternalActionOnce,
  journalIntentPayload,
  journalResultPayload,
  planExternalAction,
  reconcileBeforeRetry,
  revalidateBeforeInvoke,
  validateExternalActionResult,
  type ActionAdapterBinding,
  type ActionApprovalContext,
  type ActionApprovalVerdict,
  type ActionChainLink,
  type ActionClassification,
  type ActionEvidence,
  type BoundActionIntent,
  type DeployPreconditionInput,
  type InvocationOutcome,
  type ObservedActionResult,
  type PlanExternalActionInput,
  type PlanExternalActionVerdict,
  type ReconciliationDisposition,
  type ReconciliationFinding,
  type RevalidationObservation,
} from "./finish-line/external-action.ts";
// The control-plane coordination unit: the optional coordination wire, the
// decision about what one remote message is worth, and the refusing port this
// product actually ships. Nothing here can advance local state — that is the
// unit's entire contract, and the closed grammars are what make it mechanical.
export {
  COORDINATION_MESSAGE_KINDS,
  COORDINATION_MESSAGE_SPEC,
  COORDINATION_PROTOCOL_VERSION,
  CONTROL_PLANE_CLAIMS,
  validateCoordinationMessage,
  type ControlPlaneClaim,
  type CoordinationAuthentication,
  type CoordinationMessage,
  type CoordinationMessageKind,
} from "./coordination/message.ts";
export {
  COORDINATION_REFUSALS,
  admitCoordinationMessage,
  type CoordinationAdmission,
  type CoordinationAdmissionView,
  replayLedgerOf,
  type CoordinationRefusal,
  type CoordinationRefusalCode,
  type CoordinationReplayLedger,
  type MirroredMessageView,
} from "./coordination/admission.ts";
export {
  CONTROL_PLANE_CONFLICT_BLOCKER_CODE,
  claimContradictsLocalHistory,
  conflictBlockerEpochOf,
  localFactEpochOf,
  reconcileRemoteClaim,
  type LocalHistoryView,
  type ClaimDisposition,
  type ClaimReconciliation,
  type MirrorRecordView,
} from "./coordination/reconcile.ts";
export {
  COORDINATION_PORT_UNBOUND_CODE,
  UNBOUND_COORDINATION_PORT,
  type CoordinationDispatch,
  type CoordinationPort,
} from "./coordination/port.ts";
export {
  SIMULATED_MESSAGE_OPTION_NAMES,
  createCoordinationSimulator,
  type CoordinationSimulator,
  type CoordinationSimulatorOptions,
  type SimulatedExchange,
  type SimulatedMessageOptions,
} from "./coordination/simulator.ts";
export {
  createManagedDeliveryFacade,
  type CreateFacadeInput,
  type FacadeFailure,
  type ManagedCheckpoint,
  type ManagedDeliveryFacade,
  type ManagedInstallation,
  type CompiledAdopterPolicyBinding,
  type ResolvedPersonaSource,
  compiledAdopterPolicyBindingDigest,
} from "./facade/managed-delivery.ts";
// The graded host-liveness rule and the measured observation lifetime it ages
// against. Exported because every reader of liveness — the per-delivery status
// model and the installation-scoped listing alike — must derive the same grade.
export {
  DEFAULT_OBSERVATION_LIFETIME_SECONDS,
  gradeHostActivity,
  resolveObservationLifetimeSeconds,
  type GradeHostActivityInput,
  type HostActivity,
  type HostObservationStamp,
  type ObservedActivityEntry,
} from "./facade/liveness.ts";
export {
  evaluateMigrationConsumption,
  type MigrationConsumptionContext,
  type MigrationConsumptionVerdict,
  type MigrationRefusal,
} from "./facade/migration.ts";
export {
  FACADE_CAPABILITY_CLASSES,
  FACADE_OPERATIONS,
  FACADE_SURFACES,
  TERMINATION_PROVENANCE_OPERATION,
  checkFacadeSurfaceInvariants,
  facadeOperation,
  operationsOnSurface,
  type FacadeCapabilityClass,
  type FacadeFenceRule,
  type FacadeJournalRule,
  type FacadeOperation,
  type FacadeSurface,
  type FacadeSurfaceFinding,
  type FacadeSurfaceRule,
} from "./facade/operations.ts";
export {
  composeManagedStatus,
  type AssertionSourceView,
  type ListedDelivery,
  type ManagedDeliveryStatus,
  type ManagedStatusInput,
  type MigrationPath,
  type MutationVerification,
  type ProductTrustView,
  type RecordedRegistrationBinding,
  type RegistrationBindingView,
  type RegistrationMismatch,
  type RetrySafety,
  type WorkspaceDisposition,
} from "./facade/status.ts";

export { captureCheckBindings, captureCheckOutputs, captureCheckOutputSnapshots, computeCheckWiringFingerprint, type CheckBindingOptions } from "./checks.ts";
export type { CheckBinding } from "./records.types.ts";
export type { ScopedCheckDefinition } from "./config.ts";
export type { ScopedCheckAttempt, ScopedCheckPlan } from "./records.types.ts";
export { captureScopedCheckInputs, type ScopedInputCapture, type ScopedInputCapturePorts } from "./checks.ts";
export { selectScopedCheckAttempt } from "./evaluator.ts";
export { retainedCheckOutput } from "./validator/checks-passed.ts";
export { readCompiledRepositoryPolicy, resolveReviewCharters, readWorkflowRelease, ReviewInputError, type ResolvedCharter, type ReviewInputReader } from "./review-inputs.ts";

export { validateReviewedContext, parseReviewOutcome, deriveTelemetry, reviewerLists, REVIEWER_RESULTS } from "./review-outcome.ts";
export type { ReviewOutcome, ReviewerOutcome, ReviewerResult } from "./review-outcome.ts";
export { capturePortableEvidenceContext, repositoryEvidenceReader, verifyPortableEvidence, portableArtifactContents, MAX_PORTABLE_RECORD_BYTES } from "./portable-evidence.ts";
export type { PortableEvidence, PortableEvidenceContext } from "./records.types.ts";

export { candidateTreeEvidenceReader, candidateTreeSourceReader, capturePortableVerificationInputs } from "./portable-inputs.ts";
export type { CandidateTreeInputReader } from "./portable-inputs.ts";

export * from "./provider-rails.ts";
export * from "./live-providers.ts";

export { RUN_EVENT_SPEC_V2, RUN_EVENT_KINDS_V1, RUN_ACTIVITY_STATES, type RunEventVersion, type RunActivityState } from "./checkpoint/run-event.ts";
export { projectRunActivities, runActivityTransitionError, DEFAULT_RUN_FRESHNESS_WINDOW_MS, type RunActivityProjection, type RunActivityObservation, type RunAttemptObservation, type RunWaitObservation, type RunReferencedObservation } from "./checkpoint/run-activity.ts";

export { captureRunArtifact, readRunArtifact, type RunArtifactMetadata, type RunArtifactResult } from "./checkpoint/run-artifacts.ts";

export { MAX_PORTABLE_ARTIFACT_BYTES, MAX_PORTABLE_ARTIFACTS, MAX_PORTABLE_EVIDENCE_BYTES } from "./portable-limits.ts";

export type { ScopedExecutionDefinition, ScopedExecutionProfile } from "./config.ts";
export { scopedCheckIdentity, type ScopedRuntimeObservation } from "./scoped-inputs.ts";

export { reconciliationActions, runActionReconciliationError, type ReconciliationAction } from "./spine/run-action-reconciliation.ts";

export {
  normalizeInstalledDataResourceRequests,
  captureInstalledDataResources,
  validateInstalledDataResourceCapture,
  validateResourceApplicabilityProjection,
  createResourceApplicabilityProjection,
  matchResourceApplicabilityProjection,
  InstalledDataResourceError,
  INSTALLED_DATA_LIMITS,
  type InstalledDataResourceRequest,
  type InstalledDataResourceContext,
  type InstalledDataResourcePorts,
  type InstalledDataResourceCapture,
  type ResourceApplicabilityProjection,
  type InstalledDataAttemptOrigin,
} from "./installed-data-resources.ts";

export { isInstalledDataConsumerDefinition, type InstalledDataConsumerDefinition } from "./config.ts";

export { isResourceApplicabilityBinding, validateResourceApplicabilityBinding, createResourceApplicabilityBinding } from "./installed-data-evidence.ts";
export { captureInstalledDataBinding, InstalledDataSourceError, type InstalledDataSourceTree } from "./installed-data-source.ts";

export type { ResourceApplicabilityBinding } from "./records.types.ts";

export { reconstructResourceApplicability } from "./installed-data-portable.ts";

/** Exact native delivery-record output convention shared with resource evidence. */
export { recordOutputProvider } from "./record-output.ts";
