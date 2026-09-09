import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, symlink, link, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAccessKey } from '../server/credential-store.js';

test('key storage preserves the key, tightens permissions and rejects symlinks, hardlinks and special files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'remote-codex-key-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'state'), path = join(dir, 'access-key');
  const key = await loadAccessKey(dir); assert.ok(key.length >= 32);
  await chmod(dir, 0o755); await chmod(path, 0o644);
  assert.equal(await loadAccessKey(dir), key);
  assert.equal((await stat(dir)).mode & 0o777, 0o700); assert.equal((await stat(path)).mode & 0o777, 0o600);
  await rm(path); const target = join(root, 'unrelated'); await writeFile(target, 'unrelated', { mode: 0o644 });
  await symlink(target, path); await assert.rejects(loadAccessKey(dir)); assert.equal((await stat(target)).mode & 0o777, 0o644);
  await rm(path); await link(target, path); await assert.rejects(loadAccessKey(dir)); assert.equal((await stat(target)).mode & 0o777, 0o644);
  await rm(path); execFileSync('mkfifo', [path]); await assert.rejects(loadAccessKey(dir));
  const actual = join(root, 'actual'); await mkdir(actual); const alias = join(root, 'alias'); await symlink(actual, alias); await assert.rejects(loadAccessKey(alias));
});
