import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { captureScopedCheckInputs, type ScopedInputCapturePorts } from "./checks.ts";
import { digestCanonical } from "./digest.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const paths = Array.from({ length: 80 }, (_, i) => `src/${String(i).padStart(2, "0")}.ts`);
const definition = { version: "scoped-check/1" as const, files: [...paths].reverse(), memberships: [], tests: [], cwd: ".", profile: "local", environment: [] };
function ports(overrides: Partial<ScopedInputCapturePorts> = {}): ScopedInputCapturePorts {
  return {
    command: ["test", "app"], timeoutMs: 1000,
    runtimeDigest: digestCanonical("runtime"), dependencyDigest: digestCanonical("dependency"),
    policyDigest: digestCanonical("policy"), releaseDigest: digestCanonical("release"),
    environment: {}, credentialIdentity: () => null,
    listFiles: async () => [...paths].reverse(), readFile: async file => Buffer.from(file),
    ...overrides,
  };
}

it("matches the serial capture golden including binary, absent, membership and symlink metadata", async () => {
  const inventory = ["tests/z.ts", "src/link", "tests/a.ts", "binary"];
  const scope = { ...definition, files: ["src/link", "absent", "binary"], tests: ["tests/z.ts"], memberships: ["tests/"], environment: [{ name: "FLAG", kind: "flag" as const }] };
  const result = await captureScopedCheckInputs(scope, ports({
    listFiles: async () => inventory,
    readFile: async file => {
      if (file === "binary") await setImmediate();
      return file === "absent" ? null : file === "binary" ? Buffer.from([0, 255, 128, 10]) : Buffer.from(file);
    },
    readMetadata: async file => ({ mode: file === "absent" ? null : "100644", links: file === "src/link" ? [{ path: "src/link", target: "../tests/a.ts" }] : [] }),
    environment: { FLAG: "" },
  }));
  expect(result.files.map(file => file.path)).toEqual(["absent", "binary", "src/link", "tests/a.ts", "tests/z.ts"]);
  expect(result.memberships).toEqual([{ prefix: "tests/", paths: ["tests/a.ts", "tests/z.ts"] }]);
  // Captured from the unchanged serial implementation, not recomputed here.
  expect(result.inputDigest).toBe("7976cf9ed049e0083f6d09495fba2ef9eff01ed5550a462e93d7065f4a332604");
});

it("overlaps reads with a thirty-two-file cap through metadata and retains sorted results", async () => {
  const reads = paths.map(() => deferred<Uint8Array | null>());
  const metadata = paths.map(() => deferred<{ mode: string; links: [] }>());
  const started: string[] = [];
  let active = 0, peak = 0;
  const capture = captureScopedCheckInputs(definition, ports({
    readFile: file => {
      started.push(file); peak = Math.max(peak, ++active);
      return reads[paths.indexOf(file)]!.promise;
    },
    readMetadata: async file => {
      const result = await metadata[paths.indexOf(file)]!.promise;
      active--; return result;
    },
  }));
  await setImmediate();
  expect(started).toEqual(paths.slice(0, 32));
  for (let base = 0; base < paths.length; base += 32) {
    for (let i = Math.min(base + 31, paths.length - 1); i >= base; i--) reads[i]!.resolve(Buffer.from(paths[i]!));
    await setImmediate();
    expect(started).toHaveLength(Math.min(base + 32, paths.length)); // Metadata still owns each worker.
    for (let i = Math.min(base + 31, paths.length - 1); i >= base; i--) metadata[i]!.resolve({ mode: "100644", links: [] });
    await setImmediate();
  }
  const result = await capture;
  expect(peak).toBe(32);
  expect(active).toBe(0);
  expect(result.files.map(file => file.path)).toEqual(paths);
  expect(result).toEqual(await captureScopedCheckInputs(definition, ports({ readMetadata: async () => ({ mode: "100644", links: [] }) })));
});

it("stops dispatch on failure, drains started work, and throws the earliest sorted original error", async () => {
  const reads = paths.map(() => deferred<Uint8Array | null>());
  const started: string[] = [];
  class InputFailure extends Error { readonly code = "portable_tree_unreadable"; }
  const first = new InputFailure("earlier sorted metadata failure");
  const late = new Error("later sorted read failure, observed first");
  let settled = false;
  const outcome = captureScopedCheckInputs(definition, ports({
    readFile: file => { started.push(file); return reads[paths.indexOf(file)]!.promise; },
    readMetadata: async file => { if (file === paths[0]) throw first; return { mode: "100644", links: [] }; },
  })).then(() => ({ ok: true as const }), error => ({ ok: false as const, error })).finally(() => { settled = true; });
  await setImmediate();
  reads[6]!.reject(late);
  await setImmediate();
  expect(settled).toBe(false);
  expect(started).toEqual(paths.slice(0, 32));
  reads[0]!.resolve(Buffer.from(paths[0]!));
  for (let i = 1; i < 31; i++) if (i !== 6) reads[i]!.resolve(Buffer.from(paths[i]!));
  await setImmediate();
  expect(settled).toBe(false); // Last in-flight read must drain before rejection.
  reads[31]!.resolve(Buffer.from(paths[31]!));
  const result = await outcome;
  expect(result).toEqual({ ok: false, error: first });
  if (!result.ok) expect(result.error).toBe(first);
  expect(started).toEqual(paths.slice(0, 32));
});

it("preserves rejection with undefined and drains other reads", async () => {
  const last = deferred<Uint8Array | null>();
  const capture = captureScopedCheckInputs({ ...definition, files: paths.slice(0, 2) }, ports({
    readFile: file => file === paths[0] ? Promise.reject(undefined) : last.promise,
  }));
  const outcome = capture.then(() => "unexpected success", error => error);
  await setImmediate();
  last.resolve(Buffer.from(paths[1]!));
  expect(await outcome).toBeUndefined();
});

it("accepts an empty selection without starting reads", async () => {
  let reads = 0;
  const result = await captureScopedCheckInputs({ ...definition, files: [] }, ports({ readFile: async () => { reads++; throw new Error("unexpected read"); } }));
  expect(result.files).toEqual([]);
  expect(reads).toBe(0);
});
