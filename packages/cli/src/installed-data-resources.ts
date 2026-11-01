import { createExecPort, captureInstalledDataResources, normalizeInstalledDataResourceRequests, InstalledDataResourceError, INSTALLED_DATA_LIMITS,
  type InstalledDataResourceContext, type InstalledDataResourceRequest, type InstalledDataResourcePorts } from "@agent-delivery-harness/kernel";
import type { CheckSnapshot } from "./check-snapshot.ts";
import { installedDataWorker } from "./installed-data-worker.ts";

/** Only ScopedChecks may turn these observations into native applicability.
 * This adapter's return alone is not an attestation or passing check result.
 */
export async function captureOwnedInstalledDataResources(
  snapshot: Pick<CheckSnapshot, "rootDir" | "verify">,
  requests: readonly InstalledDataResourceRequest[],
  context: InstalledDataResourceContext,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
) {
  const normalized = normalizeInstalledDataResourceRequests(requests);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new InstalledDataResourceError("installed_data_descriptor_invalid", "Resource observer requires a bounded positive deadline.");
  if (options.signal?.aborted)
    throw new InstalledDataResourceError("installed_data_resource_unsafe", "Resource observation was cancelled before it started.");
  const request = JSON.stringify({ requests: normalized, limits: INSTALLED_DATA_LIMITS });
  if (Buffer.byteLength(request) > 64 * 1024) throw new InstalledDataResourceError("installed_data_limit_exceeded", "Resource request exceeds the bounded observer input.");
  await snapshot.verify({ outputs: [] });
  try {
    const result = await createExecPort().run({ command: process.execPath, args: ["--input-type=module", "--eval", installedDataWorker], cwd: snapshot.rootDir,
      env: { DELIVERY_INSTALLED_DATA_REQUEST: request }, timeoutMs, maxBuffer: INSTALLED_DATA_LIMITS.serializedBytes,
      ...(options.signal ? { signal: options.signal } : {}) });
    if (result.code !== 0) {
      const code = result.stderr.trim();
      if (code === "installed_data_resolution_unsafe" || code === "installed_data_resource_unsafe" || code === "installed_data_limit_exceeded")
        throw new InstalledDataResourceError(code, "Owned installed resource observation refused.");
      throw new InstalledDataResourceError("installed_data_resource_unsafe", "Owned installed resource observation did not complete.");
    }
    let observed: { entries: Record<string, { kind: string; physicalPath: string; linkTarget: string | null; bytesBase64?: string; members?: string[] }>; resolutions: Record<string, unknown> };
    try { observed = JSON.parse(result.stdout); }
    catch { throw new InstalledDataResourceError("installed_data_capture_invalid", "Owned resource observation returned malformed facts."); }
    const ports: InstalledDataResourcePorts = {
      resolve: async request => observed.resolutions[request.id] as Awaited<ReturnType<InstalledDataResourcePorts["resolve"]>>,
      stat: async file => {
        const entry = observed.entries[file];
        if (!entry) throw new InstalledDataResourceError("installed_data_capture_invalid", "Owned resource metadata is incomplete.");
        return { kind: entry.kind, physicalPath: entry.physicalPath, linkTarget: entry.linkTarget } as Awaited<ReturnType<InstalledDataResourcePorts["stat"]>>;
      },
      readFile: async file => {
        const entry = observed.entries[file];
        if (typeof entry?.bytesBase64 !== "string") throw new InstalledDataResourceError("installed_data_capture_invalid", "Owned resource bytes are incomplete.");
        return Buffer.from(entry.bytesBase64, "base64");
      },
      listDirectory: async file => {
        const entry = observed.entries[file];
        if (!Array.isArray(entry?.members)) throw new InstalledDataResourceError("installed_data_capture_invalid", "Owned directory membership is incomplete.");
        return entry.members;
      },
    };
    return await captureInstalledDataResources(normalized, context, ports);
  } finally { await snapshot.verify({ outputs: [] }); }
}
