---
title: A child that exits before its output drains
date: 2026-10-01
---

# A child that exits before its output drains

Two rows failed on macOS and passed on hosted Linux:
`packages/cli/src/scoped-checks.test.ts` › "exports bounded redacted diagnostics"
and the bundled-runtime qualification row in `scripts/build-product-runtime.test.ts`.
The exported output tail ended inside a raw credential prefix, cut at almost
exactly 8 KiB. That looked like capture reading the stream in 8 KiB chunks and
redacting each chunk on its own.

It was not that. The exec port joins every chunk before decoding, and redaction
already ran over the whole capture before the 4000-character bound. The child
itself emitted only 8192 bytes. Both fixtures ran
`console.log(<about 11 KB>); process.exit(n)`. Node writes to a spawned child's
`stdio: "pipe"` socketpair asynchronously on macOS, and that socket's send
buffer is 8192 bytes (`sysctl net.local.stream.sendspace`). `process.exit`
discards whatever is still queued. Linux writes to pipes synchronously, so the
same fixture emits everything there.

Counting what the child delivered settled it. Spawn with the same stdio shape
and add up the `data` chunks: `process.exit` gave `[8192]`, while
`process.exitCode` gave `[8192, 2839]`, the full output.

## What it hid

The truncation was in the fixture, but the leak was real. Any writer that
exits, is killed, or is clipped partway through writing ends its stream inside a
credential, and full-value redaction cannot match a prefix. #172 made the
redactor mask any credential prefix ending a stream, and interrupted prefixes of
eight or more characters. It also redacts each stream before they are joined.

## The rule for fixtures

A fixture that must emit more than 8 KiB and then fail does not call
`console.log` followed by `process.exit`. Either:

- set `process.exitCode = n` and let the process end naturally, which drains
  pending writes; or
- write synchronously with `require("fs").writeSync(1, …)` before
  `process.exit`.

When a row disagrees between macOS and Linux and the output stops near 8 KiB,
measure what the child actually emitted before suspecting capture.
