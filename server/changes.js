import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';

const exec = promisify(execFile);
const MAX_BYTES = 1024 * 1024;
const error = (key, message, status = 400) => Object.assign(new Error(message), { errorKey: key, status });

export function diffStats(diff = '') {
  let added = 0, removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

export function summarizeCodexChanges(turns, cwd) {
  const files = new Map();
  const seen = new Set();
  for (const turn of turns) for (const item of turn.items || []) {
    if (item.type !== 'fileChange' || item.status !== 'completed' || seen.has(item.id)) continue;
    seen.add(item.id);
    for (const change of item.changes || []) {
      const path = change.kind?.move_path || change.path;
      const key = isAbsolute(path) ? path : resolve(cwd, path);
      const previousKey = isAbsolute(change.path) ? change.path : resolve(cwd, change.path);
      let file = files.get(key);
      if (!file && change.kind?.move_path && files.has(previousKey)) {
        file = files.get(previousKey); files.delete(previousKey);
      }
      file ||= { path: relative(cwd, key) || path, patches: [], added: 0, removed: 0 };
      file.path = relative(cwd, key) || path;
      file.kind = change.kind?.type || 'update';
      if (change.kind?.move_path) { file.kind = 'rename'; file.previousPath = change.path; }
      const stats = diffStats(change.diff);
      file.added += stats.added; file.removed += stats.removed;
      file.patches.push({ itemId: item.id, turnId: turn.id, diff: change.diff || '', kind: change.kind?.type, ...stats });
      files.set(key, file);
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function codexChanges(codex, threadId) {
  const { thread } = await codex.rpc('thread/read', { threadId });
  const turns = [];
  let cursor, bytes = 0, truncated = false;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await codex.rpc('thread/turns/list', { threadId, limit: 50, itemsView: 'full', sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
    for (const turn of page.data) {
      const items = (turn.items || []).filter(item => item.type === 'fileChange');
      bytes += JSON.stringify(items).length;
      if (bytes > 4 * MAX_BYTES) { truncated = true; break; }
      turns.push({ id: turn.id, items });
    }
    if (truncated) break;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { files: summarizeCodexChanges(turns.reverse(), thread.cwd), truncated: truncated || Boolean(cursor), cwd: thread.cwd };
}

async function git(cwd, args, allowTruncated = false) {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
    const options = { cwd, timeout: 10000, maxBuffer: MAX_BYTES, encoding: 'utf8', env };
    const base = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', '-c', 'diff.submodule=short', '-c', 'status.submoduleSummary=false'];
    // --no-ext-diff/--no-textconv do not disable clean/process filters: even status can execute them.
    let keys = '';
    try { keys = (await exec('git', [...base, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], options)).stdout; }
    catch (cause) { if (cause.code !== 1) throw cause; }
    const filters = [...new Set(keys.split('\0').filter(Boolean))].flatMap(key => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`]);
    const { stdout } = await exec('git', [...base, ...filters, ...args], options);
    return { text: stdout, truncated: false };
  } catch (cause) {
    if (allowTruncated && cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { text: cause.stdout || '', truncated: true };
    if (cause.code === 'ENOENT') throw error('changes.gitUnavailable', 'Git or the project folder is unavailable.');
    if (cause.stderr?.includes('not a git repository')) throw error('changes.notRepo', 'This project is not a Git repository.');
    throw error('changes.gitFailed', 'Git could not read the project status or diff.');
  }
}

export function parseGitStatus(text) {
  const parts = text.split('\0'), files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]; if (!entry) continue;
    const indexStatus = entry[0], worktreeStatus = entry[1], path = entry.slice(3);
    const renamed = ['R', 'C'].includes(indexStatus) || ['R', 'C'].includes(worktreeStatus);
    const previousPath = renamed ? parts[++i] : undefined;
    files.push({ path, indexStatus, worktreeStatus, ...(previousPath ? { previousPath } : {}), untracked: indexStatus === '?', kind: indexStatus === '?' ? 'untracked' : renamed ? 'rename' : [indexStatus, worktreeStatus].includes('D') ? 'delete' : indexStatus === 'A' ? 'add' : 'update' });
  }
  return files;
}

export async function gitChanges(cwd) {
  const { text } = await git(cwd, ['rev-parse', '--show-toplevel']);
  const root = text.trimEnd();
  // Nested repositories have their own filter configuration. Inspect gitlink commits, not their worktrees.
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty']);
  return { root, files: parseGitStatus(status.text) };
}

export async function gitFileDiff(cwd, path) {
  const status = await gitChanges(cwd);
  const file = status.files.find(file => file.path === path);
  if (!file) throw error('changes.fileGone', 'This file is no longer in the Git changes.', 409);
  if (file.untracked) {
    const target = resolve(status.root, path);
    const rel = relative(status.root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw error('changes.fileGone', 'Invalid file path.');
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) return { sections: [], note: 'changes.nonText' };
    const actual = await realpath(target), actualRoot = await realpath(status.root);
    const actualRelative = relative(actualRoot, actual);
    if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw error('changes.fileGone', 'File is outside the repository.');
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw error('changes.fileGone', 'File changed while opening it.', 409);
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) return { sections: [], note: 'changes.nonText' };
      return { sections: [{ key: 'changes.untracked', diff: content.toString('utf8').replace(/\n$/, '').split('\n').map(line => `+${line}`).join('\n') }], truncated: stat.size > MAX_BYTES };
    } finally { await handle.close(); }
  }
  const paths = [...new Set([file.path, file.previousPath].filter(Boolean))];
  const [staged, worktree] = await Promise.all([
    git(status.root, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--cached', '--', ...paths], true),
    git(status.root, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--', ...paths], true),
  ]);
  return { sections: [{ key: 'changes.staged', diff: staged.text }, { key: 'changes.unstaged', diff: worktree.text }].filter(section => section.diff), truncated: staged.truncated || worktree.truncated, ...(!staged.text && !worktree.text ? { note: 'changes.noTextDiff' } : {}) };
}
