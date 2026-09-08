import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FixtureCodex } from './fixture.js';
import { createWebServer } from '../server/http.js';
const codex=new FixtureCodex();
const cwd=await mkdtemp(resolve(tmpdir(),'remote-codex-browser-git-'));
execFileSync('git',['init','-q',cwd]);
await writeFile(resolve(cwd,'untracked.txt'),'<script>only text</script>\n');
codex.threads[0].cwd=cwd;codex.turns[0].items.find(item=>item.type==='fileChange').changes[0].path=resolve(cwd,'app.js');
// Public synthetic fixture; never use this value for a real server.
const server=createWebServer({codex,token:'browser-test-access-key-123456789',publicDir:resolve('public')});
server.listen(4311,'127.0.0.1');
