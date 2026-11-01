/** Installed package DATA facts, pure over snapshot-relative ports.
 * Native adapters own public Node resolution, snapshot ownership and origin
 * attestation. Shape/digest validation is not proof of native provenance.
 * This module never authorizes executable package code or whole-check reuse.
 */
import { digestCanonical, isSha256Hex, sha256Hex } from "./digest.ts";
import { MAX_PORTABLE_ARTIFACT_BYTES } from "./portable-limits.ts";

export interface InstalledDataResourceRequest {
  readonly version: "installed-package-data/1";
  readonly id: string;
  readonly issuer: string;
  readonly package: string;
  readonly manifest: "package.json";
  readonly files: readonly string[];
  readonly directories: readonly { readonly path: string; readonly suffix: string }[];
}
export interface InstalledDataResourceContext {
  readonly setupRecipeDigest: string;
  readonly dependencyDigest: string;
  /** Raw tool/platform identity, NOT a HEAD/tree-derived check runtime digest. */
  readonly runtimeDigest: string;
  readonly releaseDigest: string;
  readonly policyDigest: string;
}
export interface InstalledDataResolution {
  readonly mode: "require";
  readonly packageRoot: string;
  readonly manifestPath: string;
  /** Exact issuer-ancestor directory candidates, in native search order. */
  readonly search: readonly { readonly path: string; readonly kind: "absent" | "directory" }[];
}
export interface InstalledDataEntry {
  readonly kind: "file" | "directory" | "absent" | "symlink" | "unsupported";
  readonly physicalPath: string;
  readonly linkTarget: string | null;
}
export interface InstalledDataResourcePorts {
  resolve(request: InstalledDataResourceRequest): Promise<InstalledDataResolution>;
  stat(path: string): Promise<InstalledDataEntry>;
  readFile(path: string): Promise<Uint8Array>;
  listDirectory(path: string): Promise<readonly string[]>;
}
export interface InstalledDataCapturedEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "absent";
  readonly physicalPath: string;
  readonly linkTarget: null;
  readonly bytesBase64: string | null;
  readonly sha256: string | null;
  readonly members: readonly string[] | null;
}
export interface InstalledDataResourceCapture {
  readonly version: "installed-data-capture/1";
  readonly requests: readonly InstalledDataResourceRequest[];
  readonly context: InstalledDataResourceContext;
  readonly resources: readonly {
    readonly requestId: string;
    readonly resolution: InstalledDataResolution;
    readonly entries: readonly InstalledDataCapturedEntry[];
  }[];
  readonly digest: string;
}
export const INSTALLED_DATA_LIMITS = Object.freeze({ requests: 16, entries: 4096, directoryMembers: 1024, rawBytes: 1024 * 1024, serializedBytes: MAX_PORTABLE_ARTIFACT_BYTES });
export type InstalledDataResourceErrorCode = "installed_data_descriptor_invalid" | "installed_data_capture_invalid" | "installed_data_resolution_unsafe" | "installed_data_resource_unsafe" | "installed_data_limit_exceeded" | "installed_data_origin_invalid";
export class InstalledDataResourceError extends Error {
  readonly code: InstalledDataResourceErrorCode;
  constructor(code: InstalledDataResourceErrorCode, message: string) { super(message); this.code = code; this.name = "InstalledDataResourceError"; }
}
const fail = (code: InstalledDataResourceErrorCode, message: string): never => { throw new InstalledDataResourceError(code, message); };
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keys = <const K extends readonly string[]>(v: unknown, expected: K): v is Record<K[number], unknown> => object(v) && Object.keys(v).sort().join("\0") === [...expected].sort().join("\0");
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(v);
const safePath = (v: unknown): v is string => text(v) && !/[\\:*?\[\]{}!#%]/u.test(v) && v.split("/").every(s => s !== "" && s !== "." && s !== "..");
const literalName = (v: unknown): v is string => safePath(v) && !v.includes("/");
const ordered = (v: readonly string[]): boolean => v.every((s, i) => i === 0 || v[i - 1]! < s);
const parents = (p: string): string[] => { const parts = p.split("/"); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")); };
const contextKeys = ["setupRecipeDigest", "dependencyDigest", "runtimeDigest", "releaseDigest", "policyDigest"] as const;
function validateContext(v: unknown): asserts v is InstalledDataResourceContext {
  if (!keys(v, contextKeys) || !Object.values(v).every(isSha256Hex)) fail("installed_data_capture_invalid", "Invalid installed-data context.");
}
export function normalizeInstalledDataResourceRequests(value: unknown): InstalledDataResourceRequest[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > INSTALLED_DATA_LIMITS.requests) fail("installed_data_descriptor_invalid", "Expected a bounded nonempty request list.");
  const ids = new Set<string>();
  for (const r of value) {
    if (!keys(r, ["version", "id", "issuer", "package", "manifest", "files", "directories"]) || r.version !== "installed-package-data/1" || !literalName(r.id) || ids.has(r.id) || !safePath(r.issuer) || r.issuer.split("/").includes("node_modules") || typeof r.package !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(r.package) || r.manifest !== "package.json" || !Array.isArray(r.files) || !Array.isArray(r.directories) || r.files.length + r.directories.length === 0 || r.files.length + r.directories.length > 128) fail("installed_data_descriptor_invalid", "Malformed installed package data request.");
    ids.add(r.id);
    const paths = new Set<string>(["package.json"]);
    for (const file of r.files) {
      if (!safePath(file) || paths.has(file) || file.split("/").includes("node_modules")) fail("installed_data_descriptor_invalid", "Invalid or duplicate resource file.");
      paths.add(file);
    }
    for (const dir of r.directories) {
      if (!keys(dir, ["path", "suffix"]) || !safePath(dir.path) || paths.has(dir.path) || dir.path.split("/").includes("node_modules") || !literalName(dir.suffix)) fail("installed_data_descriptor_invalid", "Invalid directory or literal suffix.");
      paths.add(dir.path);
    }
  }
  // Declaration order is not authority. Search order is authority and stays intact.
  return structuredClone(value as InstalledDataResourceRequest[]).map(r => ({ ...r, files: [...r.files].sort(), directories: [...r.directories].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) })).sort((a, b) => a.id < b.id ? -1 : 1);
}
function expectedSearch(r: InstalledDataResourceRequest): string[] {
  const issuerDir = r.issuer.split("/").slice(0, -1);
  return Array.from({ length: issuerDir.length + 1 }, (_, i) => [...issuerDir.slice(0, issuerDir.length - i), "node_modules", r.package].join("/"));
}
function validateResolution(v: unknown, r: InstalledDataResourceRequest): asserts v is InstalledDataResolution {
  const root = `node_modules/${r.package}`;
  const search = expectedSearch(r);
  if (!keys(v, ["mode", "packageRoot", "manifestPath", "search"]) || v.mode !== "require" || v.packageRoot !== root || v.manifestPath !== `${root}/package.json` || !Array.isArray(v.search) || v.search.length !== search.length) fail("installed_data_resolution_unsafe", "Resource resolution is not the complete owned package search.");
  v.search.forEach((e: unknown, i: number) => {
    if (!keys(e, ["path", "kind"]) || e.path !== search[i] || e.kind !== (i === search.length - 1 ? "directory" : "absent")) fail("installed_data_resolution_unsafe", "Closer, missing or malformed package search witness.");
  });
}
const captureKeys = ["version", "requests", "context", "resources", "digest"] as const;
const entryKeys = ["path", "kind", "physicalPath", "linkTarget", "bytesBase64", "sha256", "members"] as const;
/** Validate retained bytes without consulting an importing host installation. */
export function validateInstalledDataResourceCapture(value: unknown): InstalledDataResourceCapture {
  if (!keys(value, captureKeys) || value.version !== "installed-data-capture/1" || !isSha256Hex(value.digest)) fail("installed_data_capture_invalid", "Invalid capture envelope.");
  const requests = normalizeInstalledDataResourceRequests(value.requests);
  if (digestCanonical(value.requests) !== digestCanonical(requests)) fail("installed_data_capture_invalid", "Noncanonical requests.");
  validateContext(value.context);
  if (!Array.isArray(value.resources) || value.resources.length !== requests.length) fail("installed_data_capture_invalid", "Incomplete resource capture.");
  const capturedResources = value.resources;
  let count = 0, rawBytes = 0;
  requests.forEach((request, i) => {
    const resource = capturedResources[i];
    if (!keys(resource, ["requestId", "resolution", "entries"]) || resource.requestId !== request.id || !Array.isArray(resource.entries)) fail("installed_data_capture_invalid", "Invalid resource capture.");
    validateResolution(resource.resolution, request);
    const entries = new Map<string, InstalledDataCapturedEntry>();
    const paths: string[] = [];
    if (resource.entries.length + count > INSTALLED_DATA_LIMITS.entries) fail("installed_data_limit_exceeded", "Installed data entries exceed limit.");
    for (const entry of resource.entries) {
      if (!keys(entry, entryKeys) || !safePath(entry.path) || entry.physicalPath !== entry.path || entry.linkTarget !== null || !["file", "directory", "absent"].includes(entry.kind as string)) fail("installed_data_resource_unsafe", "Unsafe installed resource metadata.");
      const e = entry as unknown as InstalledDataCapturedEntry;
      paths.push(e.path); entries.set(e.path, e); count++;
      if (e.kind === "file") {
        if (typeof e.bytesBase64 !== "string" || e.bytesBase64.length > 4 * Math.ceil(INSTALLED_DATA_LIMITS.rawBytes / 3) || !isSha256Hex(e.sha256) || e.members !== null) fail("installed_data_capture_invalid", "Missing or oversized file bytes.");
        const bytes = Buffer.from(e.bytesBase64, "base64"); rawBytes += bytes.length;
        if (bytes.toString("base64") !== e.bytesBase64 || sha256Hex(bytes) !== e.sha256) fail("installed_data_capture_invalid", "Noncanonical or changed retained bytes.");
      } else if (e.bytesBase64 !== null || e.sha256 !== null || (e.members !== null && (e.kind !== "directory" || !Array.isArray(e.members) || e.members.length > INSTALLED_DATA_LIMITS.directoryMembers || !e.members.every(literalName) || !ordered(e.members)))) fail("installed_data_capture_invalid", "Invalid directory or absence bytes.");
    }
    if (!ordered(paths)) fail("installed_data_capture_invalid", "Duplicate or unordered resource entries.");
    const required = new Set<string>();
    const need = (path: string, kind?: InstalledDataCapturedEntry["kind"]): InstalledDataCapturedEntry => {
      const e = entries.get(path); required.add(path);
      if (!e || (kind !== undefined && e.kind !== kind)) fail("installed_data_capture_invalid", `Missing resource witness: ${path}`);
      for (const parent of parents(path)) {
        required.add(parent);
        const p = entries.get(parent);
        if (!p || (p.kind !== "directory" && !(e.kind === "absent" && p.kind === "absent"))) fail("installed_data_resource_unsafe", `Invalid resource ancestor: ${parent}`);
      }
      return e;
    };
    for (const search of resource.resolution.search) need(search.path, search.kind);
    const root = resource.resolution.packageRoot;
    need(resource.resolution.manifestPath, "file");
    for (const file of request.files) need(`${root}/${file}`, "file");
    const directoryPaths = new Set<string>();
    for (const dir of request.directories) {
      const path = `${root}/${dir.path}`; directoryPaths.add(path);
      const e = need(path, "directory");
      if (e.members === null) fail("installed_data_capture_invalid", "Missing complete directory membership.");
      for (const name of e.members) if (name.endsWith(dir.suffix)) need(`${path}/${name}`, "file");
    }
    for (const e of entries.values()) if (!required.has(e.path) || (e.members !== null && !directoryPaths.has(e.path))) fail("installed_data_capture_invalid", "Undeclared extra resource witness.");
  });
  if (count > INSTALLED_DATA_LIMITS.entries || rawBytes > INSTALLED_DATA_LIMITS.rawBytes || Buffer.byteLength(JSON.stringify(value)) > INSTALLED_DATA_LIMITS.serializedBytes) fail("installed_data_limit_exceeded", "Installed data exceeds bounded capture limits.");
  const { digest, ...body } = value;
  if (digestCanonical(body) !== digest) fail("installed_data_capture_invalid", "Installed data capture digest mismatch.");
  return structuredClone(value) as unknown as InstalledDataResourceCapture;
}
/** Capture only through invocation-owned ports. No partial facts escape on refusal. */
export async function captureInstalledDataResources(requestsValue: readonly InstalledDataResourceRequest[], context: InstalledDataResourceContext, ports: InstalledDataResourcePorts): Promise<InstalledDataResourceCapture> {
  try {
    const requests = normalizeInstalledDataResourceRequests(requestsValue); validateContext(context);
    let count = 0, rawBytes = 0;
    const resources: InstalledDataResourceCapture["resources"][number][] = [];
    for (const request of requests) {
      const resolution = await ports.resolve(structuredClone(request)); validateResolution(resolution, request);
      const entries = new Map<string, InstalledDataCapturedEntry>();
      const observe = async (path: string, read = false): Promise<InstalledDataCapturedEntry> => {
        const prior = entries.get(path); if (prior && (!read || prior.bytesBase64 !== null)) return prior;
        const info = await ports.stat(path);
        if (!keys(info, ["kind", "physicalPath", "linkTarget"]) || info.physicalPath !== path || info.linkTarget !== null || !["file", "directory", "absent"].includes(info.kind)) fail("installed_data_resource_unsafe", `Unsafe resource path: ${path}`);
        let bytesBase64: string | null = null, sha256: string | null = null;
        if (read) {
          if (info.kind !== "file") fail("installed_data_resource_unsafe", `Resource is not a regular file: ${path}`);
          const bytes = await ports.readFile(path);
          if (!(bytes instanceof Uint8Array)) fail("installed_data_capture_invalid", "Invalid file byte transport.");
          rawBytes += bytes.length; if (rawBytes > INSTALLED_DATA_LIMITS.rawBytes) fail("installed_data_limit_exceeded", "Installed data bytes exceed limit.");
          bytesBase64 = Buffer.from(bytes).toString("base64"); sha256 = sha256Hex(bytes);
        }
        if (!prior && ++count > INSTALLED_DATA_LIMITS.entries) fail("installed_data_limit_exceeded", "Installed data entries exceed limit.");
        const entry: InstalledDataCapturedEntry = { path, kind: info.kind as InstalledDataCapturedEntry["kind"], physicalPath: path, linkTarget: null, bytesBase64, sha256, members: null };
        entries.set(path, entry); return entry;
      };
      const withParents = async (path: string, read = false) => {
        for (const p of parents(path)) await observe(p);
        return observe(path, read);
      };
      for (const e of resolution.search) await withParents(e.path);
      await withParents(resolution.manifestPath, true);
      for (const path of request.files) await withParents(`${resolution.packageRoot}/${path}`, true);
      for (const directory of request.directories) {
        const path = `${resolution.packageRoot}/${directory.path}`;
        const entry = await withParents(path);
        if (entry.kind !== "directory") fail("installed_data_resource_unsafe", `Missing resource directory: ${path}`);
        const members = await ports.listDirectory(path);
        if (!Array.isArray(members) || members.length > INSTALLED_DATA_LIMITS.directoryMembers) fail("installed_data_limit_exceeded", "Resource directory exceeds limit.");
        if (!members.every(literalName) || new Set(members).size !== members.length) fail("installed_data_resource_unsafe", "Unsafe or duplicate directory members.");
        entries.set(path, { ...entry, members: [...members].sort() });
        for (const member of members) if (member.endsWith(directory.suffix)) await withParents(`${path}/${member}`, true);
      }
      resources.push({ requestId: request.id, resolution: structuredClone(resolution), entries: [...entries.values()].sort((a, b) => a.path < b.path ? -1 : 1) });
    }
    const body = { version: "installed-data-capture/1" as const, requests, context: structuredClone(context), resources };
    return validateInstalledDataResourceCapture({ ...body, digest: digestCanonical(body) });
  } catch (error) {
    if (error instanceof InstalledDataResourceError) throw error;
    throw new InstalledDataResourceError("installed_data_capture_invalid", "Native installed-data capture port failed.");
  }
}
export interface InstalledDataAttemptOrigin {
  readonly providerId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly inputDigest: string;
  readonly profileDigest: string;
  readonly source: { readonly headSha: string; readonly treeSha: string };
  readonly status: "passed" | "failed" | "cancelled" | "interrupted";
  readonly superseded: boolean;
}
export interface ResourceApplicabilityProjection {
  readonly version: "resource-applicability/1";
  readonly origin: InstalledDataAttemptOrigin;
  readonly consumerId: string;
  readonly declarationDigest: string;
  readonly sourceApplicabilityDigest: string;
  readonly capture: InstalledDataResourceCapture;
  readonly digest: string;
}
type ProjectionInput = Omit<ResourceApplicabilityProjection, "version" | "digest">;
export interface ResourceApplicabilityCurrent {
  readonly consumerId: string;
  readonly declarationDigest: string;
  readonly sourceApplicabilityDigest: string;
  readonly capture: InstalledDataResourceCapture;
  /** MUST come from current native retained attempt store, not projection JSON. */
  readonly originAttempt: InstalledDataAttemptOrigin | null;
}
function validateOrigin(v: unknown): asserts v is InstalledDataAttemptOrigin {
  if (!keys(v, ["providerId", "runId", "attemptId", "generation", "inputDigest", "profileDigest", "source", "status", "superseded"]) || !text(v.providerId) || !text(v.runId) || !text(v.attemptId) || !Number.isSafeInteger(v.generation) || (v.generation as number) < 1 || !isSha256Hex(v.inputDigest) || !isSha256Hex(v.profileDigest) || !keys(v.source, ["headSha", "treeSha"]) || !Object.values(v.source).every(s => typeof s === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(s)) || v.status !== "passed" || v.superseded !== false) fail("installed_data_origin_invalid", "Only a current passed native attempt can supply resource applicability.");
}
/** Retain this projection INSIDE successful attempt evidence, never as a receipt. */
export function createResourceApplicabilityProjection(input: ProjectionInput): ResourceApplicabilityProjection {
  if (!keys(input, ["origin", "consumerId", "declarationDigest", "sourceApplicabilityDigest", "capture"]) || !text(input.consumerId) || !isSha256Hex(input.declarationDigest) || !isSha256Hex(input.sourceApplicabilityDigest)) fail("installed_data_capture_invalid", "Invalid applicability binding.");
  validateOrigin(input.origin); const capture = validateInstalledDataResourceCapture(input.capture);
  const body = { version: "resource-applicability/1" as const, origin: structuredClone(input.origin), consumerId: input.consumerId, declarationDigest: input.declarationDigest, sourceApplicabilityDigest: input.sourceApplicabilityDigest, capture };
  const projection = { ...body, digest: digestCanonical(body) };
  if (Buffer.byteLength(JSON.stringify(projection)) > INSTALLED_DATA_LIMITS.serializedBytes) fail("installed_data_limit_exceeded", "Applicability projection exceeds artifact size limit.");
  return projection;
}
/** Closed portable validation only; native origin attestation remains the host's job. */
export function validateResourceApplicabilityProjection(value: unknown): ResourceApplicabilityProjection {
  if (!keys(value, ["version", "origin", "consumerId", "declarationDigest", "sourceApplicabilityDigest", "capture", "digest"]) || value.version !== "resource-applicability/1") fail("installed_data_capture_invalid", "Malformed resource applicability projection.");
  const { version: _version, digest, ...input } = value;
  const validated = createResourceApplicabilityProjection(input as unknown as ProjectionInput);
  if (validated.digest !== digest) fail("installed_data_capture_invalid", "Resource applicability digest mismatch.");
  return validated;
}
/** Equality is only resource/source applicability, NEVER passing check evidence.
 * Native caller attests the store and source applicability; these pure functions
 * cannot authenticate self-authored JSON or establish setup ownership.
 */
export function matchResourceApplicabilityProjection(projection: unknown, current: ResourceApplicabilityCurrent): { applicable: boolean; reasons: string[] } {
  try {
    const validated = validateResourceApplicabilityProjection(projection);
    validateOrigin(current.originAttempt);
    if (digestCanonical(current.originAttempt) !== digestCanonical(validated.origin)) return { applicable: false, reasons: ["installed_data_origin_changed"] };
    const capture = validateInstalledDataResourceCapture(current.capture);
    if (current.consumerId !== validated.consumerId || current.declarationDigest !== validated.declarationDigest || current.sourceApplicabilityDigest !== validated.sourceApplicabilityDigest || capture.digest !== validated.capture.digest) return { applicable: false, reasons: ["installed_data_applicability_changed"] };
    return { applicable: true, reasons: [] };
  } catch (error) {
    return { applicable: false, reasons: [error instanceof InstalledDataResourceError ? error.code : "installed_data_capture_invalid"] };
  }
}
