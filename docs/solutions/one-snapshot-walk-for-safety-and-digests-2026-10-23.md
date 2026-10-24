---
title: Check mutable path safety without hashing mutable bytes
date: 2026-10-23
---

# Check mutable path safety without hashing mutable bytes

The snapshot verifier ran an inventory with no output exclusions to validate
links, then another inventory excluding declared outputs to compare immutable
bytes. The first pass hashed every regular file even though its digest was
discarded. The two passes read immutable source and dependencies twice.

Output exclusion is a digest rule, not a safety rule. The inventory now walks
every non-Git entry once, including mutable output directories, validates links
and entry types, and hashes only immutable regular files. Mutable directory
status propagates to children even when the declared output is an exact path.
The same worker produces the existing canonical digest tuples; no digest
format or execution-profile identity changes. Source-only setup inventories
still exclude dependencies until the final installed-dependency inventory.

The verifier runs that one inventory before its four Git identity reads. All
five children share the existing deadline. Timeout or cancellation kills the
owned child and awaits close before cleanup; dropping the redundant inventory
does not move filesystem work into the parent or replace cancellation with a
promise race.

A private fixture with 153 immutable bytes and 1,024 mutable bytes measured two
inventory processes and 1,330 read bytes before the change, then one process and
153 read bytes after it. The test instruments real worker filesystem calls,
checks the exact immutable read paths, and confirms a mutable symlink was
inspected. Separate cases reject absolute and relative escaping links at output
roots, inside nested output directories, at exact file outputs and beneath a
Git-named output directory. Source/dependency drift, narrowed profile ownership,
Git identity, owned deadlines, interruption and bundled-consumer digest tests
remain part of the focused validation.

These counts describe this bounded fixture. They do not establish an Athena
full-selection median, a cold-cache speedup, or the ticket's under-30-second
setup target. Materialization, dependency installation and cross-worker warm
base reuse remain separate work. Existing reuse is confined to each worker's
snapshot map. A warm seed must never expose shared writable dependency or
output inodes to workers; private copies or qualified copy-on-write clones,
with verified fallbacks, need their own isolation and invalidation evidence.

## Consolidate inventories within setup, not across command boundaries

The follow-on setup change removes another same-phase duplication. With a
dependency command, retain the source-only baseline before it, then produce
source and full digests together after it. Each immutable tuple is hashed once;
the source stream omits paths containing a `node_modules` segment while the
full stream retains them. The combined walk still validates mutable links and
entry types. Without a dependency command, one initial full inventory is the
baseline. Neither case removes the fresh pre-command or post-command check.

The focused fixture proves setup plus pre-command traversal counts of four to
two without dependencies and four to three with dependencies. Its 25 source
bytes are read once without setup, or once before setup and once alongside the
seven dependency bytes afterward. Golden canonical tuple digests remain equal.
The three constant Git ref expressions share one `rev-parse`, with exactly
three expected results; `write-tree` remains separate. Verification therefore
uses two Git processes instead of four under the same deadline. Independent
index, HEAD, candidate-ref and base-ref mutation controls remain in place.

Optional phase observations report materialization, baseline inventory,
dependency execution, combined inventory and verification durations. The
focused fixture consumes these spans alongside real traversal/byte counters;
observer failures cannot affect admission. These measurements are bounded
fixture evidence, not an end-to-end speed claim or a replacement for native
verification after installing the supported release.
