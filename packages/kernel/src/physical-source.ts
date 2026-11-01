/** Exact immutable candidate materialization, shared by execution and portability. */
import { isPhysicalSourceDefinition, type PhysicalSourceDefinition } from "./config.ts";
import type { CandidateTreeInputReader } from "./portable-inputs.ts";
import { sha256Hex } from "./digest.ts";

export async function capturePhysicalSource(source: PhysicalSourceDefinition, read: CandidateTreeInputReader) {
  if (!isPhysicalSourceDefinition(source)) throw new Error("Invalid physical-source/1 declaration.");
  const files: { file: string; bytes: Uint8Array; mode: string; sha256: string }[] = [];
  let totalBytes = 0;
  for (const file of [...source.files].sort()) {
    const metadata = await read.metadata(file);
    if (!["100644", "100755"].includes(metadata.mode ?? "") || metadata.links.length)
      throw new Error("Physical source must contain regular candidate files without linked ancestors.");
    const bytes = await read(file);
    if (bytes === null || bytes.length > 8 * 1024 * 1024 || (totalBytes += bytes.length) > 64 * 1024 * 1024)
      throw new Error("Physical source is missing or exceeds its byte bounds.");
    files.push({ file, bytes, mode: metadata.mode!, sha256: sha256Hex(bytes) });
  }
  await Promise.all(source.absentInputs.map(async file => {
    const metadata = await read.metadata(file);
    if (metadata.mode !== null || metadata.links.length)
      throw new Error("Required physical source absence is present or linked in the candidate.");
  }));
  return { files, identity: { version: source.version, files: files.map(({ file, mode, sha256 }) => ({ file, mode, sha256 })), absentInputs: [...source.absentInputs].sort() } };
}
