/** Inline so the distributed single-file runtime owns the worker bytes too.
 * Only Node builtins are available; no author code or credentials are loaded. */
export const snapshotInventoryWorker = String.raw`
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const { root, outputs, excludeDependencies, forbidGit, includeSource, absentInputs = [] } = JSON.parse(process.env.DELIVERY_SNAPSHOT_REQUEST);
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
// Existing directory coordinates come only from the actual walk, with exact
// bigint filesystem identity. Requested spelling and realpath are not canonical.
const directories = new Map();
const identity = stat => stat.dev.toString() + ':' + stat.ino.toString();
const resolveMissing = async target => {
  if (!inside(target)) escape();
  let resolved = root, key = root, links = 0;
  const pending = path.relative(root, target).split(path.sep);
  while (pending.length) {
    const segment = pending.shift();
    if (!segment || segment === '.') continue;
    if (segment === '..') { resolved = path.dirname(resolved); key = path.dirname(key); }
    else {
      const next = path.join(resolved, segment);
      const info = await lstat(next, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info?.isSymbolicLink()) {
        if (++links > 32) escape();
        const link = await readlink(next);
        if (path.isAbsolute(link)) escape();
        pending.unshift(...link.split(path.sep));
      } else if (info?.isDirectory()) {
        resolved = directories.get(identity(info));
        if (resolved === undefined) escape();
        key = resolved;
      } else {
        resolved = next;
        // No object exists to establish Unicode equivalence. The finite port
        // explicitly refuses non-ASCII missing suffixes rather than guessing a
        // filesystem folding table. Existing distinct directories stay distinct.
        if (info === null && /[^\x00-\x7f]/.test(segment)) throw { code: 'check_snapshot_drift' };
        key = info === null ? path.join(key, segment.toLowerCase()) : resolved;
      }
    }
    if (!inside(resolved)) escape();
  }
  return { absolute: resolved, key };
};
// Retain the already-walked links so output authority can follow directory
// referents without recursively following links or weakening inventory digests.
const aliases = [];
let protectedNames;
const protectOutputAlias = resolved => {
  const name = path.relative(root, resolved.key);
  for (const a of protectedNames) {
    if (name === '' || name === a || name.startsWith(a + '/') || a.startsWith(name + '/')) throw { code: 'check_snapshot_drift' };
  }
};
const protectOutputReachability = async () => {
  protectedNames = await Promise.all(absentInputs.map(async absent => path.relative(root, (await resolveMissing(path.join(root, absent))).key)));
  const reachable = [];
  for (const output of outputs) reachable.push(await resolveMissing(path.join(root, output.replace(/\/$/, ''))));
  for (const target of reachable) protectOutputAlias(target);
  // Each collected link is expanded at most once. Its fully resolved target
  // is writable whenever its lexical location is below an output referent.
  const pending = new Set(aliases);
  for (let index = 0; index < reachable.length; index++) {
    const directory = reachable[index].absolute;
    for (const alias of pending) {
      const relative = path.relative(directory, alias.absolute);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      pending.delete(alias);
      const resolved = await resolveMissing(alias.absolute);
      protectOutputAlias(resolved);
      reachable.push(resolved);
    }
  }
};
const walk = async (relative, mutable = false) => {
  if (relative === '.git' || (excludeDependencies && relative.split('/').includes('node_modules'))) return;
  // Mutable paths are excluded from the digest, never from the link/type walk.
  // Carry the exclusion through directories, including an exact output path.
  mutable ||= outputs.some(o => o.endsWith('/') ? relative === o.slice(0, -1) || relative.startsWith(o) : relative === o);
  const absolute = path.join(root, relative), stat = await lstat(absolute, { bigint: true });
  if (stat.isSymbolicLink()) {
    const target = await readlink(absolute);
    if (path.isAbsolute(target) || !inside(path.resolve(path.dirname(absolute), target))) escape();
    try { if (!inside(await realpath(absolute))) escape(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (absentInputs.length) aliases.push({ absolute });
    if (!mutable) record(relative, [relative, 'link', target]);
  } else if (stat.isDirectory()) {
    directories.set(identity(stat), absolute);
    for (const name of (await readdir(absolute)).sort()) await walk(relative ? relative + '/' + name : name, mutable);
  } else if (stat.isFile()) {
    if (!mutable) record(relative, [relative, Number(stat.mode & 0o111n), createHash('sha256').update(await readFile(absolute)).digest('hex')]);
  } else escape();
};
try {
  for (const absent of absentInputs) {
    let relative = '';
    for (const part of absent.split('/')) {
      relative = relative ? relative + '/' + part : part;
      const info = await lstat(path.join(root, relative)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info === null) break;
      if (info.isSymbolicLink() || relative === absent || !info.isDirectory()) throw { code: 'check_snapshot_drift' };
    }
  }
  if (forbidGit && await lstat(path.join(root, '.git')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw { code: 'check_snapshot_drift' };
  await walk('');
  if (absentInputs.length) await protectOutputReachability();
  // Tuples contain only arrays, strings and permission integers: JSON.stringify
  // has exactly the same bytes as canonical JSON for this restricted shape.
  const digest = tuples => createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
  process.stdout.write(JSON.stringify({ digest: digest(entries), ...(includeSource ? { sourceDigest: digest(sourceEntries) } : {}) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: ['check_snapshot_escape', 'check_snapshot_drift'].includes(error.code) ? error.code : 'check_snapshot_unavailable' }));
  process.exitCode = 1;
}
`;
