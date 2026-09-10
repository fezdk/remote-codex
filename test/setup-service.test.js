import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, symlink, link, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, parseOptions, renderUnit, validateRuntime } from '../scripts/setup-service.mjs';
const template = await readFile(new URL('../deploy/remote-codex.service', import.meta.url), 'utf8');
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'remote-codex-setup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project space % $dollar "quote"');
  await mkdir(join(root, 'server'), { recursive: true }); await mkdir(join(root, 'deploy'));
  await writeFile(join(root, 'server/index.js'), ''); await writeFile(join(root, 'deploy/remote-codex.service'), template);
  const bin = join(base, 'bin space $node %'); await mkdir(bin);
  const node = join(bin, 'node'); await symlink(process.execPath, node);
  const env = { XDG_CONFIG_HOME: join(base, 'config'), PATH: bin, NODE_OPTIONS: '--should-not-inherit', NODE_PATH: '/unused' };
  const calls = [], logs = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === node && args[0] === '-p') return { stdout: JSON.stringify({ version: '24.21.0', lts: 'Krypton' }) };
    return { stdout: '' };
  };
  const context = { root, env, run, log: line => logs.push(line), platform: 'linux', now: new Date('2026-09-10') };
  const target = join(env.XDG_CONFIG_HOME, 'systemd/user/remote-codex.service');
  return { base, root, node, env, calls, logs, run, context, target };
}

test('setup discovers Node, previews without writes, and renders paths accepted by systemd', async t => {
  const f = await fixture(t);
  const result = await setup(['--dry-run', '--start', '--enable-linger'], f.context);
  assert.equal(result.node, f.node);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(c => c.file === f.node));
  assert.equal(f.calls[0].options.env.NODE_OPTIONS, undefined); assert.equal(f.calls[0].options.env.NODE_PATH, undefined);
  await assert.rejects(stat(f.env.XDG_CONFIG_HOME), { code: 'ENOENT' });
  assert.match(result.unit, /ExecStart=:"/); assert.match(result.unit, /%%/); assert.match(result.unit, /\$dollar/);
  const unit = join(f.base, 'remote-codex.service'); await writeFile(unit, result.unit);
  try { execFileSync('systemd-analyze', ['--version'], { stdio: 'ignore' }); }
  catch { t.diagnostic('systemd-analyze unavailable; real unit parser check skipped'); return; }
  execFileSync('systemd-analyze', ['verify', unit], { stdio: 'pipe' });
});

test('install is idempotent, enables without starting, and preserves private environment settings', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.remote-codex'));
  const privateEnv = join(f.root, '.remote-codex/service.env'); await writeFile(privateEnv, 'SYNTHETIC_PRIVATE_SETTING=keep\n');
  await setup([], f.context);
  const installed = await readFile(f.target, 'utf8'), first = await stat(f.target);
  assert.equal(first.mode & 0o777, 0o600);
  assert.deepEqual(f.calls.filter(c => c.file === 'systemctl').map(c => c.args), [
    ['--user', 'show', '--property=Version', '--value'], ['--user', 'daemon-reload'], ['--user', 'enable', 'remote-codex.service'],
  ]);
  assert.ok(f.calls.every(c => !c.args.includes('start') && !c.args.includes('restart')));
  await setup([], f.context);
  assert.equal((await stat(f.target)).ino, first.ino); assert.equal(await readFile(f.target, 'utf8'), installed);
  assert.equal(await readFile(privateEnv, 'utf8'), 'SYNTHETIC_PRIVATE_SETTING=keep\n');
  assert.ok(f.logs.every(line => !line.includes('SYNTHETIC_PRIVATE_SETTING')));
});

test('a different unit needs replace, is backed up, and start/restart/linger are explicit', async t => {
  const f = await fixture(t);
  await mkdir(resolve(f.target, '..'), { recursive: true, mode: 0o700 });
  const old = '[Service]\nExecStart=/example/old-node old-server.js\n'; await writeFile(f.target, old);
  await assert.rejects(setup([], f.context), /--replace/);
  assert.equal(await readFile(f.target, 'utf8'), old);
  assert.ok(f.calls.every(c => c.file === f.node));
  await setup(['--dry-run'], f.context); assert.equal(await readFile(f.target, 'utf8'), old);
  await setup(['--node', f.node, '--replace', '--start', '--enable-linger'], f.context);
  const files = await readdir(resolve(f.target, '..'));
  const backups = files.filter(file => file.includes('.backup-')); assert.equal(backups.length, 1);
  const backup = join(resolve(f.target, '..'), backups[0]); assert.equal(await readFile(backup, 'utf8'), old); assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.ok(f.calls.some(c => c.file === 'loginctl' && c.args[0] === 'enable-linger'));
  assert.ok(f.calls.some(c => c.args.includes('start'))); assert.ok(!f.calls.some(c => c.args.includes('restart')));
  await setup(['--restart'], f.context); assert.ok(f.calls.some(c => c.args.includes('restart')));
});

test('unsupported Node, missing dependencies, invalid flags and unavailable user manager leave files alone', async t => {
  const f = await fixture(t);
  assert.throws(() => parseOptions(['--node']), /requires/); assert.throws(() => parseOptions(['--start', '--restart']), /Choose/);
  assert.throws(() => parseOptions(['--unknown']), /Unknown/);
  for (const info of [{ version: '18.19.1', lts: 'Hydrogen' }, { version: '25.0.0', lts: false }, { version: '24.3.0', lts: false }, { version: '22.1.0', lts: 'Jod' }]) {
    assert.throws(() => validateRuntime(info, new Date('2029-01-01')), /maintained LTS/);
  }
  assert.doesNotThrow(() => validateRuntime({ version: '24.21.0', lts: 'Krypton' }, new Date('2026-09-10')));
  await assert.rejects(setup([], { ...f.context, run: async () => ({ stdout: '{"version":"18.19.1","lts":"Hydrogen"}' }) }), /maintained LTS/);
  await assert.rejects(setup([], { ...f.context, run: async (file, args, options) => { if (args[0] === '--input-type=module') throw new Error('missing'); return f.run(file, args, options); } }), /npm ci/);
  await assert.rejects(setup([], { ...f.context, run: async (file, args, options) => { if (file === 'systemctl') throw new Error('no bus'); return f.run(file, args, options); } }), /user manager/);
  await assert.rejects(stat(f.env.XDG_CONFIG_HOME), { code: 'ENOENT' });
});

test('existing links and unsafe unit directories are refused even with replace', async t => {
  const f = await fixture(t), directory = resolve(f.target, '..');
  await mkdir(directory, { recursive: true });
  const other = join(f.base, 'unrelated'); await writeFile(other, 'keep');
  await symlink(other, f.target); await assert.rejects(setup(['--replace'], f.context), /safely read/);
  await rm(f.target); await link(other, f.target); await assert.rejects(setup(['--replace'], f.context), /without links/);
  await rm(f.target); await chmod(directory, 0o777); await assert.rejects(setup(['--replace'], f.context), /writable/);
  assert.equal(await readFile(other, 'utf8'), 'keep');
  assert.throws(() => renderUnit(template, '/bad\npath', f.node), /control/);
  assert.throws(() => renderUnit(template, '/project[1]', f.node), /glob/);
  assert.throws(() => renderUnit(template, f.root, '/node"quote'), /executable path/);
});

test('an activation failure reports the failed step and keeps the unit and backup for recovery', async t => {
  const f = await fixture(t);
  await mkdir(resolve(f.target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(f.target, 'old unit\n');
  await assert.rejects(setup(['--replace', '--start'], { ...f.context, run: async (file, args, options) => {
    if (file === 'systemctl' && args.includes('daemon-reload')) throw new Error('synthetic failure');
    return f.run(file, args, options);
  } }), /daemon-reload failed.*Earlier completed steps were kept/);
  assert.match(await readFile(f.target, 'utf8'), /Generated by scripts\/setup-service/);
  const backup = (await readdir(resolve(f.target, '..'))).find(file => file.includes('.backup-'));
  assert.equal(await readFile(join(resolve(f.target, '..'), backup), 'utf8'), 'old unit\n');
  assert.ok(f.calls.every(c => !c.args.includes('start') && !c.args.includes('restart')));
});
