# Provider guide

A **provider** is the system that conducts a review and attests to its result:
an agent framework, an orchestration tool, a review pipeline. This guide is the
path from a review context to an *accepted* manifest — every rule below is the
implemented behavior of this repository's kernel, exercised by the
[89-vector conformance kit](conformance.md), with the normative text in the
[spec](spec/delivery-evidence-1.md).

## The two surfaces

Both expose the same two operations with the same semantics — the MCP server is
a strict-parity wrapper over the CLI's command core, not a second
implementation:

- **CLI**: `delivery-harness review-context`, then
  `delivery-harness submit-evidence --manifest <path>`.
- **MCP** (`@agent-delivery-harness/mcp`, stdio): tools named `review-context`
  and `submit-evidence` (the latter takes `manifest`, the path to the manifest
  file). Rejections arrive as structured, typed blockers; malformed tool
  arguments are the same usage-error class the CLI reports as exit 2.

An MCP session never sees a waiver prompt. Waivers belong to interactive
humans; a provider's job is to make evidence, not to excuse its absence.

## Opt-in command providers

A provider registration may add a non-shell argv array:

```ts
providers: [
  {
    id: "review.provider",
    findingCodes: [],
    command: ["review-provider", "--stdio"],
  },
]
```

When an active obligation is blocked only because this configured provider has
not supplied a live result or retained evidence, `gate` and `record` invoke the
command at their existing command boundary. Repositories whose registrations
omit `command` keep the manual flow described in the rest of this guide.

A command provider that reads no scoped check's attempts, records or outputs may
declare `independentOfScopedChecks: true`. The declaration is only `true`, and only
on a provider with `command`. When the gate runs scoped checks on more than one
worker, it then starts that provider's live attempt while those checks run, rather
than after them, and admits once for the checks and every provider that ran beside
them. Results apply in request order, exactly as the serial loop applies them, so
the verdict and every record are the same either way.

Under `scopedExecution.failFast`, the first scoped failure cancels each provider
still running beside the checks, through the rail's own `cancel`. A provider is
reported `interrupted <id>: check_cancelled after <failed id> failed`, and its
result never counts, even if it finished first. A provider that does not declare
the field keeps waiting for the scoped checks, as before. The harness judges
dependence only by the declaration, never by reading the provider's code.

A command provider gets plain stdio. It may also declare
`inheritDescriptors: [3, 4]` (or just one of them, ascending) to inherit those
descriptors from the invocation. An invocation uses this to hand a provider a
capability it already holds, such as a pipe to its own analysis worker.

A declared descriptor is passed only when the launcher that opened it vouches
for that very pipe or socket in `DELIVERY_HARNESS_INHERITED_DESCRIPTORS`, as
`<fd>:<dev>:<ino>` entries (for example `3:16777220:1234,4:16777220:1235`), and
the descriptor's own identity matches. `dev` and `ino` are the open
descriptor's `fstat` values as exact unsigned 64-bit decimals: a socket's
device of -1 on darwin is `18446744073709551615`. A JavaScript launcher reads
them with `fstatSync(fd, { bigint: true })`, since the number form rounds
them. Where only rounded numbers are available (Bun 1.1.29 ignores
`bigint: true`), a value beyond 2^53 has no identity and is never passed; the
named FIFOs an invocation opens carry small exact values. Runtimes also
disagree on a socket's device on darwin (Bun reports 0 where Node reports -1),
so a socket passes only when launcher and harness read it the same way; a
launcher that may differ from the harness's runtime hands on named FIFOs. This applies wherever
the product opens a provider: `gate`, `record`, and `verify`'s live collection. An open descriptor alone is not enough:
Bun and Node hold descriptors 3 and 4 themselves, and a setting can outlive the
descriptors it named. The provider's environment then states exactly what it
received, and nothing when it received nothing. Only the declaring provider
receives them, and no other descriptor is ever passed.

The command exchanges one JSON document per stdout/stdin line. The documents
and state transitions are the exact vendored
[`delivery-provider-rails/1` contract](contracts/delivery-provider-rails-v1.md);
the corresponding [JSON Schema](contracts/delivery-provider-rails.schema.json)
and [shared conformance vectors](../packages/cli/fixtures/delivery-provider-rails-v1.json)
are retained alongside the adapter. Stderr is diagnostic only and is never
parsed as protocol data.

After negotiation, the request payload includes the gate, provider, obligation
ids, candidate binding, and harness-allocated `runId` and `runRoot`. Those
nested members are adopter-owned opaque payload data, not additions to the
contract envelope. For an exact-candidate obligation, a successful terminal's
opaque `result` must contain `manifestPath`. The adapter submits that manifest
through the existing recorder and exposes no green result until publication is
accepted. A live obligation maps terminal success to the evaluator's existing
live-provider result. Provider blocker events become ordinary typed blockers;
unsupported negotiation, malformed or conflicting sequences, process closure,
cancellation, failure, and indeterminate terminals all fail closed.

Negotiation, protocol writes, and event waits share one bounded lifecycle
deadline and the CLI's interruption signal. Expiry or interruption produces an
indeterminate typed blocker; after a request has begun, the adapter sends
`cancel` best-effort, terminates the child with a bounded SIGTERM grace, then
uses SIGKILL if the process does not close and awaits that closure.

Terminal outcomes are absorbing. In particular, cancellation or a locally
indeterminate interruption can never be replaced by a later success. Each
evidence record keeps the recorder's existing fsync-and-link crash-atomic
publication boundary and its real-process crash sensor. The recorder's
pre-existing multi-claim limitation also remains: a process crash between
separate claim publications can leave already-linked records, so a provider
should prefer one claim per manifest when whole-manifest crash atomicity is
required. The tracked delivery record is still produced by the ordinary
`record` command; the rail creates neither a second evidence store nor a second
telemetry stream.

## Emit concluded host reviews

The installed CLI ships `emit-review-evidence`. Its
[implementation](../packages/cli/src/review-evidence.ts) transcribes concluded
host reviews and prints a manifest path. This repository's `review:evidence`
script is a thin alias for that same command. It does not run reviewers.

Before review, save `review-context --json` outside the candidate worktree and
give its binding to every selected reviewer. The document includes the candidate,
base, preparation fingerprint, configuration, compiled policy, installed release,
workflow graph and resolved charter digests. Copy its `digest` into the concluded
outcome's `contextDigest`; retain that original value across the review.

```sh
delivery-harness prepare
delivery-harness review-context --json > /tmp/original-review-context.json
# Obtain the host-native reviews against this saved context first.
MANIFEST="$(delivery-harness emit-review-evidence --context /tmp/original-review-context.json <<'JSON'
{
  "spec": "review-outcome/1",
  "contextDigest": "<digest from the original review context>",
  "verdict": "green",
  "reviewers": [
    { "result": "approved" },
    { "result": "approved" }
  ],
  "findings": []
}
JSON
)"
delivery-harness submit-evidence --manifest "$MANIFEST"
```

When the concluded outcome names the exact context the current prepared
candidate still produces, save that outcome as JSON and run
`delivery-harness admit --outcome /absolute/path/to/outcome.json`. The composite
reruns preparation, reconstructs and validates the context named by
`contextDigest`, then uses the same emitter, submission, gate, and tracked
record paths shown above. It does not run reviewers, create approvals, commit
the record, or turn a mismatch into evidence. Keep using the explicit
`emit-review-evidence --context` form when a review-neutral projection needs the
separately retained original context.

Emission requires a current preparation receipt and rejects mismatched context
or outcomes. After changes confined to configured review-neutral paths, prepare
again and supply the original review context: its deliverable identity must still
match, with base, policy, wiring, release and charters unchanged. Other changes
require review against a new context. Submission rechecks the candidate, so a
change after emission cannot silently acquire the earlier approval.

For neutral reuse, `review-context-projection.json` names the original reviewed
candidate and the current prepared candidate, preserves the original run
history, and states `reviewRoundAdded: false`. The manifest's final history tree
and approval stamps use current preparation coordinates to satisfy submission;
they do not assert that reviewers inspected the new raw tree. The original
context and outcome remain unchanged so another verifier can inspect this
distinction. History length and review cost do not increase for that projection.

The manifest retains both the original context and the complete outcome as
digest-checked artifacts. Attestation remains `self`; transcription does not
verify host independence. A multi-round outcome may supply its actual
`runHistory` and `finalPassId`; otherwise it describes one concluded pass.
Optional `cost` uses the payload's `unit`, `total`, `reportedBy` and optional
`byReviewer` fields and requires `costCoverage` in the outcome. For example,
`subagent-tokens` with coverage stating that executor usage is unavailable is a
partial measurement. The emitter never estimates missing usage.

`iterationCount` counts the manifest's recorded prepare-and-evaluate passes,
not submissions, journal events, or individual lenses. A single submission can
carry several actual passes. For a fix followed by re-verification, retain the
first pass's prepared tree, prepare and review the repaired tree, and supply
both entries in order with the final pass identifier:

```json
{
  "runHistory": [
    { "preparedTreeSha": "<first prepared and reviewed tree>", "evaluatedInPassId": "pass-1" },
    { "preparedTreeSha": "<final prepared and reviewed tree>", "evaluatedInPassId": "pass-2" }
  ],
  "finalPassId": "pass-2"
}
```

These members extend the concluded `review-outcome/1` above. Its
`contextDigest` must identify the final reviewed context; the emitter derives
`iterationCount: 2` from the two entries. Keep each pass's original context and
reviewer results in the retained outcome. Earlier plan reviews that had no
prepared candidate are not prepare-and-evaluate passes: retain them as review
history in the complete outcome and captured reduction, without inventing
prepared trees. RG-9 checks the submitted history length and cannot recover
review effort that the caller omitted. Journal round observations never supply
or authorize admission history.

One entry per reviewer the policy selects, and no ids: the ids are basenames of
charter paths inside the installed archive, and a caller that restates them is
redoing the emitter's own resolution with no way to check the answer. A review
whose reviewers did not all report the same thing has to name them —
`{ "id": "outcome-correctness", "result": "rejected" }` — because unnamed
results that disagree could only be assigned to reviewers by their order, and
the emitter refuses that rather than stamping the wrong lens. The named form is
held to the policy-selected set in both directions, so a name no activated lens
defines is refused.

Three things it resolves rather than asserts, each of them a way a provider can
quietly stop describing the repository it serves:

- **The reviewer set is the compiled policy's activated lenses.** `selected` is
  every review lens
  [the compiled snapshot](../.agents/policy/compiled-snapshot.json) carries,
  named by the basename of the charter path the installed generation's manifest
  declares for it — so activating a lens moves the evidence with it. Each
  charter is read from that generation and its bytes checked against the digest
  the policy was compiled against; a charter the installation does not carry, or
  one whose bytes have drifted, refuses the emission. An outcome that leaves a
  lens unrepresented, or names a reviewer no activated lens defines, is refused
  before any manifest exists. The same resolution supplies the ids of an
  outcome that carries none.
- **The obligation and provider come from the config.** The one obligation
  accepting `review.green/1`, and the one provider it names.
- **Telemetry is derived from the findings**, the way RG-8 re-derives it.

A reviewer's `result` is one of `approved`, `rejected`, `failed`, or
`timed-out`; only `approved` stamps a reviewer-approval artifact, and the last
two land in `failed` / `timedOut`, which RG-3 refuses. The `verdict` is
transcribed, not asserted: a non-green outcome produces a manifest the recorder
rejects on RG-1, which is the point — a provider that always claims green is not
evidence of anything, and one that declined to emit at all would hide the review
rather than report it. Both polarities are pinned by
[`scripts/emit-review-evidence.test.ts`](../scripts/emit-review-evidence.test.ts),
which runs the real recorder and evaluator over fixture repositories whose
charter sets are deliberately not this repository's.

## Pinned provider interoperability qualification

`npm run qualify:provider` replays the repository's one checked provider
qualification. It binds the exact harness rail, recorder, contract, schema, and
vectors to one deterministic agent-skills core release and its retained core,
provider, and Linear qualification identities. The release is installed into a
fresh temporary repository, then its installed Python module is opened through
the real subprocess rail. The successful attempt carries the ordered native
operation set `create`, `read`, `update`, `search`, `relations`, and
`reconciliation`; its non-empty manifest is submitted through the ordinary
recorder with the caller-bound provider attempt.

The replay also rejects immutable-input and release mismatches, an unsupported
protocol, a controlled subprocess crash, an interrupted invocation, and a
missing manifest. A fresh installed process repeats the successful request with
the same request, idempotency, and run-root identity; the provider must emit the
same manifest bytes and the recorder must report the same claim as idempotent,
leaving one stored record.

The checked qualification record is candidate-keyed and retains the existing
evidence semantics: candidate binding, manifest digest, provider/run/final-pass
resolution, and publication outcomes. It deliberately omits the recorder's
workspace-local record id and storage workspace id. Retaining a literal
`delivery-record/1` from a random temporary workspace would make replay bytes
machine-specific; inventing stable replacements would no longer be the
recorder's record. The qualification proves the exact offline subprocess and
publication boundary. Its retained Linear qualification and attestation hashes
preserve the six-operation contract, but they do not claim a fresh connector
call; that provenance remains with the protected host run.

### Which MCP revisions the server speaks

Four, across both of MCP's eras — and the two tools behave identically on every
one of them. Only the envelope differs.

| Revision     | How a client reaches it                                            |
| ------------ | ------------------------------------------------------------------ |
| `2026-07-28` | Stateless. Every request declares `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` in `_meta`. |
| `2025-11-25` | `initialize` handshake. This is what the handshake settles on by default. |
| `2025-06-18` | `initialize` handshake.                                            |
| `2024-11-05` | `initialize` handshake.                                            |

`2025-03-26` is **deliberately absent**: it is the one revision that requires a
server to accept JSON-RPC batches, and this transport refuses every array. A
client asking for it through the handshake is answered with a revision where
that refusal is the truth.

Under `2026-07-28` the server implements `server/discover` (mandatory in that
revision, and the client's backward-compatibility probe on stdio), stamps
`resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]` on
every result, carries `ttlMs` and `cacheScope` on `server/discover` and
`tools/list`, and answers an unsupported per-request version with
`UnsupportedProtocolVersionError` (`-32022`). `ping` exists on the three
handshake revisions and is gone under `2026-07-28`, which removed it.

Two consequences worth knowing before you write a client:

- **`initialize` will not negotiate `2026-07-28`.** That revision has no
  handshake, so echoing it would promise a session the revision abolished. A
  client that opens with `initialize` is served the handshake revision it names,
  and one naming `2026-07-28` — or anything else this server does not speak — is
  served `2025-11-25`. To reach the stateless revision, probe with
  `server/discover` first: exactly what the spec recommends a dual-era stdio
  client do. (`initialize` is answered as a handshake even if your transport
  attaches per-request `_meta` to it, so that fallback always works.)
- **The server emits no `notifications/message`, on any revision.** It declares
  no `logging` capability and writes diagnostics to stderr, which is what the
  revision that deprecated the Logging feature directs stdio servers to do. A
  request may still carry `io.modelcontextprotocol/logLevel`; an unrecognized
  value is rejected with `-32602`.

## The lifecycle

```
operator: prepare            (publishes the preparation receipt)
provider: review-context     (what to review; requires a current receipt)
provider: …conduct the review, iterating passes…
provider: write artifacts + manifest into the allocated run root
provider: submit-evidence    (validate, re-capture, publish records)
```

Ordering is mechanical, not conventional: without a current preparation
receipt there is no review context and no submission — and the receipt goes
stale when the candidate moves, the base advances, or a declared wiring file
changes. A provider that hits a stale receipt asks for re-preparation; there is
no bypass.

When no mechanical providers are selected, preparation validates scoped profile
and output declarations against the prepared inventory, checks required input
presence through the source reader, and requires selected ordinary inventory
members to resolve as present through metadata. Actual absent resolution probes
and directory witnesses remain supported. It validates any declared finite physical
source with the existing byte, mode, link, size and absence checks. It defers
non-mechanical consumer content and runtime identities to the gate instead of
hashing their broad input sets during preparation. This is not passing check
evidence or a promise that a consumer runtime is available. A gate creates fresh
identities; selecting mechanical providers retains their execution and identity
checks before a receipt is published.

### 1. Read the review context

`review-context` reports the candidate binding (tree, deliverable identity,
base coordinates), the relevant-change projection (what counts toward
activation after the config classifies out generated files, tests, and
lockfiles), and any sensitive-path matches. Everything your manifest must bind
to is in this context; do not capture your own view of the repository out of
band.

### 2. Run the review — the final-pass discipline

A **run** (one `runId`) may contain many prepare-and-evaluate **passes**. The
contract cares about one thing
([§5.5](spec/delivery-evidence-1.md#55-runhistory), ENV-9): the final
`runHistory` entry must name exactly the candidate's tree and your
`finalPassId`. Evidence about an earlier pass describes a tree that no longer
exists — if anything changed after your last evaluated pass, run another pass.
`telemetry.iterationCount` must equal the number of `runHistory` entries
(RG-9); the validator re-derives it and rejects a mismatch.

### 3. Write artifacts into the run root you were allocated

Run roots are **recorder-allocated, never provider-chosen** (SUB-3): a
directory keyed by `provider.id` and `runId` under the harness's namespace in
the system temp directory, obtained from the kernel's artifacts port
(`createArtifactsPort().allocateRunRoot({ providerId, runId })` — the
getting-started guide's [example provider](getting-started.md#2-a-provider-in-one-file)
shows the call). Both ids are path components and are grammar-checked before
any path join: `runId` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`, 1–128
characters (ENV-2).

Every artifact you declare must sit inside that run root — relative paths
only, no `..` segments, resolved (realpath) locations contained within the
root (ENV-10) — with a `sha256` equal to the file's bytes at submission time
(ENV-11). The manifest file itself must also reside inside the run root
(SUB-3).

**Reviewer approvals** are the one artifact role `review.green/1` requires:
exactly one artifact with role `reviewer-approval` per selected reviewer, whose
content is the JSON stamp of
[§9.2](spec/delivery-evidence-1.md#92-the-reviewer-approval-artifact-role) —
`result: "approved"` with provider, workspace, and candidate values identical
to the envelope's (RG-4). The stamp re-states the binding rather than
referencing it, so each approval is independently interpretable in an audit.
The ten `rg-4-*` conformance vectors enumerate exactly what mismatches look
like.

### 4. Assemble the manifest

The envelope is [§5](spec/delivery-evidence-1.md#5-the-envelope) of the spec;
the payload is [§9](spec/delivery-evidence-1.md#9-payload-reviewgreen1). The
rules a provider most often trips over, as this kernel enforces them:

- **Strict membership** (GEN-1): any member the spec version does not define —
  envelope or payload — rejects the whole manifest with `unknown_member`.
  There is no tolerated extra field; evolution happens by version rev.
- **The candidate must be the recorder's candidate** (SUB-1): at submission
  the recorder re-captures and compares on the enumerated field set — `vcs`,
  `treeSha`, `headSha`, `deliverable.digest`, `deliverable.identity`,
  `base.ref`, `base.tipSha`, `base.mergeBaseSha`, `workspaceId`. Equality is
  exact, including the **raw tree**: identity-based leniency exists only at
  gate time, never at recording time. `headSha` is optional in the envelope,
  but if you declare it, a head that moved under an identical tree is a
  rejection — re-prepare rather than patching the manifest.
- **Prepared state only** (SUB-2): unstaged changes or untracked files at
  submission reject with `candidate_unprepared`.
- **Attestation**: `level: "self"`, `signatures: []`. This kernel rejects
  *any* other level — including the two the spec defines for the future — and
  any non-empty signatures array, both as `unsupported_attestation`
  ([errata note E2](spec-errata.md#e2-env-12-rejects-the-two-defined-non-self-levels)).
- **A green payload means green** (RG-1, RG-6): `verdict: "green"`,
  `finalized: true`, `editedAfterFinalPass: false`; no finding may be
  `blocking`, and every `actionable` finding must be `resolved`,
  `pre_existing`, or `deferred`. Green with unresolved or ignored actionable
  work is a contradiction the validator rejects.
- **The reviewer set must have finished** (RG-2, RG-3): `selected` non-empty
  and unique; `completed` set-equal to `selected` (order is free — the
  `a-completed-order-differs` vector pins that); `failed` and `timedOut`
  empty. A degraded reviewer set is not green.
- **Telemetry is re-derived, not trusted** (RG-8): `findingCounts`,
  `deferredExpansionCount`, and `deferredIssueIds` (sorted, deduplicated) must
  equal what the validator recomputes from `findings`. Do not maintain these
  by hand; derive them from the same data you emit as findings.

### The deferral rules (RG-7)

Deferring a finding is legal only when **all** of these hold:

| Condition | Meaning |
|---|---|
| `actionable: true` | Only actionable work can be deferred. |
| `blocking: false` | A blocking finding can never be deferred. |
| `severity` ∈ {`P2`, `P3`} | **No P0 or P1 may ever be deferred, regardless of scope.** |
| `scope: "expansion"` | Only scope-expansion work defers; in-contract and adjacent findings must be resolved. |
| `deferredIssueId` matches `^[A-Z][A-Z0-9]*-\d+$` | A real tracker reference — `V26-1401`, not `TODO` or a lowercase slug. |

And the converse: `deferredIssueId` must be **absent** on any finding whose
disposition is not `deferred` — an issue id on a resolved finding is
`illegal_deferral` too. This is where the "every deferral is tracked" rule is
enforced for the whole product: a refused manifest publishes no evidence record,
so no delivery record can ever attest a review that deferred untracked work
(see [the delivery record](delivery-record.md)). The ten `rg-7-*` and three `rg-6-*` reject vectors
walk every edge of this table; run your provider against them before running
it against a real repository.

### 5. Submit, and read rejections the way they are written

Validation is **atomic** (GEN-3) and **complete** (SUB-5): if any rule fails
for any claim, the entire submission is rejected, no record is written, and the
response carries *every* violated rule's code — not the first one. Fix the full
list, not the top line. The stable code registry is
[Appendix D](spec/delivery-evidence-1.md#d-appendix-d--rejection-code-registry);
every code arrives as a typed blocker with a remediation, rendered identically
on the CLI and MCP surfaces.

On acceptance the recorder writes one content-addressed evidence record per
claim into the git-private store, each stamped with the canonical
`manifestDigest` (SUB-4), and reports the record ids.

## Resubmission: the multi-step contract

Two conformance vectors pin what happens when a provider submits twice, and
they are the behavior to build retry logic against:

- **Byte-identical resubmission is idempotent success**
  (`a-idempotent-resubmission`): same manifest, same run root, submitted
  twice — both submissions are accepted and the record ids are identical.
  Retries after a crash or timeout are safe *if you re-submit the same bytes*.
- **Same identity, different content is a conflict** (`sub-4-record-conflict`):
  a record's identity is the digest of (`workspaceId`, gate, obligation,
  candidate binding, `provider.id`, `runId`, `finalPassId`). Submit a
  *different* manifest under that same tuple and the recorder rejects with
  `record_conflict` — an identity that already attested one content can never
  quietly attest another.

The practical rule for providers: a (runId, finalPassId) pair names one
immutable submission. If anything about the run's content changes — another
pass, a different finding set, corrected telemetry — that is a new pass id (and
usually a new `runHistory` entry), not an edit to the old manifest.

## After acceptance: how your evidence ages

The gate judges freshness by **deliverable identity**, not by the raw tree and
never by time: narration-only changes (paths in the config's `reviewNeutral`
set) do not stale your review, while any change to the deliverable does. Base
movement stales evidence. There is nothing a provider can do to refresh stale
evidence except review the new candidate — which is the point.

## Finite physical source for scoped checks

A qualified check may opt into `check.physicalSource` with the closed shape
`{version: "physical-source/1", files: [...], absentInputs: [...]}`. This is
physical execution authority, separate from `scope` reuse inputs and
`installedData.source` applicability. Without the field, materialization and
Git behavior remain unchanged. The opt-in requires a `gitContext: "none"`
profile; Git-dependent or unqualified tools keep the complete private tree.

Declare exact candidate files covering the consumer and its configuration,
startup, resolver, DATA and setup closure. Include every dependency input and
test member. Paths must be unique and unambiguous, with at most 1024 combined
file/absence entries. Materialized source is bounded to 8 MiB per file and
64 MiB total. Candidate symlinks and linked ancestors are refused, including
internal links to omitted targets. Tracked dependency files cannot be physical
source. Files come from the immutable prepared candidate, preserving bytes and
executable modes; author worktree files and installations supply no authority.
These logical source bounds are checked by the kernel before materialization,
counting every declared file even when Git deduplicates its blob. The CLI reader
separately bounds Git transport to 128 MiB, reserving room for listings and size
responses without reducing the supported source-content budget.

Required absences are checked against that candidate and protected throughout
setup, resource observation and execution. Mutable outputs cannot overlap an
absence or its ancestors/descendants. Output permissions do not waive absence,
link or type checks. Verification still walks the entire resulting source and
installed dependency tree; finite mode does not filter dependency verification.
Filesystem inventory operations overlap within a fixed worker pool. Results
retain the original sorted-child depth-first tuple order, including directory
referent and link authority; globally sorting paths would change that identity.
The pool drains started operations before reporting a failure. It neither
removes verifier boundaries nor turns output exclusions into traversal skips.
Existing directory referents use exact bigint filesystem device/inode identity
from the inventory walk, so case and Unicode spelling aliases share the actual
same coordinate while distinct directories remain distinct. Missing path suffixes
have no object identity: finite verification supports ASCII suffixes only, with
conservative ASCII case comparison. A non-ASCII unresolved alias or required
absence suffix is unsupported and is refused before the consumer; the producer
does not automatically retry a full snapshot. An adopter may independently
recognize that unsupported qualification and select its ordinary full fallback.

Dangling output aliases are resolved component by component, including missing
suffixes and relative link chains (at most 32 links); unresolved unsafe chains
are refused. A dangling target does not lose its protected absence identity.
Different source envelopes cannot share an incomplete execution tree solely
because their setup commands match. Cancellation and cleanup retain ownership
of the snapshot and reader processes.

The complete physical declaration and candidate bytes/modes/absences bind
scoped and portable identities. A finite installed-DATA consumer's whole-check
attempt remains candidate-bound even without physical Git: an unchanged setup
recipe does not prove unchanged installed bytes. A new candidate re-enters
native resource observation; matching resource evidence may omit the command,
while changed DATA restores it. Same-candidate record verification does not
reacquire dependencies. Builtin-only checks can separately qualify no setup;
Git-none alone grants neither setup omission nor a smaller dependency runtime.

Successful installed-DATA origins retain their original scoped selection. Portable
reconstruction validates that closed scope against the immutable original tree
and exact original input/profile digests, while current execution context,
source, policy and resource authority remain mandatory. Environment declarations
use the identity's name-sorted order; changed names, kinds or values still refuse. Older proofs without a
retained scope require the existing current-frame reconstruction to prove those
same original digests; missing history is never backfilled. Resource definition
identity shares the ordinary check convention that omits only the exact current
candidate-keyed delivery-record output, not other neutral paths or siblings.

This capability does not prove an adopter's source closure, qualify its command,
or establish latency. The adopter must select it only for a supported exact
closure, preserving ordinary fallback for unknown effects or changed authority.
Malformed explicit configuration fails closed rather than silently running an
incomplete tree.

Source identity capture also uses bounded concurrent reads and finite native
Git object batches. A batch's frames, object hashes and child exit must all
validate before its bytes are published. Injected command runners retain their
individual-object contract. Concurrency changes neither the input set nor the
identity's ordering, and malformed native output does not select another reader.
