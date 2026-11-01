/**
 * The evidence record's shapes, with no filesystem in sight.
 *
 * `records.ts` opens files, runs git, and links directory entries. Pure modules
 * — the gate evaluator above all — need the *shapes* those operations move
 * around and must never acquire an edge to the operations themselves. That is
 * why the shapes live here: the purity sensor lets a pure module import a
 * `*.types.ts` file by name and nothing else from the fs-bearing side of the
 * kernel, so this seam is what keeps the evaluator honest.
 *
 * Nothing in this file may import anything. A type-only import would be safe
 * for the sensor and still wrong here: the point of the seam is that it has no
 * dependencies to reason about.
 */

/**
 * The record schema version. Deliberately *not* a member of the identity tuple
 * below — identity is the spec's SUB-4 tuple, closed and enumerated — so a
 * future version bump must either keep the tuple meaning what it means today or
 * change the filename grammar. Every stored record carries the version so a
 * reader can reject one it does not understand instead of guessing.
 */
export const RECORD_SCHEMA_VERSION = 1;

/** A waiver is either good for this invocation only, or bound to the candidate. */
export const WAIVER_SCOPES = ["invocation", "durable"] as const;

export type WaiverScope = (typeof WAIVER_SCOPES)[number];

/**
 * What the record is bound to — the enumerated field set, no spreads.
 *
 * `workspaceId` appears here *and* on the record itself, and the redundancy is
 * intentional. The record's member says which workspace's store the file
 * belongs in; this one is part of the candidate the evidence was produced
 * against, and it travels into the gate's freshness comparison. They are
 * normally equal and the store does not require it: making them one field would
 * quietly turn a candidate that moved workspaces into a candidate that did not.
 */
export interface RecordCandidateBinding {
  /** The raw prepared tree. Recorded strictly (SUB-1); ignored at gate time. */
  readonly treeSha: string;
  /** Digest of the deliverable under the configured neutral sets. */
  readonly deliverableDigest: string;
  /** The identity version that produced `deliverableDigest`. */
  readonly identityToken: string;
  readonly baseRef: string;
  readonly baseTipSha: string;
  readonly mergeBaseSha: string;
  readonly workspaceId: string;
}

/**
 * Accepted evidence. The provider triple (`providerId`, `runId`,
 * `finalPassId`) is part of the identity; `manifestDigest` is not — it is what
 * the record *says*, and two records that disagree about it on one identity are
 * the conflict SUB-4 exists to reject.
 */
/** Current native authority for an installed-data applicability claim. */
export interface ResourceApplicabilityBinding {
  readonly version: "installed-data-binding/1";
  readonly candidateDigest: string;
  readonly definitionDigest: string;
  readonly declarationDigest: string;
  readonly sourceApplicabilityDigest: string;
  readonly captureDigest: string;
  readonly originDigest: string;
}

export interface CheckBinding {
  readonly definitionDigest: string;
  readonly validationDigest: string;
  readonly policyDigest: string;
  readonly wiringFingerprint: string;
  readonly outputsDigest: string;
  /** Present only for opted-in scoped checks; all three fields travel together. */
  readonly scopedInputDigest?: string;
  readonly scopedAttemptDigest?: string;
  readonly scopedProfileDigest?: string;
}

/** Allocated before execution by the executor's durable generation fence. */
export interface ScopedCheckAttempt {
  readonly version: "scoped-attempt/1";
  readonly providerId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly inputDigest: string;
  readonly profileDigest: string;
  readonly status: "running" | "passed" | "failed" | "interrupted";
  readonly origin: { readonly candidate: RecordCandidateBinding; readonly runId: string };
}

/** Current selection is separate from result identity and must be recomputed on base movement. */
export interface ScopedCheckPlan {
  readonly version: "scoped-plan/1";
  readonly candidate: RecordCandidateBinding;
  readonly selectionDigest: string;
  readonly checks: Readonly<Record<string, {
    readonly inputDigest: string;
    readonly profileDigest: string;
    readonly reusable: boolean;
    readonly attempts: readonly ScopedCheckAttempt[];
  }>>;
}

export interface EvidenceResolution {
  readonly kind: "evidence";
  readonly providerId: string;
  readonly runId: string;
  readonly finalPassId: string;
  /** Stamped from the accepted manifest (SUB-4). */
  readonly manifestDigest: string;
  readonly checkBinding?: CheckBinding;
  readonly resourceBinding?: ResourceApplicabilityBinding;
  /** Accepted original evidence retained before its temporary run root disappears. */
  readonly portable?: PortableEvidence;
}

export interface PortableEvidenceContext {
  readonly configurationDigest: string;
  readonly preparationFingerprint: string;
  readonly policyDigest: string | null;
  readonly release: Readonly<Record<string, unknown>> | null;
  readonly workflowGraphSha256: string | null;
  readonly reviewerCharters: readonly {
    readonly origin: "composition" | "repository";
    readonly sourcePath: string;
    readonly lensId: string;
    readonly reviewerId: string;
    readonly personaId: string;
    readonly entryPath: string;
    readonly digest: string;
  }[];
}

export interface PortableEvidence {
  readonly version: "portable-evidence/1";
  readonly manifest: unknown;
  /** Safe manifest-relative path to canonical base64 of the original file bytes. */
  readonly artifacts: Readonly<Record<string, string>>;
  readonly context: PortableEvidenceContext;
}

/**
 * A waiver has no provider run: a human accepted a scoped exception. Its full
 * attribution participates in identity, so another approval can coexist while
 * a byte-identical approval remains idempotent. Nothing overwrites prior approval.
 */
export interface WaiverResolution {
  readonly kind: "waiver";
  readonly scope: WaiverScope;
  readonly author: string;
  readonly reason: string;
  readonly findingCodes: readonly string[];
  readonly policyDigest: string;
}

export type RecordResolution = EvidenceResolution | WaiverResolution;

export interface EvidenceRecord {
  readonly schemaVersion: typeof RECORD_SCHEMA_VERSION;
  /** Digest of the identity tuple; also the last segment of the filename. */
  readonly recordId: string;
  /** The workspace whose private store owns this record. */
  readonly workspaceId: string;
  readonly gateId: string;
  readonly obligationId: string;
  readonly candidateBinding: RecordCandidateBinding;
  readonly resolution: RecordResolution;
}

/**
 * What a caller supplies. The three members it cannot choose — the schema
 * version, the workspace, and the content-addressed id — are derived by the
 * store, which is the only party that knows where the file is going.
 *
 * There is no timestamp. A record is content-addressed and republishable; a
 * clock reading would make a byte-identical resubmission differ from the stored
 * copy and turn idempotency into a conflict. When the record was written is a
 * property of the file, not of the evidence.
 */
export type PublishRecordInput = Omit<EvidenceRecord, "schemaVersion" | "recordId" | "workspaceId">;

/** The tuple a `recordId` is the digest of, in its evidence spelling. */
export interface EvidenceRecordIdentity {
  readonly workspaceId: string;
  readonly gateId: string;
  readonly obligationId: string;
  readonly candidateBinding: RecordCandidateBinding;
  readonly providerId: string;
  readonly runId: string;
  readonly finalPassId: string;
}

/** The waiver spelling binds the attributed approval instead of a provider run. */
export interface WaiverRecordIdentity {
  readonly workspaceId: string;
  readonly gateId: string;
  readonly obligationId: string;
  readonly candidateBinding: RecordCandidateBinding;
  readonly kind: "waiver";
  readonly approval: WaiverResolution;
}

export type RecordIdentity = EvidenceRecordIdentity | WaiverRecordIdentity;

/**
 * Why a file in the store is not being served as a record. The classes are kept
 * distinct because they mean different things to an operator: a truncated write
 * is a crashed writer or a full disk, while an identity mismatch is a file
 * whose contents no longer agree with the id they are filed under — which is
 * either tampering or a store written by a different version of this code.
 */
export const RECORD_QUARANTINE_REASONS = ["unreadable", "corrupt_json", "malformed_shape", "identity_mismatch"] as const;

export type RecordQuarantineReason = (typeof RECORD_QUARANTINE_REASONS)[number];

export interface QuarantinedRecord {
  readonly path: string;
  readonly reason: RecordQuarantineReason;
  /** Operator-facing detail. Never parsed; only displayed. */
  readonly detail: string;
}

/**
 * A neighbour the store passed over. `in_progress` is a publisher's temporary
 * file — possibly one orphaned by a crash — and `foreign` is anything else
 * sharing the directory. Neither is a record and neither is a defect, but
 * reporting them keeps "the store ignored it" from being indistinguishable
 * from "the store never looked".
 */
export interface IgnoredStoreEntry {
  readonly path: string;
  readonly reason: "in_progress" | "foreign";
}

export interface RecordDiscovery {
  readonly storageDir: string;
  readonly workspaceId: string;
  readonly records: readonly EvidenceRecord[];
  readonly quarantined: readonly QuarantinedRecord[];
  readonly ignored: readonly IgnoredStoreEntry[];
}

/** Where a workspace's harness storage lives, and what that workspace is called. */
export interface WorkspaceStorage {
  /** The namespace root — one per workspace, shared by every leaf. */
  readonly storageRoot: string;
  /** The leaf directory this resolution asked for. */
  readonly storageDir: string;
  readonly workspaceId: string;
}

export type PublishStatus = "published" | "idempotent";

export interface PublishedRecord {
  readonly status: PublishStatus;
  readonly path: string;
  readonly record: EvidenceRecord;
  readonly workspaceId: string;
}
