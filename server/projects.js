import { stat, access, mkdir, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, dirname, basename, join } from 'node:path';

const fail = key => Object.assign(new Error(key), { errorKey: key, status: 400 });
export function projectPath(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || input.includes('\0')) throw fail('error.path');
  const path = input.trim();
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw fail('error.path');
  return resolve(expanded);
}
export async function inspectProject(path) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return { state: 'file', canCreate: false };
    await access(path, constants.R_OK | constants.X_OK);
    return { state: 'directory', canCreate: false };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return { state: 'unavailable', canCreate: false };
    if (error.code === 'ENOTDIR') return { state: 'file', canCreate: false };
    let parent = dirname(path);
    while (true) {
      try {
        if (!(await stat(parent)).isDirectory()) return { state: 'file', canCreate: false };
        await access(parent, constants.W_OK | constants.X_OK);
        return { state: 'missing', canCreate: true };
      } catch (cause) {
        if (cause.code !== 'ENOENT' || dirname(parent) === parent) return { state: 'missing', canCreate: false };
        parent = dirname(parent);
      }
    }
  }
}
export async function suggestProjects(input, recent = []) {
  let path;
  try { path = projectPath(input); } catch { if (input.trim()) return { state: 'invalid', suggestions: [], canCreate: false }; }
  const status = path ? await inspectProject(path) : { state: 'empty', canCreate: false };
  const candidates = new Map();
  const add = (path, source) => { if (!candidates.has(path)) candidates.set(path, source); };
  for (const value of [...new Set(recent)].slice(0, 100)) {
    if (!value || !isAbsolute(value)) continue;
    const candidate = resolve(value);
    if ((!path || candidate.startsWith(path)) && (await inspectProject(candidate)).state === 'directory') add(candidate, 'recent');
  }
  let truncated = false;
  if (path) {
    if (status.state === 'directory') add(path, 'folder');
    const parent = input.trim().endsWith('/') || input.trim() === '~' ? path : dirname(path);
    const prefix = parent === path ? '' : basename(path);
    try {
      const directory = await opendir(parent); let scanned = 0;
      for await (const entry of directory) {
        if (++scanned > 2000) { truncated = true; break; }
        if (!entry.name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) || entry.name.startsWith('.') && !prefix.startsWith('.')) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const candidate = join(parent, entry.name);
        if ((await inspectProject(candidate)).state === 'directory') add(candidate, 'folder');
      }
    } catch { /* The exact path status remains useful when the parent cannot be listed. */ }
  }
  const suggestions = [...candidates].sort(([a, sa], [b, sb]) => (sa === 'recent' ? 0 : 1) - (sb === 'recent' ? 0 : 1) || a.localeCompare(b)).map(([path, source]) => ({ path, source }));
  return { path, ...status, suggestions: suggestions.slice(0, 20), truncated: truncated || suggestions.length > 20 };
}
export async function prepareProject(input, createDirectory = false) {
  const path = projectPath(input), status = await inspectProject(path);
  if (status.state === 'missing' && createDirectory === true && status.canCreate) {
    try { await mkdir(path, { recursive: true }); } catch { throw fail('projects.createFailed'); }
    if ((await inspectProject(path)).state !== 'directory') throw fail('projects.unavailable');
    return path;
  }
  if (status.state !== 'directory') throw fail(`projects.${status.state}`);
  return path;
}
