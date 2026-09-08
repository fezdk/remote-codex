import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CodexClient } from '../server/codex.js';

async function connected(client) {
  if (client.state === 'connected') return;
  while (true) { const [status]=await once(client,'status');if(status.state==='connected')return; }
}

test('WebSocket protocol initializes, correlates RPC, routes approvals and restores subscriptions on reconnect', {timeout:10000}, async t=>{
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
  const calls=[];let peer,connections=0;
  server.on('connection',(socket,request)=>{
    peer=socket;connections++;
    assert.equal(request.headers['sec-websocket-extensions'],undefined);
    socket.on('message',bytes=>{
      const msg=JSON.parse(bytes);calls.push(msg);
      if(msg.method==='initialize')socket.send(JSON.stringify({id:msg.id,result:{platformOs:'linux'}}));
      else if(msg.method==='thread/resume')socket.send(JSON.stringify({id:msg.id,result:{thread:{id:msg.params.threadId}}}));
      else if(msg.method==='test/echo')socket.send(JSON.stringify({id:msg.id,result:{value:msg.params.value}}));
      else if(msg.method==='test/fail')socket.send(JSON.stringify({id:msg.id,error:{code:123,message:'Expected failure'}}));
    });
  });
  const client=new CodexClient({url:`ws://127.0.0.1:${server.address().port}`,timeout:500});
  t.after(()=>{client.close();for(const socket of server.clients)socket.terminate();server.close();});
  client.connect();await connected(client);
  assert.equal(calls[0].method,'initialize');assert.equal(calls[0].params.capabilities.experimentalApi,true);
  const results=await Promise.all([client.rpc('test/echo',{value:1}),client.rpc('test/echo',{value:2})]);
  assert.deepEqual(results.map(r=>r.value),[1,2]);
  assert.equal(calls[1].method,'initialized');
  await assert.rejects(client.rpc('test/fail'),/Expected failure/);
  await client.subscribe('thread-one');
  assert.deepEqual(calls.at(-1).params,{threadId:'thread-one',excludeTurns:true});
  const incoming=once(client,'event');
  peer.send(JSON.stringify({id:71,method:'item/commandExecution/requestApproval',params:{threadId:'thread-one',turnId:'turn-one'}}));
  const [request]=await incoming;
  assert.equal(request.bridgeSequence,1);assert.equal(client.requests.size,1);
  client.respond(71,{decision:'decline'});
  assert.equal(client.requests.size,0);
  assert.throws(()=>client.respond(71,{decision:'accept'}),/no longer pending/);
  await assert.rejects(client.rpc('test/timeout'),/timed out/);
  const received=once(peer,'message');
  const pending=client.rpc('test/pending');const rejected=assert.rejects(pending,/disconnected/);
  await received;
  const disconnected=once(client,'status');peer.terminate();await disconnected;await rejected;
  await connected(client);
  assert.equal(connections,2);
  assert.equal(calls.filter(c=>c.method==='thread/resume').length,2);
  assert.equal(calls.filter(c=>c.method==='test/pending').length,1,'mutations are not replayed');
});
