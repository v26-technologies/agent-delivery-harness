# Declared validation and artifact checks

The existing [provider contract](provider-guide.md) also supports declared checks. A provider can declare a bounded command instead of implementing the stdio provider protocol:

```ts
providers: [{
  id: "repo.validation",
  findingCodes: [],
  check: {
    command: ["npm", "run", "test"],
    timeoutMs: 300000,
    outputs: ["build/check-result.json"],
  },
}],
```

Connect it to an existing `exact_candidate` obligation accepting `checks.passed/1`, with `satisfied_evidence` allowed. Use the existing activation policy for thresholds and sensitive paths. `outputs` is optional; a typecheck can succeed solely by exiting zero. Commands execute directly as argv in the repository root. A provider cannot declare both `command` (stdio protocol) and `check`. Output paths must be unique repository-relative paths; escaping symlinks, non-files, missing files and files above 1 MiB block. There are at most 64 outputs and a timeout of at most one hour. Child stdout/stderr is bounded to 1 MiB and failure diagnostics to 4,000 characters.

`prepare` runs declared mechanical prerequisites. `gate` uses the existing provider-backed admission path: resolve active independent review before expensive checks, execute missing checks, construct their evidence, submit it through the existing manifest validator, and re-evaluate admission. A nonzero exit, spawn failure, timeout, cancellation, output failure or candidate/base/wiring mutation publishes no passing evidence. Parent flags and command output text do not declare success. Check execution is a self-attested observation of the actual child process; it does not claim a stronger signed trust profile.

The `checks.passed/1` payload is closed: `{verdict: "green", exitCode: 0, binding}`. The binding contains SHA-256 digests named `definitionDigest`, `validationDigest`, `policyDigest`, `wiringFingerprint` and `outputsDigest`. It covers the command definition, full resolved policy, runtime/preparation wiring, output bytes and the candidate's validation projection. Candidate/base/workspace fields remain in the existing manifest and evidence record.

Validation uses the existing tree identity algorithm with **record-neutral** exclusions. Review still uses **review-neutral** exclusions. A report or solution note can preserve review approval while requiring validation again. A record-neutral addition does not require repeated validation. Changing argv under the same provider id, policy, base, wiring or an output invalidates reuse. Live facts remain invocation-specific and cannot be satisfied by these records.

Each run retains `check-result.json` and one `check-output-N.json` artifact per output. Output snapshots contain the repository path and canonical base64 bytes, so binary output survives transport. The shared validator rehashes these bytes and checks the terminal outcome and full contextual binding. Portable verification supplies freshly computed `checkBindings`; omitting them blocks. The shared installed release reader binds `.agent-skills/active.json.release`, including explicit absence; a same-package-version release swap invalidates validation. `captureCheckBindings` accepts `readReleaseInputs(path)` and `readWiring(path)` for reading tracked wiring from the verified candidate tree and `readOutput(path, providerId)` for reading retained output bytes with `retainedCheckOutput`. Transported wiring must never replace current candidate wiring. Physical local admission reads current files itself.

Repository policy continues to declare its review lenses, mechanical commands, validation/artifact obligations and merge-admission live facts. This feature adds no scheduler, state engine, report format or repository sensor implementation.

## Scoped execution

A check that declares a `scope` runs in a private snapshot of the prepared tree under one of the `scopedExecution` profiles. Profiles that declare the same dependency setup — the same `dependencies` command, the same `dependencyInputs` and the same `gitContext` — share one snapshot, so that setup installs once and every check in those profiles runs against the same installed bytes. Each check may still write only its own profile's `mutableOutputs`: before a check runs, its declared outputs and every output path of the other sharing profiles are removed, and afterwards the snapshot is verified with only its own profile's outputs excluded, so a write to another profile's output is drift. With one worker, one snapshot is live at a time: moving to a different setup discards the previous snapshot before the next is created.

`scopedExecution.concurrency` (a positive integer, default `1`) runs that many scoped checks at once, in both `prepare` and `gate`. Each worker takes the next check when it is free and owns its trees: it gets one per dependency setup the first time it needs it and reuses it for its later checks until the invocation ends, so two checks never share a tree at the same time. Each check's lines are printed together when it finishes. A failing check does not stop the others that are running, and an interruption removes every worker's trees. With `1` the checks run one at a time exactly as described above.

### Snapshot setup and reuse

With more than one worker, a setup runs once per invocation, not once per worker. The first check that needs a setup builds a warm base for it: the dependency setup runs there, and no check command ever does. Every worker, including that first one, takes a copy-on-write clone of the base: `clonefile(2)` on macOS (APFS), a reflink copy (`cp --reflink=always`) on Linux. Each clone is private, so a write in one clone reaches neither the base nor any other clone. Each worker builds its own tree as before, and the record says why, in two cases:

- The temporary directory supports neither cloning method.
- The setup wrote the tree's own absolute path into one of its files. A Python virtual environment's scripts are one example. A clone would still read and write the base through that path. The inventory that hashes the installed tree finds such files.

Each attempt's retained diagnostic carries `setup`:

- `action`: `executed` when this attempt ran the setup, or `reused` when it did not.
- `snapshot`: `built`, `cloned` or `retained` (the worker's tree from its previous check).
- `clone`: `clonefile`, `reflink`, `unavailable`, `path-bound` or `not-used` (one worker).
- `verification`: what was checked before the command.
- The timed `phases` up to the command. These are the build phases, `warm-base-wait`, `clone` and `pre-command-verification`. They are kept even when the setup fails.

The same facts are printed as a `setup <check>: attempt <id>; …` line before `checking`.

A tree this attempt built is verified by its full inventory before the command runs. A cloned or retained tree is verified from Git's index instead:

Git always runs with an explicit Git directory and work tree, with `core.fileMode=true`, and with sparse checkout and fsmonitor off, because a full-Git command can edit `.git/config`.

1. `git update-index --refresh` runs first.
2. Every index entry must be a plain cached one: an assume-unchanged or skip-worktree flag would hide an edit.
3. `git diff-files` must list nothing: no tracked file was edited, deleted or changed mode.
4. Every path `git ls-files --others --directory` lists must be accounted for. The listing reads no exclude rules, because a command could write one. Each path must either have been left by the setup, or lie inside the running profile's `mutableOutputs`, or lie inside the outputs of a profile whose check already ran and passed in that tree.

This happens before outputs are removed, so a write to another profile's output is refused, not silently erased. A write inside the running profile's own outputs stays in place for its command, so a profile's own cache (a `tsBuildInfo`, Vitest results) seeds its next run in that tree. After every command, the full inventory still runs. It is the only check that covers installed dependency bytes, links and special files inside outputs, and new content inside a directory the setup left untracked. A reused tree passed it after its last command. Finite snapshots have no Git, so they are always verified by their full inventory.

The isolation is of files only. Host ports, the network and anything outside the temporary directory are shared, so serialize them in the adopter (Athena does this with `scripts/host-port-lock.ts`). The path check reads only the tree's immutable files, and only for the path's plain bytes. A path written elsewhere is not detected, and a later write through it is caught only as drift by a later clone's post-command inventory. That covers a path written into the home directory's caches, into a mutable output, or in another encoding (escaped JSON, UTF-16).

`prepare` runs the first declared of the `mechanicalProviders` first, because that is where a selection guard that must precede every other check belongs. It runs the rest cheapest first. A check's cost is the duration of its most recent passed or failed attempt, less the dependency setup that attempt itself ran. Checks never timed run after timed ones, and ties keep declaration order, so a first `prepare` follows declaration order. Checks then run one dependency setup at a time, in the order each setup first appears in that sequence, so each setup installs once. The first failure stops preparation: no later check starts, checks already running finish, and no receipt is published. The first declared check finishes before any other starts, whatever the concurrency.

A failed scoped check prints a failure report on standard output before its blocker: the failure code, the attempt id and the path of its retained `terminal.json`, the command that ran with its working directory — the profile's dependency command when setup failed — and its exit code with the last 40 lines of its output, after credential redaction. The same tail is kept in the retained attempt.

A passed attempt is reused, by `prepare` and by `gate`, whenever the check's current input digest and profile digest both equal the attempt's. Reuse is never extended past a changed digest, because the digest is what binds the pass to what the check could observe. Two things move the profile digest even when no declared input changed. Every profile binds the selected base ref, tip and merge base, so a moved base reruns every check. A `gitContext: "full"` profile also binds the original HEAD commit and the whole prepared tree, because such a check can read any file and the history; any new commit, including an unrelated one, reruns it. Declare `gitContext: "none"` for a check that reads only its declared files to keep its pass across unrelated commits. A check run with a present credential that has no declared nonsecret identity is not reused across candidates.

## Installed package DATA consumers

A finite consumer that reads installed package data can opt into a separate
applicability outcome. Keep its ordinary command and execution profile. Declare
`check.installedData` with `version: "installed-data-consumer/1"`, a stable
`consumerId`, finite `requests`, a scoped `source` definition and `guards` mapping
qualified executable source paths to SHA-256 hashes. The source profile, cwd and
environment must match the check. Every request issuer must be a guarded test;
additional declared source files can be DATA whose changes restore execution
without repinning executable guards. The adopter owns the complete input closure,
including executable launcher/configuration authority and both source snapshots.

A request has `version: "installed-package-data/1"`, `id`, snapshot-relative
`issuer`, literal package name, `manifest: "package.json"`, explicit package-relative
`files` and finite `directories: [{path, suffix}]`. Native require resolution must
select the owned root installation through its exported manifest; nearer installs,
links, escapes, unreadable inputs and exceeded limits refuse capture. Requested
directories retain complete membership alongside selected binary bytes. Limits
are 16 requests, 4,096 entries, 1,024 members per directory, 1 MiB of raw data and
the shared 2 MiB portable artifact bound. There is no truncation fallback.

Opted-in exact-candidate obligations accept both `checks.passed/1` and
`installed-data.applicable/1`. Keeping `checks.passed/1` is mandatory: cold,
changed or unavailable authority executes the actual consumer. V1 permits one
resource provider, outside mechanical preparation and review/live obligations.
A declaration without the applicability payload opt-in retains ordinary execution.

An already accepted applicability observation can be reused for the same candidate
and strict record-neutral transport without another capture/setup. Native reuse
reconstructs its source/context, checks the current runtime observation, and
rechecks latest native origin precedence. Any new source candidate still needs
fresh installed-resource capture.

Configuration import and preparation acquire no installed resources. After normal
preparation and selected independent review, `gate` derives source/setup identity
from immutable Git inputs and captures resources in its existing owned dependency
snapshot when the consumer reaches its execution stage, after preceding checks.
Cold execution shares that snapshot and retains a separate
`resource-applicability/1` projection only after the command passes post-command
verification. With parallel workers, the first requested check and the captured
consumer run on the capture worker before the remaining checks enter the pool.
Other workers retain independent snapshots. Worker-local ordering keeps capture,
applicability publication or cold execution together; cleanup drains accepted
work before removing snapshots. Serial setup eviction remains unchanged. Before observing resources, the worker
clears shared profiles' permitted mutable outputs; prior checks' retained output
evidence remains available. The observer still verifies the full immutable
source/dependency snapshot before and after capture.

An unrelated HEAD can leave this qualified consumer's source/resources unchanged
while its original full-Git input/profile remains stale. In that case the gate
allocates no consumer attempt and emits the closed applicability payload
`{verdict: "applicable", binding}`. Its `installed-data-binding/1` binding covers
the current candidate, check definition, consumer declaration, source applicability,
resource capture and original native execution. It travels separately as
`resourceBinding`, with `resource-result.json` and `resource-proof.json` artifacts;
it supplies no `checks.passed` claim. Native admission rechecks latest origin
precedence, so a newer failed, running or unqualified attempt cannot borrow an
older resource projection.

Portable verification reconstructs the original full-Git identity, verifies
original and current guarded source applicability, retained resource bytes,
setup/runtime/release/policy context, original successful command diagnostics and
outputs, and the current applicability binding. It reads Git and retained
artifacts, without installing or reading the importing host's dependencies or
attempt store. This retains the existing self-attested trust model: verification
proves the retained native observation at its recorded boundary; it cannot observe
later attempts in another host's private store. Missing independently reconstructed
resource bindings refuse applicability. Ordinary check bindings and freshness
rules remain in force for every ordinary passing-check claim.
