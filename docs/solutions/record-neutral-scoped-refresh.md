# Keep scoped execution reusable across record-neutral staging

A refresh must evaluate the previous preparation receipt before invalidating it.
Running repairs first destroys the receipt that could prove those repairs and
mechanics already ran. An explicit refresh now skips repairs only when the
existing receipt proves the same strict validation projection, policy, wiring,
base and workspace. Ordinary preparation still repairs; missing, revoked or
stale receipts still take the execution path. The evaluated capture remains the
baseline for the final drift check.

Full-Git checks retain raw HEAD and tree identity. When staging only configured
record-neutral paths, the executor can match a historical attempt by proving
strict tree equivalence and unchanged base/workspace, then recomputing that
attempt's identity with current source, toolchain, profile, policy and HEAD.
This does not make arbitrary Git consumers file-only or permit reuse after a
HEAD change. Declared neutral files that are also explicit check inputs still
invalidate those checks. Existing matching current-tree attempts take precedence;
failed and interrupted matching attempts remain fences, not reusable success.

The resulting record can describe a newer neutral tree than the original
execution. Portable verification must prove equivalence to the originating
attempt's tree as well as the record's tree, while retaining its existing
bounded record-only HEAD transport proof. Otherwise the gate can correctly reuse
an execution that its own newly produced record cannot verify.

The focused CLI fixture runs real full-Git checks and a repair counter through
prepare, gate, neutral staging, refresh, record, record staging, refresh and
verify. Counter assertions require one repair and one attempt per check for the
whole sequence. Source, base, wiring and installed release changes require new
repairs and attempts. No complete repository gate was run for this optimization.
