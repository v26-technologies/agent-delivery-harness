---
title: Reuse authenticated inventory membership and forward existing snapshot timing
date: 2026-10-25
---

# Reuse authenticated inventory membership and forward existing snapshot timing

Scoped input capture already built a Set to reject duplicate inventory paths,
then discarded it and searched the sorted array once per selected file. Keeping
that same invocation-local Set removes the repeated linear search. It changes
neither the authenticated inventory nor source reads, metadata, absence checks,
prefix memberships, error ordering or digest serialization. The regression
fixture selects 64 inputs and rejects any linear inventory membership calls;
the original implementation made 64. Existing input identity and parallel-read
controls remain relevant alongside this performance sensor.

The snapshot helper already measures materialization, baseline inventory,
dependency setup, post-dependency inventory and verification. Its caller did
not pass the observation callback. Forwarding that hook through the existing
scoped lane sink exposes those durations with provider and attempt identity.
The helper already suppresses observation errors, so a failing output sink
cannot change execution or admission. Parallel lanes still buffer output until
their check finishes; these lines are not a new live phase clock or evidence.

The lookup change does not reduce eager source hashing or Git reads. An
external synthetic 8,209-file input-capture fixture retained 8,209 size and
8,209 body requests through the actual Git reader's fake command port, before
and after. Its in-process timing samples were 182–185ms before and 34–78ms
after, with tiny generated buffers and no real Git subprocess or SDK setup.
Those samples establish no Athena setup saving or full-selection target.

Mechanical-only identity construction is a separate contract change. The
executor publishes and submits each mechanical result through binding capture,
which currently requires a complete plan for every configured scoped provider.
Completing a lazy plan at submission would move the hashing within preparation,
not remove it. A future targeted binding projection must also preserve valid
prior-output consumers: the current output reader uses a populated identity map
to distinguish scoped private output from authoring-checkout files. Simply
leaving a scoped identity absent would break that invariant. Keep full gate
plans, candidate/base bindings and output custody intact when addressing that
remaining cost.
