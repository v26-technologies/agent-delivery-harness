---
title: A row budget that ages under its own probes
date: 2026-09-15
category: harness
module: delivery-harness-scripts
problem_type: measurement_error
component: testing
resolution_type: budget_and_attribution
applies_when:
  - "A row that spawns many subprocesses times out on a base nobody touched"
  - "A qualification grows a probe and the row driving it keeps its old bound"
  - "A refusal message names a product command but the host is what failed"
tags: [delivery-harness, wall-clock, process-starvation, characterization, attribution]
---

# A row budget that ages under its own probes

## Problem

`scripts/build-product-runtime.test.ts` failed on untouched `origin/main` at
`0edb8d5`, `9834e33` and `1a64ab4`. Two lanes of the 2026-09-13 wave met it in
their tail gates, each as `1 failed / 2 passed` with `Error: gate expected exit
0` after about 135 s, and neither could touch the file because it belonged to a
delivery that still read In Progress. Run alone on a quiet-ish checkout the same
file fails differently:

```
npx vitest run scripts/build-product-runtime.test.ts
-> Tests 1 failed | 2 passed (3), Duration 193.62s
   × qualifies scoped execution through the actual bundled runtime 180003ms
   Error: Test timed out in 180000ms.
```

Two different messages, one row. Neither is an assertion.

## Diagnosis

The row calls `runScopedRuntimeQualification`, which drives the bundled runtime
through three disposable repositories. Instrumented outside vitest, the split is
unambiguous:

| stage | cost |
|---|---|
| `buildProductRuntime` (esbuild ×4 + rollup-dts ×2) | 1 425 ms, then 1 061 ms warm |
| `runScopedRuntimeQualification` | 206 871 ms across **45** bundled-CLI executions |

So the setup the row was suspected of — rebuilding the runtime — is 0.7 % of it,
and the row's declared 180 000 ms bound sits *below* the work it drives. The
bound was written when the qualification proved fewer probes; V26-2067 added
`selection-snapshot-guard` and `attempt-observations` and the executions that
prove them, and nothing connected the new probes to the old number.

The per-execution cost is the second half. Five consecutive
`cli.mjs --help` runs on this host inside one minute:

```
125 ms, 1516 ms, 8560 ms, 151 ms, 120 ms
```

Same command, same bytes, same minute, two orders of magnitude apart. That is
the process-starvation signature
[the 2026-09-14 note](a-test-timeout-that-is-the-checkout-not-the-diff-2026-09-14.md)
describes, and it is why the same row produces `gate expected exit 0` under a
wave — a check command crosses its own `timeoutMs` waiting to *start*, and the
qualification reports the command it expected rather than the wait — and a bare
`Test timed out` when run alone. The failure is load-shaped in magnitude and
structural in cause: 45 spawns against a distribution with an 8.5 s tail, under
a bound that never counted them.

## Resolution

Three things, all inside the one file the ticket owns.

**The ceiling is not sized from a duration.** 206.9 s was measured with a
delivery wave running beside it, and the 2026-09-14 note is explicit that such a
number is not a measurement. It is recorded as an observation and not used as a
divisor. The row's ceiling is 900 000 ms because that is far above anything the
row has cost either way and still short enough that a genuine hang fails inside
one delivery. No row here asserts how long it took.

**The probe count is pinned to the budget.** The row now asserts
`result.commands.length === 45`, the count observed when the ceiling was written
and the count the qualification spends today — equality rather than a ceiling,
so a probe quietly removed has to restate the number too.
A probe added to `qualify-product.ts` trips a named assertion in the file that
has to pay for it, instead of silently spending someone else's tail gate. This
is the regression row: it fails for the exact reason the original bound went
stale.

**A refusal says which side failed.** `attributeRowFailure` reports
`environment` when a bare `node -e 0` start was stalled while the row ran,
`candidate` otherwise, and `candidate` when nothing was sampled: it names the
environment only when the environment measurably stalled, and never launders a
real defect. Its three rows pin the allow side, the deny side, and the
unsampled case, and two more rows pin the sampler that feeds it — that it takes
more than one sample, and that the number it reports is one it measured rather
than one it chose.

**And every row that spends subprocesses carries its own bound.** A row that
crosses vitest's ceiling is aborted from outside: its `catch` never runs, and it
refuses as a bare `Test timed out in Nms`, which is the ticket's own symptom. An
attribution wired into one row of four therefore just moves the ticket to the
other three — and it did: under the storm, the consumer row exhausted 180 000 ms
on host stall alone and said nothing about whose fault it was. So
`runRowWithStallAttribution` enforces an inner `bound` per row and the vitest
`ceiling` sits well above it as a backstop nothing reaches. The
sampler is a parameter of that wrapper rather than a local, which is what lets a
row prove the wrapper reads it.

### Four self-corrections worth keeping

The first version of the attribution sampled on the way *out* of the catch, and
on its first real failure — a check crossing the qualification's own 30 000 ms
command timeout under the storm — it reported `candidate`, because by the time
it asked, the host had recovered and the median start was 67 ms. A stall is
transient and it is the outlier that records it. So the sampler runs *alongside*
the row and the verdict reads its maximum. An attribution measured after the
thing it attributes is not a measurement of it.

The second is sharper. That sampler used `execFileSync`, which blocks the
worker's event loop for the whole duration of a start — and
`scripts/qualify-product.ts` guards every bundled command with a 30 000 ms
`setTimeout` on that same loop. A synchronous sample the host stalled for longer
than the guard fired the guard on unblock, ahead of the child's already-queued
`close`. The instrument written to explain a timeout had become sufficient to
cause one: a run failed with `a bare start on this host took 33376 ms` against a
30 000 ms guard, which is a refusal by arithmetic. The probe is now awaited
`execFile`, which times the same quantity and competes for nothing.

The third arrived from the first run of the second fix. Under the storm the
sampler's own start had not come back either, so the completed-sample list was
empty at exactly the moment the verdict mattered, `attributeRowFailure` read
`unsampled`, and two rows blamed the candidate for a host that had stalled them
— the v1 defect wearing a different hat. A start outstanding for `n` ms is
already evidence the host took at least `n` ms, so `stop` now returns the
in-flight elapsed alongside the completed samples.

The fourth is about the guard, not the instrument. Those two numbers per row
were eight loose constants, and the row that was supposed to keep them ordered
compared the constants to each other. That is not the quantity that matters: a
row is free to pass its own ceiling as its inner bound, vitest then aborts it
from outside, and the bare `Test timed out in Nms` is back with the guard row
still green. The row asserted the table it read, not the wiring it described —
and `expect(bounded.length).toBe(4)` counted entries in that same table, so it
could only fail by editing itself. A budget is now one record keyed by the row's
own name, and a row names itself and nothing else.

That first attempt at the repair was itself the same mistake one level up, and
the next round caught it. The registry it added recorded row *names*, so the
guard asserted that a row HAD a budget and still nothing about the two numbers
the row ran under: passing a ceiling where a bound belonged satisfied every
assertion, and the bare timeout came back. A record compared against a registry
that both sides derive from the same key observes the table, not the wiring —
which is the sentence above, rewritten one level down. So `registerBudget` is
now the only expression in the file that turns a name into two numbers, it
registers exactly what it hands out, every declaration passes what it returned,
and the guard row orders the registered numbers. There is nowhere left to write
a bound.

And then a third pass, because "nowhere to pass one that is not the one
asserted" was still a sentence about the code rather than a thing the code
checked. The guard row ordered two fields of one object; nothing read back the
third argument `it` had been handed, so lowering a row's vitest ceiling onto its
own inner bound put the abort and the bound at the same instant — vitest wins,
the catch never runs, the bare timeout is back — with every assertion green. The
row body now reads `task.timeout`, which is what vitest will actually enforce,
and compares it to the ceiling its budget registered; it also checks by
reference that the budget it is running on is the one in the registry. A row
with no work is declared through the same door purely so that both checks are
exercised in seconds rather than only in the rows that cost minutes.

And a fourth pass, on the half the third pass had excused. The hook was written
off as unreachable — "a `beforeAll` consumes no fixtures and vitest exposes no
hook timeout" — and the residue was written down as if writing it down settled
it. It was simply false at vitest 4.1.11: the suite's registered hooks carry the
timeout the runner will enforce, and `getHooks` from `vitest/suite` reaches it.
Lowering the hook's ceiling onto its own bound left the whole suite green and
restored the bare `Test timed out in 120000ms` for the file's ONLY producer — a
build every row waits on, so the one site where losing the attribution fails
every row at once. **A residue accepted on a claim about the tool, rather than
on a claim about the evidence, is a hole with a comment over it.** The cheap way
to tell the two apart is to try to disprove the claim before writing it down;
the expensive way is what happened here.

**Four times, the repair asserted one level above the thing that could go
wrong.** The record instead of the wiring, the names instead of the numbers, the
numbers instead of what the runner enforces, and the rows instead of the hook.
Each time the giveaway was the same: the assertion could be satisfied without
the mechanism existing.

The same reading applies to the instrument's own test. It drove the sampler at a
5 ms interval against a 60 ms probe, so a sampler that timed the whole cycle —
the start plus the sleep after it — reported 65 ms and sat inside a band that
tolerated 180. At the production 10 000 ms interval that mutation reads every
sample as ten seconds, which is forty times the degraded threshold, and every
failure for the life of the file attributes to the environment: the v1 defect
inverted, a real product defect blamed on the host forever. The interval in that
row is now five times the probe, which is the smallest change that lets the band
tell the two quantities apart.

**A guard that asserts the constants rather than the wiring is a guard for the
table, not for the behaviour.** It reads as coverage, which is worse than none.

The provenance of the evidence matters here, in a note whose thesis is that a
reading taken after the thing it reads is not a measurement of it. The run that
read `a bare start on this host took 101490 ms` and named the environment was
the run BEFORE this third fix, and it is evidence for the per-row bound, not for
the in-flight change: it was an ordinary completed sample in the consumer row.
The in-flight change is evidenced by its own row and has not yet been observed
on a subprocess row on this host.

**An instrument that shares a resource with the thing it measures is part of the
measurement.** All three corrections are that one sentence: the first took its
reading at the wrong time, the second took it out of the subject's own budget,
and the third went silent under the very condition it existed to detect.

The build is also hoisted to one `beforeAll` with a copy per row, which is the
cheap half of the ticket and worth about three seconds — recorded here mostly so
the next reader does not re-derive it as the cause.

## The rule

**A bound on a row that drives a fixed number of subprocesses is a claim about
that number, so pin the number.** A duration ages silently; a count does not. If
a row's cost is `n` spawns and `n` lives in another file, assert `n` where the
bound is written, and the day someone adds the forty-sixth spawn they are told
by the file that has to survive it rather than by a tail gate two lanes away.

And when such a row refuses, make the refusal name the host or the candidate.
Three separate deliveries read `gate expected exit 0` as a product defect,
because that is what it looks like.
