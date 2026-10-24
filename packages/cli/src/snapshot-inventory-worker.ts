/** Inline so the distributed single-file runtime owns the worker bytes too.
 * Only Node builtins are available; no author code or credentials are loaded. */
export const snapshotInventoryWorker = String.raw`
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const { root, outputs, excludeDependencies, forbidGit, includeSource } = JSON.parse(process.env.DELIVERY_SNAPSHOT_REQUEST);
const entries = [];
const sourceEntries = [];
const record = (relative, tuple) => {
  entries.push(tuple);
  if (includeSource && !relative.split('/').includes('node_modules')) sourceEntries.push(tuple);
};
const inside = target => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const escape = () => { throw { code: 'check_snapshot_escape' }; };
const walk = async (relative, mutable = false) => {
  if (relative === '.git' || (excludeDependencies && relative.split('/').includes('node_modules'))) return;
  // Mutable paths are excluded from the digest, never from the link/type walk.
  // Carry the exclusion through directories, including an exact output path.
  mutable ||= outputs.some(o => o.endsWith('/') ? relative === o.slice(0, -1) || relative.startsWith(o) : relative === o);
  const absolute = path.join(root, relative), stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    const target = await readlink(absolute);
    if (path.isAbsolute(target) || !inside(path.resolve(path.dirname(absolute), target))) escape();
    try { if (!inside(await realpath(absolute))) escape(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!mutable) record(relative, [relative, 'link', target]);
  } else if (stat.isDirectory()) {
    for (const name of (await readdir(absolute)).sort()) await walk(relative ? relative + '/' + name : name, mutable);
  } else if (stat.isFile()) {
    if (!mutable) record(relative, [relative, stat.mode & 0o111, createHash('sha256').update(await readFile(absolute)).digest('hex')]);
  } else escape();
};
try {
  if (forbidGit && await lstat(path.join(root, '.git')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw { code: 'check_snapshot_drift' };
  await walk('');
  // Tuples contain only arrays, strings and permission integers: JSON.stringify
  // has exactly the same bytes as canonical JSON for this restricted shape.
  const digest = tuples => createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
  process.stdout.write(JSON.stringify({ digest: digest(entries), ...(includeSource ? { sourceDigest: digest(sourceEntries) } : {}) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: ['check_snapshot_escape', 'check_snapshot_drift'].includes(error.code) ? error.code : 'check_snapshot_unavailable' }));
  process.exitCode = 1;
}
`;
