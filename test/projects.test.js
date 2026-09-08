import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { projectPath, suggestProjects, prepareProject } from '../server/projects.js';

test('project suggestions list only existing folders and recent projects, including names with spaces', async t => {
  const root = await mkdtemp(join(tmpdir(), 'remote-codex-projects-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'project one'));await mkdir(join(root,'project two'));await mkdir(join(root,'.hidden'));await writeFile(join(root,'project-file'),'not a directory');await symlink(join(root,'project one'),join(root,'project-link'));
  const result = await suggestProjects(join(root,'proj'),[join(root,'project two'),join(root,'gone')]);
  assert.deepEqual(result.suggestions.map(s=>s.path),[join(root,'project two'),join(root,'project one'),join(root,'project-link')]);
  assert.equal(result.suggestions[0].source,'recent');
  assert.equal((await suggestProjects(root+'/')).suggestions.some(s=>s.path===join(root,'.hidden')),false);
  assert.equal((await suggestProjects(join(root,'.h'))).suggestions[0].path,join(root,'.hidden'));
  assert.equal(projectPath('~/example'),join(homedir(),'example'));
  assert.equal((await suggestProjects('relative/path')).state,'invalid');assert.throws(()=>projectPath('/bad\0path'));
});
test('missing project folders are created only with explicit opt-in and files are rejected', async t=>{
  const root=await mkdtemp(join(tmpdir(),'remote-codex-project-create-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'nested','new project');
  const result=await suggestProjects(path);assert.equal(result.state,'missing');assert.equal(result.canCreate,true);
  await assert.rejects(stat(path),{code:'ENOENT'});
  await assert.rejects(prepareProject(path),{errorKey:'projects.missing'});await assert.rejects(prepareProject(path,'true'),{errorKey:'projects.missing'});
  assert.equal(await prepareProject(path,true),path);assert.equal((await stat(path)).isDirectory(),true);assert.equal(await prepareProject(path),path);
  await writeFile(join(root,'file'),'text');assert.equal((await suggestProjects(join(root,'file'))).state,'file');
  await assert.rejects(prepareProject(join(root,'file'),true),{errorKey:'projects.file'});await assert.rejects(prepareProject(join(root,'file','child'),true),{errorKey:'projects.file'});
});
