import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { summarizeCodexChanges, gitChanges, gitFileDiff } from '../server/changes.js';
import { messages } from '../public/locales.js';
import { translate } from '../public/i18n.js';

test('translation dictionaries have matching keys and interpolation fields', () => {
  assert.deepEqual(Object.keys(messages.da).sort(), Object.keys(messages.en).sort());
  for (const key of Object.keys(messages.da)) assert.deepEqual(messages.da[key].match(/\{\w+\}/g)?.sort(), messages.en[key].match(/\{\w+\}/g)?.sort(), key);
  assert.equal(translate('en', 'changes.count', { count: 3 }), '3 files');
  assert.equal(translate('missing', 'changes.title'), messages.da['changes.title']);
});
test('Codex summary groups completed patches, follows renames and excludes denied edits', () => {
  const item = (id, path, diff, status = 'completed', move_path) => ({ id, type: 'fileChange', status, changes: [{ path, diff, kind: { type: 'update', move_path } }] });
  const first = item('one', 'a.js', '--- a\n+++ b\n-old\n+new');
  const files = summarizeCodexChanges([{ id: 't1', items: [first, item('denied', 'secret', '+bad', 'declined')] }, { id: 't2', items: [first, item('two', '/repo/a.js', '+again', 'completed', '/repo/b.js')] }], '/repo');
  assert.equal(files.length, 1); assert.equal(files[0].path, 'b.js'); assert.equal(files[0].kind, 'rename');
  assert.equal(files[0].patches.length, 2); assert.equal(files[0].added, 2); assert.equal(files[0].removed, 1);
});
test('Git panel reads staged, unstaged, renamed, literal filenames and untracked files without changing Git', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'remote-codex-git-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(cwd, 'app.js'), 'old\n'); await writeFile(join(cwd, 'rename me'), 'original\n');
  git('add', '.'); git('commit', '-qm', 'fixture'); await writeFile(join(cwd, 'app.js'), 'staged\n'); git('add', 'app.js'); await writeFile(join(cwd, 'app.js'), 'worktree\n'); git('mv', 'rename me', 'renamed file');
  await writeFile(join(cwd, ':(glob)*'), '<script>unsafe</script>\n'); await writeFile(join(cwd, 'binary'), Buffer.from([0, 1, 2])); await symlink('/etc/passwd', join(cwd, 'outside'));
  const before = git('status', '--porcelain=v1', '-z');
  const status = await gitChanges(cwd); assert.equal(status.files.find(f => f.path === 'renamed file').previousPath, 'rename me');
  const diff = await gitFileDiff(cwd, 'app.js'); assert.deepEqual(diff.sections.map(s => s.key), ['changes.staged', 'changes.unstaged']); assert.match(diff.sections[0].diff, /\+staged/); assert.match(diff.sections[1].diff, /\+worktree/);
  assert.match((await gitFileDiff(cwd, ':(glob)*')).sections[0].diff, /<script>/);
  assert.equal((await gitFileDiff(cwd, 'binary')).note, 'changes.nonText'); assert.equal((await gitFileDiff(cwd, 'outside')).note, 'changes.nonText');
  await assert.rejects(gitFileDiff(cwd, '../etc/passwd'), { errorKey: 'changes.fileGone' });
  assert.equal(git('status', '--porcelain=v1', '-z'), before);
});
