/**
 * The config loader's falsification table.
 *
 * Written before `config.ts` existed, and structured as the table rather than
 * as prose: one case per invariant, each mutating a single member of one shared
 * valid fixture. A loader that reported nothing would fail every row; a loader
 * that reported everything would fail the happy-path row and the negative
 * controls that sit beside the interesting cases.
 *
 * Two properties are asserted about the table itself, because a falsification
 * table nobody checks for completeness rots into decoration:
 *
 *   - every finding code the loader declares is produced by at least one row
 *     (the coverage assertion at the bottom), and
 *   - the partition rows cover all three of its failure modes — a code in the
 *     universe classified in neither list, a code classified in both, and a
 *     code classified in a list that has left the universe entirely.
 *
 * The identity-token rule is a biconditional, so it gets two rows: claiming the
 * `deliverable-tree/v1` token without its narration set, and declaring that
 * narration set under some other token. One row would leave half the rule
 * unenforced and the suite would not notice.
 */
import { describe, expect, it } from "vitest";
import { BlockedError, GATE_STRUCTURAL_FINDING_CODES, renderBlockers, type Blocker } from "./blockers.ts";
import {
  CONFIG_FINDING_CODES,
  DEFAULT_BASE_REF,
  DEFAULT_STORAGE_NAMESPACE,
  DELIVERABLE_TREE_V1,
  DELIVERABLE_TREE_V1_NARRATION_SET,
  defineHarnessConfig,
  deriveDeliveryRecordPath,
  emittableFindingCodes,
  matchesNeutralSet,
  isInstalledDataConsumerDefinition,
  validateHarnessConfig,
  type HarnessConfig,
  type HarnessConfigInput,
} from "./config.ts";

/**
 * Every row below feeds `defineHarnessConfig` a value the authoring type would
 * reject — that is the point of the row — so the type is asserted at this one
 * seam rather than at each call site.
 */
const define = (input: unknown): HarnessConfig => defineHarnessConfig(input as HarnessConfigInput);

// ── The shared valid fixture ───────────────────────────────────────────────

/**
 * A structural code that is waivable, and one that is not, chosen by hand so
 * the partition rows below can move a *known* code across the boundary rather
 * than whichever code happens to sit first in the registry.
 */
const WAIVABLE_STRUCTURAL = [
  "review_evidence_missing",
  "stale_evidence",
  "evidence_not_green",
  "unresolved_actionable_findings",
] as const;

const NON_WAIVABLE_STRUCTURAL = [
  "ambiguous_records",
  "malformed_record",
  "unknown_provider",
  "live_provider_missing",
  "ambiguous_live_provider",
  "live_provider_failed",
  "resolution_not_allowed",
] as const;

const PROVIDER_CODE = "blocking-finding";

/**
 * The fixture enumerates the structural codes rather than deriving them from
 * `GATE_STRUCTURAL_FINDING_CODES`. Deriving them would make the fixture track
 * the registry silently, and the stale-entry row exists precisely to prove that
 * a registry change is *not* absorbed silently.
 */
const validInput = () => ({
  gateId: "example.pr-validation",
  baseRef: "origin/main",
  storageNamespace: "delivery-harness/",
  acceptedEnvelopeSpecs: ["delivery-evidence/1"],
  identityVersions: ["deliverable-tree/v1"],
  computingIdentityVersion: "deliverable-tree/v1",
  reviewNeutral: [
    { prefix: "docs/reports/" },
    { prefix: "docs/solutions/" },
    { prefix: "telemetry/delivery-runs/" },
  ],
  recordNeutral: [{ prefix: "docs/reports/" }],
  pathClassification: {
    generated: [{ kind: "prefix", value: "generated/" }],
    test: [{ kind: "glob", value: "**/*.test.ts" }],
    lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
  },
  sensitivePaths: [{ id: "auth", patterns: [{ kind: "prefix", value: "packages/auth/" }] }],
  activationThreshold: 25,
  providers: [{ id: "example.reviewer", findingCodes: [PROVIDER_CODE] }],
  agentEnvSignals: ["EXAMPLE_AGENT"],
  ciPolicies: [{ id: "example-ci", requiredEnv: [{ variable: "CI", equals: "true" }] }],
  ciPolicyEnvKey: "DELIVERY_HARNESS_CI_POLICY",
  preparationWiringPaths: ["harness.config.ts"],
  obligations: [
    {
      id: "review.green",
      activation: { kind: "relevant_change" },
      freshness: "exact_candidate",
      providers: ["example.reviewer"],
      acceptedPayloadSpecs: ["review.green/1"],
      allowedResolutionKinds: ["satisfied_evidence", "waived", "delegated", "not_applicable"],
      humanWaiverAllowed: true,
      minimumAttestationLevel: "self",
      ciDelegationPolicyIds: ["example-ci"],
      remediation: {
        default: [{ id: "run-review", kind: "command", command: ["npx", "review"], summary: "Run a review." }],
        byCode: {
          stale_evidence: [{ id: "re-review", kind: "manual_action", summary: "Re-run the review on the current candidate." }],
        },
      },
      waivableCodes: [...WAIVABLE_STRUCTURAL, PROVIDER_CODE],
      nonWaivableCodes: [...NON_WAIVABLE_STRUCTURAL],
    },
  ],
  deliveryRecordPath: "docs/reports/delivery-record.json",
  deliveryRecordVerification: { baseMovement: "stale" },
});

type MutableInput = ReturnType<typeof validInput>;

describe("preparation commands", () => {
  it("accepts an ordered argv list and preserves empty arguments", () => {
    const preparationCommands = [{ id: "typecheck", command: ["npm", "run", "typecheck", ""], timeoutMs: 120000 }];
    expect(define({ ...validInput(), preparationCommands }).preparationCommands).toEqual(preparationCommands);
    expect(define({ ...validInput(), preparationCommands: [] }).preparationCommands).toEqual([]);
  });

  it.each([
    null, {}, [null], [{ id: "check", command: [], timeoutMs: 1 }],
    [{ id: "check", command: "npm run check", timeoutMs: 1 }],
    [{ id: "check", command: [" "], timeoutMs: 1 }],
    [{ id: "check", command: ["node", "bad\0argument"], timeoutMs: 1 }],
    [{ id: "check", command: ["node"], timeoutMs: 0 }],
    [{ id: "check", command: ["node"], timeoutMs: 1.5 }],
    [{ id: "check", command: ["node"], timeoutMs: 2147483648 }],
    [{ id: "check", command: ["node"] }],
    [{ id: "check", command: ["node"], timeoutMs: 1, shell: true }],
    [{ id: "check", command: ["node"], timeoutMs: 1 }, { id: "check", command: ["node"], timeoutMs: 1 }],
  ])("rejects malformed preparation commands %#", (preparationCommands) => {
    expect(validateHarnessConfig({ ...validInput(), preparationCommands }).ok).toBe(false);
  });
});

describe("repository review charters", () => {
  const lens = { lensId: "repo.security", reviewerId: "security-reviewer", charterPath: ".agents/agents/security.md" };
  it("includes declared charter bytes in preparation wiring without changing omitted configuration", () => {
    expect(define(validInput())).not.toHaveProperty("additionalReviewLenses");
    const config = define({ ...validInput(), additionalReviewLenses: [lens] });
    expect(config.additionalReviewLenses).toEqual([lens]);
    expect(config.preparationWiringPaths).toContain(lens.charterPath);
  });
  it.each(["lensId", "reviewerId"])("rejects duplicate %s instead of silently dropping a required reviewer", (field) => {
    const other = { lensId: "repo.other", reviewerId: "other-reviewer", charterPath: ".agents/agents/other.md", [field]: lens[field as keyof typeof lens] };
    expect(codesFor({ ...validInput(), additionalReviewLenses: [lens, other] })).toContain("config_duplicate_id");
  });
  it.each(["../outside.md", "/outside.md", "docs/", "bad\\path.md", ""])("rejects invalid charter path %j", (charterPath) => {
    expect(codesFor({ ...validInput(), additionalReviewLenses: [{ ...lens, charterPath }] })).toContain("config_invalid_member");
  });
});

/**
 * Deep-clones the fixture and hands it to a mutation. The mutation sees an
 * untyped draft on purpose: most rows corrupt the fixture into a shape the
 * authoring type forbids, which is exactly the input the loader must reject.
 */
function withInput(mutate: (input: any) => void): unknown {
  const input = structuredClone(validInput());
  mutate(input);
  return input;
}

/** Codes observed anywhere in this file, for the coverage assertion at the end. */
const observedCodes = new Set<string>();

function blockersFor(input: unknown): readonly Blocker[] {
  const result = validateHarnessConfig(input);
  if (result.ok) return [];
  for (const blocker of result.blockers) observedCodes.add(blocker.code);
  return result.blockers;
}

function codesFor(input: unknown): string[] {
  return blockersFor(input).map((blocker) => blocker.code);
}

/** Asserts the named finding, and that the fixture is otherwise still sound. */
function expectOnly(input: unknown, code: string): readonly Blocker[] {
  const blockers = blockersFor(input);
  const codes = blockers.map((blocker) => blocker.code);
  expect(codes, `expected ${code}, got ${JSON.stringify(blockers, null, 2)}`).toContain(code);
  expect([...new Set(codes)], `expected only ${code}`).toEqual([code]);
  return blockers;
}

// ── Happy path ─────────────────────────────────────────────────────────────

describe("a sound config", () => {
  it("loads", () => {
    const result = validateHarnessConfig(validInput());
    expect(result.ok ? [] : result.blockers).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is returned frozen, with exactly the declared members", () => {
    const config = define(validInput());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.keys(config).sort()).toEqual(Object.keys(validInput()).sort());
  });

  it("accepts an optional provider command as a non-shell argv array", () => {
    const config = define(
      withInput((input) => {
        input.providers[0]!.command = ["review-provider", "--stdio"];
      }),
    );
    expect(config.providers[0]?.command).toEqual(["review-provider", "--stdio"]);
  });

  it("rejects an empty provider command", () => {
    expectOnly(
      withInput((input) => {
        input.providers[0]!.command = [];
      }),
      "config_invalid_member",
    );
  });

  it("defaults the three members that carry defaults, and nothing else", () => {
    const input = structuredClone(validInput()) as Partial<MutableInput>;
    delete input.baseRef;
    delete input.storageNamespace;
    delete input.deliveryRecordVerification;
    const config = define(input);
    expect(config.baseRef).toBe(DEFAULT_BASE_REF);
    expect(config.storageNamespace).toBe(DEFAULT_STORAGE_NAMESPACE);
    expect(config.deliveryRecordVerification).toEqual({ baseMovement: "stale" });
  });

  it("reports every other absent member rather than inventing one", () => {
    const input = structuredClone(validInput()) as Partial<MutableInput>;
    delete input.gateId;
    delete input.preparationWiringPaths;
    const codes = codesFor(input);
    // Set equality, not a count of the code we expect. An omitted member that
    // also reported as invalid would tell the author to fix a value they never
    // wrote, and a filtered assertion would never notice.
    expect(new Set(codes)).toEqual(new Set(["config_missing_member"]));
    expect(codes).toHaveLength(2);
  });

  it("reports an obligation's absent id once, not as an invalid value too", () => {
    const input = structuredClone(validInput()) as MutableInput;
    delete (input.obligations[0] as Partial<Record<string, unknown>>)["id"];
    const codes = codesFor(input);
    expect(new Set(codes)).toEqual(new Set(["config_missing_member"]));
    expect(codes).toHaveLength(1);
  });

  it("keeps a diagnostic readable through the blocker redaction chain", () => {
    // `ciPolicyEnvKey` ends in a credential word, and a finding rendered as
    // `member: detail` is exactly the assignment shape the redaction chain
    // hunts for. Unquoted, the operator is told a key is [REDACTED] instead of
    // being told which member is missing.
    const input = structuredClone(validInput()) as Partial<MutableInput>;
    delete input.ciPolicyEnvKey;
    const blockers = blockersFor(input);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.summary).toContain("is required");
    expect(renderBlockers(blockers)).not.toContain("[REDACTED]");
  });

  it("throws a BlockedError carrying every blocker when a config is unsound", () => {
    const broken = withInput((input) => {
      input.obligations = [];
      input.deliveryRecordPath = "src/not-neutral.json";
    });
    let thrown: unknown;
    try {
      define(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BlockedError);
    const blockers = (thrown as BlockedError).blockers;
    expect(blockers.length).toBeGreaterThanOrEqual(2);
    for (const blocker of blockers) {
      expect(blocker.source.kind).toBe("config");
      expect(blocker.remediations.length).toBeGreaterThan(0);
      observedCodes.add(blocker.code);
    }
  });
});

// ── Closed grammar ─────────────────────────────────────────────────────────

describe("the closed grammar", () => {
  it("rejects an unknown top-level member", () => {
    expectOnly(
      withInput((input) => {
        (input as Record<string, unknown>)["runRoot"] = "/tmp/harness";
      }),
      "config_unknown_member",
    );
  });

  it("rejects an unknown obligation member", () => {
    expectOnly(
      withInput((input) => {
        (input.obligations[0] as unknown as Record<string, unknown>)["autoApprove"] = true;
      }),
      "config_unknown_member",
    );
  });

  it("rejects an unknown member on a nested matcher", () => {
    expectOnly(
      withInput((input) => {
        (input.reviewNeutral[0] as Record<string, unknown>)["regex"] = "^docs/";
      }),
      "config_unknown_member",
    );
  });

  it("rejects a value outside a closed enumeration", () => {
    expectOnly(
      withInput((input) => {
        (input.obligations[0] as Record<string, unknown>)["freshness"] = "eventually";
      }),
      "config_invalid_member",
    );
  });

  it("rejects a member of the wrong type", () => {
    expectOnly(
      withInput((input) => {
        (input as Record<string, unknown>)["activationThreshold"] = "25";
      }),
      "config_invalid_member",
    );
  });

  it("rejects a malformed identifier", () => {
    expectOnly(
      withInput((input) => {
        input.providers[0]!.id = "Example Reviewer";
      }),
      "config_invalid_member",
    );
  });

  it("rejects an input that is not an object at all", () => {
    expect(codesFor(null)).toEqual(["config_invalid_member"]);
    expect(codesFor([])).toEqual(["config_invalid_member"]);
  });
});

// ── Unique ids ─────────────────────────────────────────────────────────────

describe("id uniqueness", () => {
  it("rejects duplicate obligation ids", () => {
    expectOnly(
      withInput((input) => {
        input.obligations.push(structuredClone(input.obligations[0]!));
      }),
      "config_duplicate_id",
    );
  });

  it("rejects duplicate provider ids", () => {
    expectOnly(
      withInput((input) => {
        input.providers.push({ id: "example.reviewer", findingCodes: [PROVIDER_CODE] });
      }),
      "config_duplicate_id",
    );
  });

  it("rejects duplicate CI policy ids", () => {
    expectOnly(
      withInput((input) => {
        input.ciPolicies.push({ id: "example-ci", requiredEnv: [{ variable: "OTHER", equals: "1" }] });
      }),
      "config_duplicate_id",
    );
  });

  it("rejects duplicate sensitive-path group ids", () => {
    expectOnly(
      withInput((input) => {
        input.sensitivePaths.push({ id: "auth", patterns: [{ kind: "prefix", value: "other/" }] });
      }),
      "config_duplicate_id",
    );
  });
});

// ── Dangling references ────────────────────────────────────────────────────

describe("dangling references", () => {
  it("rejects an obligation naming an unregistered provider", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.providers = ["example.reviewer", "ghost.provider"];
      }),
      "config_dangling_provider",
    );
  });

  it("rejects an obligation naming an undeclared CI policy", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.ciDelegationPolicyIds = ["ghost-ci"];
      }),
      "config_dangling_ci_policy",
    );
  });

  it("rejects an obligation that accepts no payload spec, because no claim can ever bind to it", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.acceptedPayloadSpecs = [];
      }),
      "config_no_payload_spec",
    );
  });
});

// ── The activation binding and the provider quantifier ────────────────────

describe("the per-obligation activation binding and provider quantifier", () => {
  it("loads all four members", () => {
    const result = validateHarnessConfig(
      withInput((input) => {
        input.obligations[0]!.activation = {
          kind: "relevant_change",
          sensitiveGroupIds: ["auth"],
          relevantBinaryChangeActivates: false,
          relevantZeroLineChangeActivates: false,
        };
        input.obligations[0]!.providerPolicy = "existential";
      }),
    );
    expect(result.ok ? [] : result.blockers).toEqual([]);
    if (!result.ok) return;
    const obligation = result.config.obligations[0]!;
    expect(obligation.activation).toEqual({
      kind: "relevant_change",
      sensitiveGroupIds: ["auth"],
      relevantBinaryChangeActivates: false,
      relevantZeroLineChangeActivates: false,
    });
    expect(obligation.providerPolicy).toBe("existential");
  });

  it("keeps the members absent when the author omits them: absence is the widened, fail-closed policy", () => {
    const config = define(validInput());
    const obligation = config.obligations[0]!;
    expect(obligation.activation).toEqual({ kind: "relevant_change" });
    expect("sensitiveGroupIds" in obligation.activation).toBe(false);
    expect("providerPolicy" in obligation).toBe(false);
  });

  it("loads an empty binding, which opts the obligation out of the sensitive signal entirely", () => {
    const result = validateHarnessConfig(
      withInput((input) => {
        input.obligations[0]!.activation = { kind: "relevant_change", sensitiveGroupIds: [] };
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a binding naming a group no sensitive-path entry declares", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.activation = { kind: "relevant_change", sensitiveGroupIds: ["auth", "ghost-group"] };
      }),
      "config_dangling_sensitive_group",
    );
  });

  it("accepts a binding whose every id is declared — the negative control for the dangling row", () => {
    const result = validateHarnessConfig(
      withInput((input) => {
        input.obligations[0]!.activation = { kind: "relevant_change", sensitiveGroupIds: ["auth"] };
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown activation member — Athena's spelling of the binding included", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.activation = { kind: "relevant_change", sensitiveScenarioIds: ["auth"] };
      }),
      "config_unknown_member",
    );
  });

  it("rejects a non-boolean opt-out, a malformed group id, and a quantifier outside the enumeration", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.activation = { kind: "relevant_change", relevantBinaryChangeActivates: "no" };
      }),
      "config_invalid_member",
    );
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.activation = { kind: "relevant_change", relevantZeroLineChangeActivates: 0 };
      }),
      "config_invalid_member",
    );
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.activation = { kind: "relevant_change", sensitiveGroupIds: ["Not An Id"] };
      }),
      "config_invalid_member",
    );
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.providerPolicy = "any";
      }),
      "config_invalid_member",
    );
  });
});

// ── The waiver biconditional ───────────────────────────────────────────────

describe("the waiver flag and the allowed resolution kinds", () => {
  it("rejects humanWaiverAllowed without the waived resolution kind", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.allowedResolutionKinds = ["satisfied_evidence", "delegated", "not_applicable"];
      }),
      "config_waiver_policy_mismatch",
    );
  });

  it("rejects the waived resolution kind without humanWaiverAllowed", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.humanWaiverAllowed = false;
      }),
      "config_waiver_policy_mismatch",
    );
  });
});

// ── Remediation catalogs ───────────────────────────────────────────────────

describe("remediation catalogs", () => {
  it("rejects an empty default catalog", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.remediation.default = [];
      }),
      "config_empty_remediation",
    );
  });

  it("rejects an empty per-code catalog", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.remediation.byCode = { stale_evidence: [] };
      }),
      "config_empty_remediation",
    );
  });

  it("rejects a per-code catalog keyed by a code the obligation cannot emit", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.remediation.byCode = {
          never_emitted: [{ id: "x", kind: "manual_action", summary: "Do something." }],
        };
      }),
      "config_stale_finding_code",
    );
  });
});

// ── The exact three-way partition ──────────────────────────────────────────

describe("the finding-code partition", () => {
  it("computes the emittable universe as the structural registry plus the obligation's providers", () => {
    const config = define(validInput());
    const universe = emittableFindingCodes(config, "review.green");
    expect([...universe].sort()).toEqual([...GATE_STRUCTURAL_FINDING_CODES, PROVIDER_CODE].sort());
  });

  it("refuses to compute a universe for an obligation the config does not declare", () => {
    // Returning the structural set for an unknown id would make a typo look
    // like a policy: a caller partitioning against it would classify the right
    // number of codes for the wrong obligation.
    const config = define(validInput());
    expect(() => emittableFindingCodes(config, "not.declared")).toThrow(/not\.declared/);
  });

  it("rejects a code in the universe that neither list classifies", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.waivableCodes = (input.obligations[0]!.waivableCodes as string[]).filter(
          (code: string) => code !== "stale_evidence",
        );
      }),
      "config_unclassified_finding_code",
    );
  });

  it("rejects a code both lists classify", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.nonWaivableCodes = [...input.obligations[0]!.nonWaivableCodes, "stale_evidence"];
      }),
      "config_double_classified_finding_code",
    );
  });

  it("rejects a classified code that has left the universe — a stale entry after a provider is removed", () => {
    expectOnly(
      withInput((input) => {
        // The provider stays registered repo-wide; the obligation stops using
        // it, so its code is no longer emittable for this obligation.
        input.obligations[0]!.providers = [];
      }),
      "config_stale_finding_code",
    );
  });

  it("rejects a classified code that was never in any universe", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.nonWaivableCodes = [...input.obligations[0]!.nonWaivableCodes, "invented-code"];
      }),
      "config_stale_finding_code",
    );
  });
});

// ── Neutral sets ───────────────────────────────────────────────────────────

describe("the two neutral sets", () => {
  it("rejects a record-neutral matcher outside the review-neutral set", () => {
    expectOnly(
      withInput((input) => {
        // The record path keeps a covered matcher, so this row falsifies the
        // subset rule alone rather than the double-neutrality rule with it.
        input.recordNeutral = [{ prefix: "docs/reports/" }, { prefix: "delivery/records/" }];
      }),
      "config_record_neutral_not_subset",
    );
  });

  it("accepts a record-neutral matcher narrower than a review-neutral one", () => {
    const result = validateHarnessConfig(
      withInput((input) => {
        input.recordNeutral = [{ prefix: "docs/reports/records/" }];
        input.deliveryRecordPath = "docs/reports/records/delivery-record.json";
      }),
    );
    expect(result.ok ? [] : result.blockers).toEqual([]);
  });

  it("treats an explicitly empty suffix as no suffix at all", () => {
    // The subset test and the set-equality test read a suffix differently — one
    // compares it, the other keys on it — so an empty string that means "no
    // suffix" to an author must mean that to both, or a matcher that is plainly
    // a subset reports as if it were not.
    const result = validateHarnessConfig(
      withInput((input) => {
        input.reviewNeutral = [
          { prefix: "docs/reports/", suffix: "" },
          { prefix: "docs/solutions/" },
          { prefix: "telemetry/delivery-runs/" },
        ];
        input.recordNeutral = [{ prefix: "docs/reports/" }];
      }),
    );
    expect(result.ok ? [] : result.blockers.map((blocker) => blocker.code)).toEqual([]);
  });

  it("rejects a delivery-record path that is review-neutral but not record-neutral", () => {
    expectOnly(
      withInput((input) => {
        // docs/solutions/ is review-neutral (so it leaves the identity alone)
        // but not record-neutral, which is the load-bearing half of the rule.
        input.deliveryRecordPath = "docs/solutions/delivery-record.json";
      }),
      "config_delivery_record_not_neutral",
    );
  });

  it("rejects a delivery-record path neutral to neither set", () => {
    expectOnly(
      withInput((input) => {
        input.deliveryRecordPath = "packages/kernel/delivery-record.json";
      }),
      "config_delivery_record_not_neutral",
    );
  });

  // ── The DERIVED path is what gets written ────────────────────────────────
  //
  // Records are candidate-keyed: the digest is spliced into the configured path,
  // and it is that derived path that lands in the tree. A configured path can be
  // double-neutral while its derived form is not — and then the write the config
  // authorized is a write that moves the identity it attests. Each row below is a
  // config the loader accepts on the configured path alone.

  it("rejects a record path whose derived form escapes an exact-file neutral matcher", () => {
    expectOnly(
      withInput((input) => {
        // Matchers naming the file exactly: the configured path matches by
        // prefix, but `record--<digest>.json` does not start with `record.json`.
        input.reviewNeutral = [...input.reviewNeutral, { prefix: "delivery/record.json" }];
        input.recordNeutral = [{ prefix: "delivery/record.json" }];
        input.identityVersions = ["delivery-harness-tree/v1"];
        input.computingIdentityVersion = "delivery-harness-tree/v1";
        input.deliveryRecordPath = "delivery/record.json";
      }),
      "config_delivery_record_not_neutral",
    );
  });

  it("rejects a record path whose derived form escapes a prefix+suffix neutral matcher", () => {
    expectOnly(
      withInput((input) => {
        // The suffix pins the basename, which the splice necessarily changes.
        input.reviewNeutral = [...input.reviewNeutral, { prefix: "delivery/", suffix: "record.json" }];
        input.recordNeutral = [{ prefix: "delivery/", suffix: "record.json" }];
        input.identityVersions = ["delivery-harness-tree/v1"];
        input.computingIdentityVersion = "delivery-harness-tree/v1";
        input.deliveryRecordPath = "delivery/record.json";
      }),
      "config_delivery_record_not_neutral",
    );
  });

  it("accepts an extensionless dotfile record path, whose derived form keeps its name", () => {
    // The third shape the derived-path check was written for. It escaped only
    // because a leading dot was read as an extension separator, which left an
    // empty stem and put the record at the repository root as
    // `--<digest>.deliveryrecord`. With the derivation corrected the digest
    // appends instead, the name is preserved, and the config is sound — so the
    // right assertion here is that it loads. The loader would still have caught
    // it: point the derivation back at the bug and this row goes red.
    const result = validateHarnessConfig(
      withInput((input) => {
        input.reviewNeutral = [...input.reviewNeutral, { prefix: ".deliveryrecord" }];
        input.recordNeutral = [{ prefix: ".deliveryrecord" }];
        input.identityVersions = ["delivery-harness-tree/v1"];
        input.computingIdentityVersion = "delivery-harness-tree/v1";
        input.deliveryRecordPath = ".deliveryrecord";
      }),
    );
    expect(result.ok ? [] : result.blockers.map((blocker) => blocker.code)).toEqual([]);
    expect(deriveDeliveryRecordPath(".deliveryrecord", "a".repeat(64))).toBe(`.deliveryrecord--${"a".repeat(64)}`);
  });

  // ── The probe must not be able to *be* the digest ────────────────────────
  //
  // The derived path is checked with a stand-in digest, and the splice position
  // is digest-independent — so the prefix side of a matcher is safe under any
  // probe. A suffix is not. A suffix that reaches backwards past the extension
  // into the digest region is asserting something about digest *characters*, and
  // an all-zeros probe satisfies exactly the suffixes made of zeros. The loader
  // then accepts a config whose real records — written under real digests — land
  // outside the neutral set: the write moves the identity it attests, `verify`
  // reports the record missing, and the loop cannot be closed at all.

  it("rejects a record path whose neutral suffix reaches into the digest region", () => {
    expectOnly(
      withInput((input) => {
        // Derived under an all-zeros probe: `record--00…00.json`, which ends
        // with "00.json" and passes. Under a real digest it ends with that
        // digest's own last two characters, and almost never with "00".
        input.reviewNeutral = [...input.reviewNeutral, { prefix: "telemetry/runs/", suffix: "00.json" }];
        input.recordNeutral = [{ prefix: "telemetry/runs/", suffix: "00.json" }];
        input.identityVersions = ["delivery-harness-tree/v1"];
        input.computingIdentityVersion = "delivery-harness-tree/v1";
        input.deliveryRecordPath = "telemetry/runs/record00.json";
      }),
      "config_delivery_record_not_neutral",
    );
  });

  it("rejects an extensionless record path whose neutral suffix reaches into the digest region", () => {
    expectOnly(
      withInput((input) => {
        // The same trap without an extension: the derived path ends in the raw
        // digest, so a suffix of "000" is a claim about the digest's last three
        // characters that only the zeros probe satisfies.
        input.reviewNeutral = [...input.reviewNeutral, { prefix: "telemetry/runs/", suffix: "000" }];
        input.recordNeutral = [{ prefix: "telemetry/runs/", suffix: "000" }];
        input.identityVersions = ["delivery-harness-tree/v1"];
        input.computingIdentityVersion = "delivery-harness-tree/v1";
        input.deliveryRecordPath = "telemetry/runs/record000";
      }),
      "config_delivery_record_not_neutral",
    );
  });

  it("rejects a dotfile record path whose derived form leaves an exact-name matcher", () => {
    expectOnly(
      withInput((input) => {
        // The same dotfile shape under a matcher that pins the full name: the
        // splice necessarily changes it, so the derived write escapes.
        input.reviewNeutral = [...input.reviewNeutral, { prefix: "delivery/", suffix: ".record" }];
        input.recordNeutral = [{ prefix: "delivery/", suffix: ".record" }];
        input.identityVersions = ["delivery-harness-tree/v1"];
        input.computingIdentityVersion = "delivery-harness-tree/v1";
        input.deliveryRecordPath = "delivery/.record";
      }),
      "config_delivery_record_not_neutral",
    );
  });

  it("still accepts the directory-prefix shape, whose derived form stays neutral", () => {
    const result = validateHarnessConfig(
      withInput((input) => {
        input.deliveryRecordPath = "docs/reports/delivery-record.json";
      }),
    );
    expect(result.ok ? [] : result.blockers.map((blocker) => blocker.code)).toEqual([]);
  });
});

// ── Candidate-keyed path derivation ────────────────────────────────────────

describe("deriveDeliveryRecordPath", () => {
  const DIGEST = "a".repeat(64);

  it("splices the digest before a real extension", () => {
    expect(deriveDeliveryRecordPath("docs/reports/record.json", DIGEST)).toBe(`docs/reports/record--${DIGEST}.json`);
  });

  it("appends when there is no extension", () => {
    expect(deriveDeliveryRecordPath("docs/reports/record", DIGEST)).toBe(`docs/reports/record--${DIGEST}`);
  });

  it("does not read a leading dot as an extension separator", () => {
    // The bug this pins: `.deliveryrecord` read as stem "" + extension
    // ".deliveryrecord" derives `--<digest>.deliveryrecord` at the repo root.
    expect(deriveDeliveryRecordPath(".deliveryrecord", DIGEST)).toBe(`.deliveryrecord--${DIGEST}`);
  });

  it("does not read a dotfile's leading dot as a separator inside a directory", () => {
    expect(deriveDeliveryRecordPath("delivery/.record", DIGEST)).toBe(`delivery/.record--${DIGEST}`);
  });

  it("keeps a dotfile's real extension", () => {
    expect(deriveDeliveryRecordPath("delivery/.record.json", DIGEST)).toBe(`delivery/.record--${DIGEST}.json`);
  });

  it("keys distinct deliverables to distinct paths", () => {
    expect(deriveDeliveryRecordPath("docs/reports/r.json", "a".repeat(64))).not.toBe(
      deriveDeliveryRecordPath("docs/reports/r.json", "b".repeat(64)),
    );
  });
});

// ── Identity ───────────────────────────────────────────────────────────────

describe("identity versions", () => {
  it("rejects a computing identity version the recorder does not accept", () => {
    expectOnly(
      withInput((input) => {
        // The review-neutral set moves off the v1 narration set at the same
        // time, so this row falsifies the membership rule alone: leaving the
        // narration set in place would also trip the token biconditional and
        // the row would stop naming one rule.
        input.computingIdentityVersion = "delivery-harness-tree/v1";
        input.reviewNeutral = [{ prefix: "docs/reports/" }, { prefix: "delivery/records/" }];
        input.recordNeutral = [{ prefix: "docs/reports/" }];
      }),
      "config_identity_version_not_accepted",
    );
  });

  it("rejects the deliverable-tree/v1 token under a review-neutral set that is not its narration set", () => {
    expectOnly(
      withInput((input) => {
        input.reviewNeutral = [...input.reviewNeutral, { prefix: "delivery/records/" }];
        input.recordNeutral = [{ prefix: "delivery/records/" }];
        input.deliveryRecordPath = "delivery/records/record.json";
      }),
      "config_identity_token_requires_v1_neutral_set",
    );
  });

  it("rejects the deliverable-tree/v1 narration set under some other identity token", () => {
    expectOnly(
      withInput((input) => {
        input.identityVersions = ["delivery-harness-tree/v1"];
        input.computingIdentityVersion = "delivery-harness-tree/v1";
      }),
      "config_v1_neutral_set_requires_v1_token",
    );
  });

  it("exports the narration set the v1 token is defined over", () => {
    expect([...DELIVERABLE_TREE_V1_NARRATION_SET]).toEqual([
      { prefix: "docs/reports/" },
      { prefix: "docs/solutions/" },
      { prefix: "telemetry/delivery-runs/" },
    ]);
    expect(DELIVERABLE_TREE_V1).toBe("deliverable-tree/v1");
  });
});

// ── Scope invariants ───────────────────────────────────────────────────────

describe("v1 scope", () => {
  it("rejects a gate with no obligations, because it would admit everything", () => {
    expectOnly(
      withInput((input) => {
        input.obligations = [];
      }),
      "config_no_obligations",
    );
  });

  it("rejects a minimum attestation level above self", () => {
    const blockers = expectOnly(
      withInput((input) => {
        input.obligations[0]!.minimumAttestationLevel = "provider-signed";
      }),
      "config_unsupported_attestation_level",
    );
    expect(blockers[0]!.summary.toLowerCase()).toContain("self");
  });
});

// ── Aggregation ────────────────────────────────────────────────────────────

describe("aggregation", () => {
  it("reports every violation in one result", () => {
    const codes = codesFor(
      withInput((input) => {
        input.obligations[0]!.humanWaiverAllowed = false;
        input.obligations[0]!.ciDelegationPolicyIds = ["ghost-ci"];
        input.obligations[0]!.remediation.default = [];
        input.deliveryRecordPath = "src/record.json";
        input.computingIdentityVersion = "deliverable-tree/v2";
      }),
    );
    expect(new Set(codes)).toEqual(
      new Set([
        "config_waiver_policy_mismatch",
        "config_dangling_ci_policy",
        "config_empty_remediation",
        "config_delivery_record_not_neutral",
        "config_identity_version_not_accepted",
        // The narration set is untouched while the token moves off v1, so the
        // biconditional's second direction fires here too.
        "config_v1_neutral_set_requires_v1_token",
      ]),
    );
  });

  it("reports every shape violation in one result", () => {
    const codes = codesFor(
      withInput((input) => {
        (input as Record<string, unknown>)["runRoot"] = "/tmp";
        (input as Record<string, unknown>)["activationThreshold"] = "25";
        delete (input as Partial<MutableInput>).gateId;
      }),
    );
    expect(new Set(codes)).toEqual(new Set(["config_unknown_member", "config_invalid_member", "config_missing_member"]));
  });
});

// ── The neutral matcher primitive ──────────────────────────────────────────

describe("matchesNeutralSet", () => {
  const set = [{ prefix: "docs/" }, { prefix: "telemetry/", suffix: ".json" }] as const;

  it("matches on a prefix", () => {
    expect(matchesNeutralSet(set, "docs/reports/x.md")).toBe(true);
  });

  it("respects the prefix boundary", () => {
    expect(matchesNeutralSet(set, "docs-internal/x.md")).toBe(false);
  });

  it("requires the suffix when one is declared", () => {
    expect(matchesNeutralSet(set, "telemetry/x.json")).toBe(true);
    expect(matchesNeutralSet(set, "telemetry/x.md")).toBe(false);
  });

  it("does not treat a backslash path as neutral", () => {
    expect(matchesNeutralSet(set, "docs\\reports\\x.md")).toBe(false);
  });
});

describe("string-list and code-universe invariants", () => {
  it.each(["acceptedEnvelopeSpecs", "identityVersions", "preparationWiringPaths", "agentEnvSignals"] as const)("rejects duplicate %s entries", (member) => {
    const input = validInput();
    input[member].push(input[member][0]!);
    const blockers = expectOnly(input, "config_duplicate_id");
    expect(blockers[0]!.summary).toContain(member);
  });

  it("rejects repeated wiring paths before additional lens paths are deduplicated", () => {
    const input = validInput();
    input.preparationWiringPaths.push(input.preparationWiringPaths[0]!);
    expectOnly({ ...input, additionalReviewLenses: [] }, "config_duplicate_id");
  });

  it("rejects duplicate provider finding codes", () => {
    const input = validInput();
    input.providers[0]!.findingCodes.push(PROVIDER_CODE);
    expectOnly(input, "config_duplicate_id");
  });

  it.each(["waivableCodes", "nonWaivableCodes"] as const)("rejects duplicate %s entries", (member) => {
    const input = validInput();
    const codes: string[] = input.obligations[0]![member];
    codes.push(codes[0]!);
    expectOnly(input, "config_duplicate_id");
  });

  it.each(GATE_STRUCTURAL_FINDING_CODES)("rejects provider code %s colliding with the structural registry", (code) => {
    const input = validInput();
    input.providers[0]!.findingCodes.push(code);
    expectOnly(input, "config_code_collision");
  });

  it("accepts an explicit empty preparation wiring set for minimal consumers", () => {
    const input = validInput();
    input.preparationWiringPaths = [];
    const result = validateHarnessConfig(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.preparationWiringPaths).toEqual([]);
  });
});

// ── Table completeness ─────────────────────────────────────────────────────

describe("the falsification table", () => {
  it("produces every finding code the loader declares", () => {
    const missing = CONFIG_FINDING_CODES.filter((code) => !observedCodes.has(code));
    expect(missing, `finding codes no row in this table produces: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares no finding code twice", () => {
    expect([...CONFIG_FINDING_CODES]).toEqual([...new Set(CONFIG_FINDING_CODES)]);
  });
});

// A compile-time check that the exported config type is what the readers see.
const _typeWitness: (config: HarnessConfig) => string = (config) => config.gateId;
void _typeWitness;

it("rejects dependency namespace mutable outputs in scoped profiles", () => {
  const input = {
    ...validInput(),
    scopedExecution: {
      version: "scoped-execution/1",
      mechanicalProviders: [],
      profiles: [{ id: "installed-data", gitContext: "full", dependencyInputs: [], mutableOutputs: ["reports/font-result.json"], credentialIdentities: {} }],
    },
  };
  expect(define(input).scopedExecution?.profiles[0]?.mutableOutputs).toEqual(["reports/font-result.json"]);
  for (const output of ["node_modules", "node_modules/", "node_modules/@fonts/demo/wght.css", "node_modules/@fonts/demo/files/", "packages/app/node_modules", "packages/app/node_modules/@fonts/demo/files/"]) {
    const invalid = { ...input, scopedExecution: { ...input.scopedExecution, profiles: [{ ...input.scopedExecution.profiles[0]!, mutableOutputs: [output] }] } };
    expectOnly(invalid, "config_invalid_member");
    expect(() => define(invalid)).toThrow(BlockedError);
  }
});

function installedConsumerInput() {
  const source={version:'scoped-check/1',files:['reader.ts'],tests:['font.test.ts'],memberships:[],cwd:'.',profile:'fixture',environment:[]};
  const installedData={version:'installed-data-consumer/1',consumerId:'font',requests:[{version:'installed-package-data/1',id:'font',issuer:'font.test.ts',package:'font',manifest:'package.json',files:['font.woff2'],directories:[]}],source,guards:{'reader.ts':'a'.repeat(64),'font.test.ts':'b'.repeat(64)}};
  const base=validInput();return {...base,providers:[{id:'check.font',findingCodes:[PROVIDER_CODE],check:{command:['node','test.js'],timeoutMs:5000,scope:source,installedData}}],obligations:[{...base.obligations[0]!,id:'font.passed',providers:['check.font'],freshness:'exact_candidate',acceptedPayloadSpecs:['checks.passed/1']}],scopedExecution:{version:'scoped-execution/1',profiles:[{id:'fixture',gitContext:'full',dependencyInputs:[],mutableOutputs:[],credentialIdentities:{}}],mechanicalProviders:[] as string[]}};
}
it('installed consumer accepts one guarded scoped declaration and preserves field-absent legacy',()=>{
  const input=installedConsumerInput();expect(isInstalledDataConsumerDefinition(input.providers[0]!.check.installedData)).toBe(true);expect(validateHarnessConfig(input),JSON.stringify(validateHarnessConfig(input))).toMatchObject({ok:true});expect(define(input).providers[0]?.check).toHaveProperty('installedData',input.providers[0]!.check.installedData);
  const provider=input.providers[0]!;
  const withData={...provider.check.installedData,source:{...provider.check.installedData.source,files:[...provider.check.installedData.source.files,'assets/cedi.woff2']}};
  expect(define({...input,providers:[{...provider,check:{...provider.check,installedData:withData}}]}).providers[0]?.check?.installedData?.source.files).toContain('assets/cedi.woff2');
  const {installedData,...check}=input.providers[0]!.check;expect(define({...input,providers:[{...input.providers[0]!,check}]}).providers[0]?.check).not.toHaveProperty('installedData');
});
it('installed consumer rejects malformed borrowed unguarded and mismatched declarations',()=>{
  const input=installedConsumerInput();const provider=input.providers[0]!,declaration=provider.check.installedData;
  for(const patch of [{version:'unknown'},{consumerId:'x'.repeat(129)},{extra:true},{guards:{}},{guards:{...declaration.guards,'other.ts':'a'.repeat(64)}},{guards:{'reader.ts':'a'.repeat(64)}},{guards:{...declaration.guards,'reader.ts':'BAD'}},{requests:[{...declaration.requests[0]!,issuer:'other.test.ts'}]},{requests:[{...declaration.requests[0]!,files:['../outside']}]},{source:{...declaration.source,profile:'other'}},{source:{...declaration.source,cwd:'app'}},{source:{...declaration.source,environment:[{name:'FLAG',kind:'flag'}]}}])expectOnly({...input,providers:[{...provider,check:{...provider.check,installedData:{...declaration,...patch}}}]},'config_invalid_member');
  const {scope,...check}=provider.check;expectOnly({...input,providers:[{...provider,check}]},'config_invalid_member');
});
it('installed consumer rejects multiple resource providers mechanical preparation and live review obligations',()=>{
  const input=installedConsumerInput();expectOnly({...input,providers:[...input.providers,{...input.providers[0]!,id:'check.second'}]},'config_invalid_member');
  expectOnly({...input,scopedExecution:{...input.scopedExecution,mechanicalProviders:['check.font']}},'config_invalid_member');
  for(const patch of [{freshness:'live'},{acceptedPayloadSpecs:['review.green/1']},{acceptedPayloadSpecs:['checks.passed/1','review.green/1']}])expectOnly({...input,obligations:[{...input.obligations[0]!,...patch}]},'config_invalid_member');
});

it('installed consumer applicability protocol requires cold checks fallback and rejects ordinary providers',()=>{
 const input=installedConsumerInput();const specs=['checks.passed/1','installed-data.applicable/1'];
 expect(define({...input,obligations:[{...input.obligations[0]!,acceptedPayloadSpecs:specs}]}).obligations[0]?.acceptedPayloadSpecs).toEqual(specs);
 expectOnly({...input,obligations:[{...input.obligations[0]!,acceptedPayloadSpecs:['installed-data.applicable/1']}]},'config_invalid_member');
 const {installedData,...check}=input.providers[0]!.check;
 expectOnly({...input,providers:[{...input.providers[0]!,check}],obligations:[{...input.obligations[0]!,acceptedPayloadSpecs:specs}]},'config_invalid_member');
 expect(codesFor({...input,providers:[{...input.providers[0]!,check}],obligations:[{...input.obligations[0]!,acceptedPayloadSpecs:['checks.passed/1','checks.passed/1']}]})).toEqual(expect.arrayContaining(['config_invalid_member','config_duplicate_id']));
});
