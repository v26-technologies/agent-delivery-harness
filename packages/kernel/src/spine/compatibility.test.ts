/**
 * COMPATIBILITY CHARACTERIZATION for the managed-delivery contract spine.
 *
 * The spine (the contract families under this directory) is built on top of
 * contract surfaces the harness already ships: the delivery-evidence/1
 * envelope and payload spec tokens, the honest L0 attestation wording, the
 * tracked delivery-record parser, and RFC 8785 canonical JSON with SHA-256
 * digest discipline. Per the characterization-first posture, this suite
 * freezes that existing behavior as executable fixtures BEFORE the spine adds
 * anything, so a spine change that drifts any of it goes red here, not in an
 * adopter.
 *
 * The pinned `agent-skills` identities come from the composition baseline
 * artifact (`qualifications/composition-baseline.json`): the workflow-graph,
 * archive, and provider-rail schemas are PINNED by digest — never re-authored
 * here — and the spine's composition module must carry exactly these values.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalBytes, canonicalize } from "../canonical.ts";
import { digestCanonical, isSha256Hex, sha256Hex } from "../digest.ts";
import { ATTESTATION_LABEL, DELIVERY_RECORD_VERSION, parseDeliveryRecord } from "../delivery-record.ts";
import {
  CONFORMING_ATTESTATION_LEVEL,
  DELIVERY_EVIDENCE_1,
  REVIEW_GREEN_1,
  REVIEW_GREEN_2,
  SUPPORTED_ENVELOPE_SPECS,
  SUPPORTED_PAYLOAD_SPECS,
} from "../validator/codes.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

describe("envelope and payload spec tokens", () => {
  it("are exactly the shipped set — the spine adds families, never re-versions these", () => {
    expect(DELIVERY_EVIDENCE_1).toBe("delivery-evidence/1");
    expect(REVIEW_GREEN_1).toBe("review.green/1");
    expect(REVIEW_GREEN_2).toBe("review.green/2");
    expect([...SUPPORTED_ENVELOPE_SPECS]).toEqual(["delivery-evidence/1"]);
    // V26-3028 adds opt-in resource applicability; existing execution/review tokens retain their meaning.
    expect([...SUPPORTED_PAYLOAD_SPECS]).toEqual(["review.green/1", "review.green/2", "checks.passed/1", "installed-data.applicable/1"]);
    expect(DELIVERY_RECORD_VERSION).toBe("delivery-record/2");
  });
});

describe("L0 attestation wording", () => {
  it("is unchanged, verbatim", () => {
    expect(CONFORMING_ATTESTATION_LEVEL).toBe("self");
    expect(ATTESTATION_LABEL).toBe(
      "self / workspace-scoped — process discipline and freshness, not provenance",
    );
  });
});

describe("tracked delivery-record parsing", () => {
  const recordsDir = path.join(REPO_ROOT, "delivery", "records");
  const recordFiles = readdirSync(recordsDir).filter((name) => name.endsWith(".json"));

  it("accepts every tracked record in this repository verbatim", () => {
    expect(recordFiles.length).toBeGreaterThan(0);
    for (const name of recordFiles) {
      const result = parseDeliveryRecord(readFileSync(path.join(recordsDir, name), "utf8"));
      expect(result.ok, name).toBe(true);
      if (result.ok) expect(result.record.attestation.level).toBe("self");
    }
  });

  it("rejects an unsupported version token as malformed, never skips it", () => {
    const first = recordFiles[0] as string;
    const parsed = JSON.parse(readFileSync(path.join(recordsDir, first), "utf8")) as Record<string, unknown>;
    const mutated = { ...parsed, version: "delivery-record/999" };
    const result = parseDeliveryRecord(JSON.stringify(mutated));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0].code).toBe("delivery_record_malformed");
  });

  it("rejects an invented claim outcome outside the resolution universe", () => {
    const first = recordFiles[0] as string;
    const parsed = JSON.parse(readFileSync(path.join(recordsDir, first), "utf8")) as {
      claims: Record<string, unknown>[];
    } & Record<string, unknown>;
    const mutated = {
      ...parsed,
      claims: [{ ...parsed.claims[0], outcome: "rubber_stamped" }],
    };
    const result = parseDeliveryRecord(JSON.stringify(mutated));
    expect(result.ok).toBe(false);
  });
});

interface CanonVector {
  readonly name: string;
  readonly value: unknown;
  readonly canonical: string;
  readonly sha256: string;
}

describe("cross-language canonicalization fixtures", () => {
  const doc = JSON.parse(readFileSync(path.join(HERE, "vectors", "canonicalization.json"), "utf8")) as {
    vectors: readonly CanonVector[];
  };

  it("reproduces every golden canonical form and digest byte for byte", () => {
    expect(doc.vectors.length).toBeGreaterThanOrEqual(7);
    for (const vector of doc.vectors) {
      expect(canonicalize(vector.value), vector.name).toBe(vector.canonical);
      expect(sha256Hex(canonicalBytes(vector.value)), vector.name).toBe(vector.sha256);
      expect(digestCanonical(vector.value), vector.name).toBe(vector.sha256);
    }
  });

  it("keeps the product-trust label wording digestable and unchanged", () => {
    const vector = doc.vectors.find((entry) => entry.name === "product-trust-label");
    expect(vector).toBeDefined();
    expect((vector?.value as Record<string, unknown>)["productTrust"]).toBe("local-digest / operator-pinned");
  });

  it("still rejects the inputs RFC 8785 has no canonical form for", () => {
    expect(() => canonicalize({ bad: Number.POSITIVE_INFINITY })).toThrowError(CanonicalizationError);
    expect(() => canonicalize({ bad: "\uD800" })).toThrowError(CanonicalizationError);
    expect(() => canonicalize({ bad: undefined })).toThrowError(CanonicalizationError);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => canonicalize(circular)).toThrowError(CanonicalizationError);
  });
});

describe("the pinned agent-skills identities", () => {
  const baseline = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "qualifications", "composition-baseline.json"), "utf8"),
  ) as {
    repositories: {
      agentSkills: {
        baselineCommit: string;
        coreQualification: Record<string, unknown>;
        providerQualification: { protocolVersion: string };
        provenanceLockSha256: string;
      };
    };
  };
  const skills = baseline.repositories.agentSkills;

  it("pin the workflow-graph/result and provider-rail schemas by digest, not by re-authoring", () => {
    expect(skills.baselineCommit).toBe("0de253bc3c5a6837590602b42194b9a7de2b3296");
    expect(skills.coreQualification["releaseId"]).toBe("core-v1");
    expect(skills.coreQualification["workflowGraphSha256"]).toBe(
      "49630e23374f0375cb7d019ea024bcd5ea0c284feb8dc124b393b60f6e8d9aa7",
    );
    expect(skills.coreQualification["archiveSha256"]).toBe(
      "25dd462a818cf2134c08be27181ba123adfa74bf2c367884a411b8b664523fc6",
    );
    expect(isSha256Hex(skills.coreQualification["metadataSha256"])).toBe(true);
    expect(isSha256Hex(skills.provenanceLockSha256)).toBe(true);
    expect(skills.providerQualification.protocolVersion).toBe("delivery-provider-rails/1");
  });
});
