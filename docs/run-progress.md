# Structured run progress

Run progress is self-attested observation. It never grants permissions, approves
a candidate, or replaces the product's evidence validators.

## Writer versions

Existing runs continue using `run-event/1`. A new writer starts v2 explicitly:

```sh
npm run harness -- emit run.started --version 2 --event-id start-1 --json '{"host":"codex","workflow":{"releaseId":"example","profile":"core"}}'
```

Every subsequent v2 `emit` requires a stable `--event-id`. The CLI reads the
selected run's version; it cannot change that version. An exact retry preserves
the original observation instant and sequence. Reusing the ID for a different
payload is refused. Start a new linked run when upgrading, naming the old ID in
the v2 `run.started` payload's `predecessorRunId`; retain the original history.
New readers accept both versions. Old readers may refuse v2 and must not erase it.

Discover a kind's payload before emitting it with
`delivery-harness runs grammar <kind> --version 2 --json` (use `--version 1`
for a legacy run). This read-only view derives everything from the validator's
own member checks: each member's name, requiredness, `type`, the `constraint`
in the validator's own words, a closed vocabulary as `values`, a nested table as
`members`, an array element as `items`, and — where which table applies depends
on a sibling member, as `cost` and `preparation` do — the arms as `variants`.
Every member carries an `example` the same validator accepts, and the document
carries a whole-payload `example` that is emittable as it stands: every required
member, plus any optional member a combination rule makes mandatory for the
values published there, so
`emit run.started --version 2 --event-id start-1 --json '<that example>'`
starts a run without reading the kernel. The document's spec is
`run-event-payload-grammar/2`; `/1` carried names, requiredness and vocabularies
only. Validation is unchanged: it still refuses unknown or missing members,
identifies the accepted member set, and now names that set when a non-object
reaches a member that holds one — `workflow` supplied as a string is still
refused at `/payload/workflow`, and the refusal names `releaseId` and `profile`.

An explicit `--json` payload never reads stdin. Omitting `--json` reads JSON
from stdin until EOF:

```sh
npm run harness -- emit decision.recorded --event-id choice-1 --json '{"fork":"input","choice":"explicit JSON"}'
printf '%s' '{"fork":"input","choice":"piped JSON"}' | npm run harness -- emit decision.recorded --event-id choice-2
```

Interactive terminal input without `--json` receives a usage diagnostic; pipe
JSON or supply the flag. A closed empty pipe receives the missing-payload
diagnostic after EOF. An open pipe intentionally waits for delayed input and
EOF; it has no production timeout. Interrupt it with Ctrl-C when the producer
will not finish. Embedding adapters must preserve those EOF and delayed-input
semantics and supply terminal information when available. Diagnostics go to
stderr, and absent or invalid input never appends a successful event.

`run.ended` deliberately carries only `result` and `cost`; it does not carry
`finishLine`, `mergeCommitSha` or `note`. Record the confirmed finish line and
merge commit in `decision.recorded` before `run.ended`, using `choice` for the
outcome and `cited` for the merge reference. These are observations, not merge
authority. Keep the run open through the authorized finish line. Any continuation
after the terminal event needs a linked successor run; retain both histories.

The product's own writers follow the same rule from inside. Command completion
reporting and [`save-context`](ordinary-resume.md) read the selected run's
version from its first journal event and write at it, supplying an event ID
when that version is v2; neither upgrades a run and neither downgrades one. `save-context`
needs a retry key and derives it from the observation, so repeating an
interrupted save appends nothing new while a changed observation is a new
entry; command completion reporting mints a fresh ID per invocation, because
each invocation is a distinct observation.

## Activities and reports

The closed payload definitions live in the
[run-event contract](../packages/kernel/src/checkpoint/run-event.ts). V2 adds these observations:

| Kind | Purpose |
| --- | --- |
| `activity.observed` | Activity/attempt, owner, phase, state and candidate; optional review identity, next step, verdict and cost |
| `wait.started` / `wait.resolved` | A named wait and its owner, scope, reason, required action and resolution |
| `finding.observed` | Explicit finding disposition attributed to a report |
| `report.referenced` | Review, reduction, clarification or partial-output reference, with explicit availability |
| `artifact.referenced` | Bounded artifact metadata and digest; reference alone does not prove retained bytes |
| `finish.step.observed` | Declared remaining delivery steps and their observed states |

An attempt belongs to one logical activity and candidate. Retrying creates a new
attempt with `supersedesAttemptId`; a late result for the old attempt remains
history. A terminal attempt cannot restart. Queued attempts can fail or be
interrupted, and terminal observations with missing start events remain visible
as incomplete history. No start time is invented.

Review round identity is separate from attempt identity. V2 round events carry
`roundId`; opened events may carry a declared `bound`, `grace` designation and
`reopensRoundId`. The workflow decides round accounting. A viewer does not count
a clarification as another policy round on its own.

Completeness pairs version-2 round events by `roundId`, so a base-move replay
can keep the same round number without inheriting the earlier candidate's
closure. The latest opening and latest close must form the same ordered pair,
bound to the record's candidate or its verified reviewed tree. That close precedes the governing
(last) gate, and the governing record follows that gate. Earlier valid attempts
remain history; an inverted round remains a structural violation. Version 1
retains numeric round pairing because it has no replay identity.

A linked version-2 retry may observe an existing pull request before its first
gate; `predecessorRunId` exempts only that PR chronology. It does not exempt any
required event, current-round binding or gate/record ordering, and it cannot
serve as evidence that a predecessor admitted this candidate.

The shared projection retains all findings and separately selects the latest
reported disposition of each current finding. These are reported findings,
not an independent verdict. Absent structured findings remain unreported.

Freshness is computed against a caller-supplied clock and a five-minute default
window; callers may supply another nonnegative window. Recent observation does
not establish continuous liveness. Silence becomes stale or unknown. An open
run or current worktree pointer is not a heartbeat.

V2 round costs are cumulative reported snapshots per round, reporter and unit.
The latest comparable snapshot replaces an earlier one; supersession marks
coverage partial. Unreported measurements are never zero. Attempt and run totals
must not be added to their encompassing round totals.

## Automatic command observations

The candidate-facing command boundary reports `check`, `prepare`,
`review-context`, `emit-review-evidence`, `submit-evidence`, `gate`, `record` and
`verify`. On a v2 run, these native commands report running against their
first successful command-owned candidate capture. `check` and descriptors that
do not opt in retain the boundary's eager capture. Progress reporting adds no
extra capture to an opted-in command: every command capture remains fresh, with
its before/after quiescence checks intact. Concurrent captures share only the
progress-reporting promise, which each successful caller waits for; they never
share candidate results. Reporting failures remain best effort.

The boundary records a matching completed, failed or interrupted activity when
it returns. Usage refusals and failures before a successful capture still record
`command.completed`, without inventing a candidate activity. Concurrent
invocations have separate IDs; a changed current-run pointer cannot move their
completion to a different run. Legacy v1 runs retain completion-only reporting.
The existing `command.completed` retains the exact exit outcome,
duration and successful digest. A successful v2 `prepare` completion also carries
`payload.preparation`, the product's actual check decision:

| `checks` | `reason` | Observed decision |
| --- | --- | --- |
| `executed` | `ordinary` | Ordinary preparation ran its configured checks. |
| `executed` | `receipt-not-reusable` | Refresh had no reusable owned receipt and ran the checks. |
| `executed` | `preparation-fingerprint-changed` | Wiring changed after receipt evaluation, so refresh ran the checks. |
| `reused` | `validation-equivalent` | The prior owned success proved strict validation projection, base, policy and wiring unchanged. |

The optional field is introduced in runtime 0.4.0 and survives run export and
archive transport. It is absent on failed or interrupted commands and on legacy
records, including v1 completions; absence means unknown, never executed or
reused. Consumers read the latest CLI `prepare` completion's field and outcome
directly. Neither requested flags nor an earlier successful completion supply a
missing decision. This observation does not grant receipt validity or admission.

`gate.reported` is required by completeness only when the journal has no CLI
`command.completed` entries. In that legacy executor-only fallback its ordering
stands in for the CLI gate observation. A standalone `npm run check` still needs
its own timed `gate.reported` observation under the workflow contract; the CLI
does not observe that external process. The product's command duration is
already recorded automatically and must not be duplicated as a manual gate.

The native waiver prompt supplies an actual human wait and its scoped
resolution. It does not change who may approve, and no approval is reusable
from these events. Intermediate provider or host progress is unavailable unless
explicitly reported; there is no heartbeat supervisor or transcript inspection.
An abruptly terminated process can leave a running attempt that becomes stale;
absence of completion never means success. No raw arguments or environment
values are captured.

The boundary checks the selected journal version before emission. Legacy runs
retain completion-only v1 events. Missing candidate capture leaves activity
unreported; it never invents a candidate. Failed observation writes do not change
command outcomes or gate decisions. Viewing runs does not journal the viewer.

## Storage and export

Run writes use bounded cross-process serialization around validation,
deduplication, sequence allocation and append. This requires local filesystem
semantics and one host PID namespace. Live lock owners are never expired; a dead
owner may be recovered. Contention refuses the observation after five seconds
by default without changing the underlying command's result.

`runs show <id> --json` emits `delivery-run-export/2` for v2 runs. Its progress is
a historical projection at the last recorded observation, not fresh verification.
Readers recompute the projection and reject inconsistent derived values. V1
exports remain supported. Artifact metadata in this contract does not itself
retain a file; acquisition capture and portable attachment transport use the
separate retention capability when installed.

## Cycle time

`runs show <id>` prints a `phases:` block above its rounds, and
`runs show <id> --json` carries the same figures under `summary.phases`.

- `implementation` runs from the journal's first event to its first round event.
- `review` runs from that first round event to the last `review.round.closed`,
  so the fix time between two rounds is review time rather than a gap.
- `tail` runs from the last closed round to the journal's last event, and is
  still accruing while the run is open.

The three phases always tile the run's own total: a breakdown that did not add
up would tell an operator two different things about one delivery. Where two
writers' clocks disagree — a round opened, by its own instant, before the run
started — each boundary is held inside the run's span rather than reported as a
negative phase.

`gate time` is reported separately, because a gate runs inside whichever phase
it was invoked from. It sums `durationMs` over the journal's `gate.reported`
events and the CLI's own `command.completed` entries for `gate`, counting a
superseded gate too. A journal carrying no gate completion reads as `unseen`,
never as free: the gate this delivery ran is simply missing from the figures
above it. A gate that journaled no readable duration is counted and reported as
under-reporting the sum.

Selected acquisition reports can be retained through [run artifact capture](run-artifacts.md).

See [the operational run view](run-view.md) for browser, terminal and JSON access.
