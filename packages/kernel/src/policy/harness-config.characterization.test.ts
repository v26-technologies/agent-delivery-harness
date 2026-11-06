/**
 * CHARACTERIZATION of the existing `HarnessConfig` loader — captured GREEN
 * before any policy-compiler code existed in this module, so the admission
 * projection is later proven against observed behavior rather than remembered
 * behavior. The fixture mirrors the shape of a real adopting configuration
 * (this repository's own gate): one obligation, one provider, consumer-owned
 * identity token, defaults left to the loader.
 *
 * The characterized facts the projection relies on:
 *   - `validateHarnessConfig` accepts the shape and fills the three defaults;
 *   - unknown members reject (`config_unknown_member`) — the loader is a
 *     closed grammar, so embedding it in the policy document keeps the
 *     document closed;
 *   - duplicate obligation ids reject (`config_duplicate_id`);
 *   - a dangling provider reference rejects (`config_dangling_provider`);
 *   - normalization is deterministic: validating twice yields deep-equal
 *     configs, so a projected config can be digest-bound.
 */
import { describe, expect, it } from "vitest";
import { validateHarnessConfig } from "../config.ts";
import { admissionFixture } from "./fixtures.ts";

const blockerCodes = (verdict: ReturnType<typeof validateHarnessConfig>): readonly string[] =>
  verdict.ok ? [] : verdict.blockers.map((blocker) => blocker.code);

describe("characterization: the existing HarnessConfig loader", () => {
  it("accepts the adopter-shaped input and fills the three documented defaults", () => {
    const verdict = validateHarnessConfig(admissionFixture());
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.config.baseRef).toBe("origin/main");
    expect(verdict.config.storageNamespace).toBe("delivery-harness/");
    expect(verdict.config.deliveryRecordVerification).toEqual({ baseMovement: "stale" });
  });

  it("is a closed grammar: an unknown member rejects", () => {
    const verdict = validateHarnessConfig({ ...admissionFixture(), surprise: true });
    expect(blockerCodes(verdict)).toContain("config_unknown_member");
  });

  it("rejects duplicate obligation ids", () => {
    const fixture = admissionFixture();
    const verdict = validateHarnessConfig({ ...fixture, obligations: [...fixture.obligations, fixture.obligations[0]] });
    expect(blockerCodes(verdict)).toContain("config_duplicate_id");
  });

  it("rejects an obligation naming a provider the config never registered", () => {
    const fixture = admissionFixture();
    const broken = { ...fixture.obligations[0], providers: ["nobody"] };
    const verdict = validateHarnessConfig({ ...fixture, obligations: [broken] });
    expect(blockerCodes(verdict)).toContain("config_dangling_provider");
  });

  it("keeps scopedExecution closed while admitting its optional failFast, budgetMs and checkBudgetMs", () => {
    const scoped = { version: "scoped-execution/1", mechanicalProviders: [], profiles: [{ id: "p", dependencyInputs: [], mutableOutputs: [], credentialIdentities: {} }] };
    const unset = validateHarnessConfig({ ...admissionFixture(), scopedExecution: scoped });
    expect(unset.ok && Object.keys(unset.config.scopedExecution!).sort()).toEqual(["mechanicalProviders", "profiles", "version"]);
    const set = validateHarnessConfig({ ...admissionFixture(), scopedExecution: { ...scoped, failFast: true, budgetMs: 900000, checkBudgetMs: 300000 } });
    expect(set.ok && set.config.scopedExecution).toMatchObject({ failFast: true, budgetMs: 900000, checkBudgetMs: 300000 });
    expect(blockerCodes(validateHarnessConfig({ ...admissionFixture(), scopedExecution: { ...scoped, budget: 900000 } }))).toContain("config_invalid_member");
  });

  it("normalizes deterministically — the same input validates to deep-equal configs", () => {
    const first = validateHarnessConfig(admissionFixture());
    const second = validateHarnessConfig(admissionFixture());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.config).toEqual(second.config);
  });
});
