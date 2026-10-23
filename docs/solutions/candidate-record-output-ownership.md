# Exclude the candidate's own record from scoped input inventories

V26-2381 reproduced a circular dependency: a dynamic check scope enumerated all
tracked files and the delivery-record directory. Preparation and the checks
passed, but staging their generated record changed the scope definition and
directory membership. Portable verification rejected the very execution that
produced the record.

The native recorder owns exactly `deliveryRecordPathFor(config,
candidate.deliverable.digest)`. Scoped identity omits that path from explicit
file inventories and resolved membership. Check-definition, preparation-policy
and portable configuration digests use the same candidate-specific projection.
Membership prefixes remain declared, and no entire record-neutral directory is
excluded. Other records and other declared neutral artifacts remain inputs.
The record itself still goes through the existing portable record and evidence
validators; exclusion from an execution input digest grants no evidence claim.

This is the narrow exception to the earlier record-neutral refresh rule:
declared neutral inputs still invalidate checks, except the native recorder's
own candidate-keyed output. Test entries, dependency inputs, commands, profiles,
obligations, environment declarations and wiring are not projected away.
Callers capturing portable context for a candidate pass its deliverable digest;
without one, the context helper retains the full configuration.

The CLI regression first failed after `record` and staging, with
`portable_scoped_inputs_invalid`. It now passes for dynamic explicit files,
directory membership, and both together. Refresh retains one attempt per
provider. Changing a sibling record still rejects `inputDigest`; changing the
execution profile rejects both `inputDigest` and `profileDigest`. Verification
now names the provider and mismatched digest kind. Existing source/base/wiring
and release invalidation and failed-attempt fences remain required controls.
The combined-inventory case also tampers with the current record's integrity
digest, requires `portable_record_integrity`, restores the original bytes and
verifies successfully with no additional check attempts.
Independent review added a mixed scoped/ordinary-provider case: ordinary check
policy bindings must project the same exact output too. It also exposed that
attempt counts alone cannot prove preparation reuse, because a later reuse
layer can hide a receipt miss. The fixture now requires the preparation reuse
result both after record staging and after a second own-output-only change,
covering receipt evaluation and publication independently.

An adopter that embeds a digest of its raw check definitions in another
provider's command must apply this same exact output contract when constructing
that digest. The native implementation cannot safely rewrite an opaque command
argument. Athena's live-health parent digest is coordinated consumer work, and
its installed wrapper/pre-push proof is separate from these producer fixtures.

This delivery uses focused validation and a draft-PR finish line. It does not
claim the complete repository gate, a published runtime, or installed consumer
integration.
