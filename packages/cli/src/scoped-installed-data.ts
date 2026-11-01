/** CLI error projection over the shared immutable source binding. */
import { captureInstalledDataBinding as capture, InstalledDataSourceError } from "@agent-delivery-harness/kernel";
import { CheckSnapshotError } from "./check-snapshot.ts";
export type { InstalledDataSourceTree } from "@agent-delivery-harness/kernel";
export async function captureInstalledDataBinding(...args: Parameters<typeof capture>) {
  try { return await capture(...args); }
  catch (error) { if (error instanceof InstalledDataSourceError) throw new CheckSnapshotError(error.code, error.message); throw error; }
}
