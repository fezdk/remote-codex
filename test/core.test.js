import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { createWebServer, approvalResult } from '../server/http.js';
import { createState, applyEvent, activeTurn, mergeTurns } from '../public/state.js';
import { FixtureCodex } from './fixture.js';

// Public synthetic fixture; never use this value for a real server.
const token='test-access-key-at-least-24-characters';
async function setup(t){
  const codex=new FixtureCodex();
  const server=createWebServer({codex,token,publicDir:resolve('public')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeStreams();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=(path,data,headers={})=>fetch(base+path,{method:data===undefined?'GET':'POST',headers:{cookie,...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
  return{codex,server,base,cookie,request,login};
}

test('session data requires authentication; login sets a protected cookie and logout revokes it',async t=>{
  const {base,request,login}=await setup(t);
  assert.equal((await fetch(base+'/api/threads')).status,401);
  assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/threads')).status,200);
  assert.equal((await request('/api/logout',{})).status,200);
  assert.equal((await request('/api/threads')).status,401);
});
test('rejects cross-origin actions, DNS rebinding hosts, non-JSON and arbitrary paths',async t=>{
  const {request,base}=await setup(t);
  assert.equal((await request('/api/threads',{}, {Origin:'https://attacker.example'})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/threads',{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(hostStatus,403);
  assert.equal((await request('/api/threads',{}, {'Content-Type':'text/plain'})).status,415);
  assert.equal((await request('/api/rpc',{method:'command/exec'})).status,404);
  assert.equal((await request('/.remote-codex/access-key')).status,404);
});
test('accepts the machine interface IPs while enforcing the matching browser origin',async t=>{
  const {base,server}=await setup(t);
  for(const address of Object.values(networkInterfaces()).flat()){
    const host=`${address.family==='IPv6'?`[${address.address}]`:address.address}:${server.address().port}`;
    for(const [origin,expected] of [[`http://${host}`,200],['https://attacker.example',403]]){
      const status=await new Promise((resolve,reject)=>{const req=http.get(base+'/',{headers:{Host:host,Origin:origin}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
      assert.equal(status,expected,`${host} with origin ${origin}`);
    }
  }
});
test('opening and sending preserve Codex permissions and steer requires an exact active turn',async t=>{
  const {request,codex}=await setup(t);
  await request('/api/threads/session-one/open',{});
  assert.deepEqual(codex.calls.at(-1),{method:'thread/resume',params:{threadId:'session-one',excludeTurns:true}});
  const response=await request('/api/threads/session-one/message',{text:'long'});
  const {turn}=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(codex.calls.at(-1).params,{threadId:'session-one',input:[{type:'text',text:'long',text_elements:[]}]});
  await request('/api/threads/session-one/message',{text:'Focus on tests',turnId:turn.id});
  assert.equal(codex.calls.at(-1).method,'turn/steer');
  assert.equal(codex.calls.at(-1).params.expectedTurnId,turn.id);
  await request('/api/threads/session-one/interrupt',{turnId:turn.id});
  assert.equal(codex.turns.at(-1).status,'interrupted');
  assert.equal((await request('/api/threads/session-one/message',{text:'late',turnId:turn.id})).status,502);
  assert.equal((await request('/api/threads/session-two/message',{text:'unopened'})).status,409);
});
test('approval decisions are scoped, offered by Codex and cannot be replayed',async t=>{
  const {request,codex}=await setup(t);
  await request('/api/threads/session-one/open',{});
  await request('/api/threads/session-one/message',{text:'approval'});
  assert.equal((await request('/api/respond',{id:42,decision:'acceptForSession'})).status,400);
  assert.equal((await request('/api/respond',{id:42,decision:'accept'})).status,200);
  assert.deepEqual(codex.calls.at(-1),{method:'respond',id:42,result:{decision:'accept'}});
  assert.equal((await request('/api/respond',{id:42,decision:'accept'})).status,409);
  assert.throws(()=>approvalResult({method:'item/commandExecution/requestApproval',params:{availableDecisions:['cancel']}},{decision:'accept'}));
  assert.throws(()=>approvalResult({method:'item/permissions/requestApproval',params:{}},{decision:'accept'}));
});
test('user input maps question IDs and validates all answers',()=>{
  const request={method:'item/tool/requestUserInput',params:{questions:[{id:'choice'}]}};
  assert.deepEqual(JSON.parse(JSON.stringify(approvalResult(request,{answers:{choice:'Grøn'}}))),{answers:{choice:{answers:['Grøn']}}});
  assert.throws(()=>approvalResult(request,{answers:{}}));
});
test('stream reduction handles deltas, final replacement, unrelated sessions and interruption',()=>{
  const state=createState();state.selectedId='one';
  applyEvent(state,{method:'turn/started',params:{threadId:'one',turn:{id:'turn',items:[],status:'inProgress'}}});
  for(const [threadId,delta] of [['one','Hello '],['other','LEAK'],['one','world']])applyEvent(state,{method:'item/agentMessage/delta',params:{threadId,turnId:'turn',itemId:'item',delta}});
  assert.equal(activeTurn(state).items[0].text,'Hello world');
  applyEvent(state,{method:'item/completed',params:{threadId:'one',turnId:'turn',item:{id:'item',type:'agentMessage',text:'Hello world!'}}});
  applyEvent(state,{id:12,method:'item/tool/requestUserInput',params:{threadId:'one',turnId:'turn'}});
  applyEvent(state,{method:'turn/completed',params:{threadId:'one',turn:{id:'turn',items:[],status:'interrupted'}}});
  assert.equal(activeTurn(state),undefined);assert.equal(state.turns[0].items[0].text,'Hello world!');assert.equal(state.requests.size,0);
});
test('history pages merge by ID without losing newer versions',()=>{
  const turns=mergeTurns([{id:'older',startedAt:1},{id:'recent',startedAt:2,text:'old'}],[{id:'recent',startedAt:2,text:'new'}]);
  assert.equal(turns.length,2);assert.equal(turns[1].text,'new');
});
test('native queue uses client IDs, safely withdraws once and lists completed Codex file changes',async t=>{
  const {request,codex}=await setup(t);
  assert.equal((await request('/api/threads/session-one/queue',{text:'next',clientId:'client-one'})).status,409);
  await request('/api/threads/session-one/open',{});
  const {queuedSubmission}=await (await request('/api/threads/session-one/queue',{text:'next',clientId:'client-one'})).json();
  assert.deepEqual(codex.calls.at(-1),{method:'thread/queue/add',params:{threadId:'session-one',clientUserMessageId:'client-one',input:[{type:'text',text:'next',text_elements:[]}]}});
  assert.equal((await (await request('/api/threads/session-one/queue')).json()).data.length,1);
  const path=`/api/threads/session-one/queue/${queuedSubmission.id}/delete`;
  assert.equal((await (await request(path,{})).json()).deleted,true);
  assert.equal((await (await request(path,{})).json()).deleted,false);
  const changes=await (await request('/api/threads/session-one/changes')).json();
  assert.equal(changes.files[0].path,'app.js');assert.equal(changes.files[0].added,1);
  assert.equal((await (await request('/api/threads/session-one/message',{text:''})).json()).errorKey,'error.message');
});

test('project suggestions require login and missing directories require explicit creation',async t=>{
  const {request,base,codex}=await setup(t);
  const root=await mkdtemp(resolve(tmpdir(),'remote-codex-project-api-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=resolve(root,'new project');
  assert.equal((await fetch(base+'/api/projects?path=/')).status,401);
  const result=await (await request('/api/projects?'+new URLSearchParams({path:cwd}))).json();assert.equal(result.state,'missing');
  assert.equal((await request('/api/threads',{cwd})).status,400);await assert.rejects(stat(cwd),{code:'ENOENT'});
  assert.equal(codex.calls.some(call=>call.method==='thread/start'),false);
  assert.equal((await request('/api/threads',{cwd,createDirectory:true})).status,201);
  assert.equal((await stat(cwd)).isDirectory(),true);assert.deepEqual(codex.calls.at(-1),{method:'thread/start',params:{cwd}});
});
