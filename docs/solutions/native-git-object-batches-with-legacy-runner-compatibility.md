---
title: Batch native source objects without changing injected Git runners
date: 2026-10-25
---

# Batch native source objects without changing injected Git runners

A cold candidate-tree source reader previously launched a size command and a
body command for every distinct object. Keeping an inventory Set removed linear
membership work but left those process launches unchanged. The next bounded
change batches demanded source objects through finite `git cat-file --batch`
processes, at most thirty-two objects per wave and one active child per reader.

The command port is also an embedding boundary. Explicitly injected runners
must keep their existing command protocol; adding stdin support does not prove
that an existing caller implements it. Select batching only when the source
reader receives the native `runGitCommand` function itself. A caller that wraps
that function deliberately remains on the per-object path. Test both that
compatibility route and a compiled public kernel bundle passing its own exported
native runner, as consumers do. This selection never falls back after a failed
batch.

Batch framing is not object identity. Require the requested full OID, expected
blob/tree type, safe nonnegative byte length, complete binary body and delimiter,
and no extra trailing data. Recompute the existing Git object hash over the type,
actual byte length and exact bytes. Complete process and frame verification
before resolving any batch member; evict failed pending entries so later reads
can retry. Preserve the existing reader-local typed-object map, cloned return
buffers and path/mode/link resolution. Evidence keeps its pre-body size limit;
source blobs may still exceed it. The wave bound limits object count, not total
source bytes or retained memory.

Enqueuing sixty-seven reads before the first flush proves the wave-size bound but
cannot prove the active-child bound. Removing the active scheduler guard still
passed that test. Hold a real native child behind an explicit release signal,
enqueue a distinct request during it, and observe actual launches after draining
scheduler microtasks. The guard-removal mutation must launch a second child and
fail the regression. Always release and await held children in cleanup.

One fixed-order comparison on an immutable tree read 8,230 regular files and
28 links with exact returned-byte, metadata and digest parity. Reader phase time
was 48.720s before and 36.435s after. Both sides independently validated regular
blob OIDs and sizes; matching failures could not count as successful hydration.
These are observations from one old-then-new pair with fresh reader maps and
uncontrolled OS caches, not a total gate speedup or a population estimate.
Planning and selection remain separate costs. An initial comparison setup failed
because the staged measurement tree belonged to its preserved clone rather than
the integration checkout; retain the failed attempt and bind both object store
and tree before interpreting timing.

The finite batch path also needs a binary transport. The public command runner
returns decoded UTF-8 and base64 for `captureBytes`; using it internally made
one batch pass through chunks, concatenation, UTF-8, base64, base64 decoding and
then verified frame copies. Keep that public result unchanged for embedders,
but let the native batch parser consume the same collector's raw buffer. A
binary-body conversion spy must fail against the old path, and exact binary
chunks, finite stdin, start/pipe errors and the compiled package export surface
remain pinned. Header decoding is still necessary; decoding complete binary
bodies is not.

This removes redundant transport allocations, not the reader-local verified
object cache or caller-copy isolation. The cache remains reachable during one
source hydration while its caller builds text. When that caller returns only a
text snapshot and does not retain the reader, the SDK cache becomes collectible;
that says nothing about when the runtime reclaims external memory or returns
RSS. No end-to-end memory-limit cure follows from this allocation change alone.


## Match finite waves to existing demand

An adopter already requesting32independent objects cannot fill the next wave
until the active one completes. The original8-object ceiling serialized four
Git processes for that demand. Raising the finite ceiling to32 removes process
setup while keeping a single active child, immediate singleton flush and the
same framing/hash verification before any result resolves. Injected runners,
source/evidence size policy and per-reader cache lifetime remain unchanged.

The regression now requests67unique objects: waves32/32/3, followed by a
separate singleton. It failed against the original8-object ceiling, and the
existing held-child test independently retains serialization. The larger count
bound is not a source-byte or memory bound.

The retained Athena base9f6e053149b21e07eeae9998b3bd37d4af626cd8 contains8,174paths
and7,967distinct regular blobs. With raw persistence disabled and unchanged
32-reader demand, the first source-bundle pair measured16.07s at8objects versus
5.62s at32. Complete files and native link metadata match the retained baseline
exactly. The reverse-order pair measured5.58s at32 then15.89s at8.
These local cold source-phase measurements do not establish whole-gate
performance or new reader qualification; packaged adoption is a separate
consumer check.
