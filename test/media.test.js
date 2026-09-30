import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createMedia, imageType, MAX_IMAGE_BYTES } from '../server/media.js';
import { createWebServer } from '../server/http.js';
import { FixtureCodex } from './fixture.js';
import { imageData, imageBytes } from './image-fixture.js';
async function setup(t) {
  const root = await mkdtemp(resolve(tmpdir(),'remote-codex-image-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root, media:createMedia({directory:resolve(root,'uploads')})};
}
test('assistant Markdown image links register scoped previews in history and completion events, excluding code and other links',async t=>{
  const {root,media}=await setup(t), path=resolve(root,'preview (mobile).png');await writeFile(path,imageBytes);
  const link=`[Se mobilpreview](<${path}>)`, image=`![Mobile](sandbox:${resolve(root,'image.png')})`;
  await writeFile(resolve(root,'image.png'),imageBytes);
  const text=['Before',link,image,'After','`'+link+'`','``'+link+'``','```markdown',link,'```','~~~markdown',link,'~~~','[Web](https://example.com/image.png)','[Secret](/etc/private.txt)','[Network](//example.com/image.png)','[Vector](/tmp/test.svg)'].join('\n');
  const original={id:'agent',type:'agentMessage',text}, result=media.item('one',original);
  assert.equal(result.text,text);assert.equal(original.remoteImageLinks,undefined);
  assert.deepEqual(result.remoteImageLinks.map(link=>link.markdown),[link,image]);
  for(const {image} of result.remoteImageLinks){assert.deepEqual((await media.get('one',image.id)).bytes,imageBytes);await assert.rejects(media.get('two',image.id),{status:404});}
  assert.deepEqual(media.turn('one',{items:[original]}).items[0],result);
  assert.deepEqual(media.event({method:'item/completed',params:{threadId:'one',item:original}}).params.item,result);
  assert.equal(media.item('one',{type:'userMessage',content:[{type:'text',text:link}]}).remoteImageLinks,undefined);
  assert.equal(media.item('one',{type:'agentMessage',text:'```\n'+link}).remoteImageLinks,undefined);
  const remote=createMedia({directory:resolve(root,'remote'),localFiles:false});
  assert.equal(remote.item('one',original).remoteImageLinks[0].image.unavailable,true);
  const invalid=resolve(root,'private.png');await writeFile(invalid,'not an image');
  const missing=media.item('one',{type:'agentMessage',text:`[Invalid](${invalid}) [Missing](/missing/preview.png)`}).remoteImageLinks;
  for(const {image} of missing)await assert.rejects(media.get('one',image.id),{status:404});
  assert.equal(media.item('one',{type:'agentMessage',text:(link+'\n').repeat(100)}).remoteImageLinks.length,16);
});
test('uploads validate bytes, retain private file modes, scope references to a thread and preserve exact data', async t => {
  const {root,media} = await setup(t);
  const uploaded = await media.upload('one',{name:'demo.png',data:imageData});
  assert.deepEqual((await media.get('one',uploaded.id)).bytes,imageBytes);
  assert.deepEqual(await media.input('one',[uploaded.id]),[{type:'image',url:imageData}]);
  await assert.rejects(media.get('other',uploaded.id),{status:404});
  await assert.rejects(media.input('other',[uploaded.id]),{status:404});
  await assert.rejects(media.input('one',Array(5).fill(uploaded.id)));
  await assert.rejects(media.input('one',['../../secret']));
  const folder=resolve(root,'uploads'), file=resolve(folder,(await readdir(folder))[0]);
  assert.equal((await stat(folder)).mode & 0o777,0o700); assert.equal((await stat(file)).mode & 0o777,0o600);
  assert.deepEqual(await readFile(file),imageBytes);
  for (const data of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,SGVsbG8=', imageData.replace('image/png','image/jpeg')]) await assert.rejects(media.upload('one',{data}));
  await assert.rejects(media.upload('one',{data:'data:image/png;base64,'+'A'.repeat(MAX_IMAGE_BYTES*2)}),{status:413});
  const bomb=Buffer.from(imageBytes);bomb.writeUInt32BE(100000,16);assert.throws(()=>imageType(bomb));
});
test('typed history and tool results expose protected references without inlining binary data', async t => {
  const {root,media}=await setup(t);const path=resolve(root,'generated.png');await writeFile(path,imageBytes);
  const originals=[
    {id:'user',type:'userMessage',content:[{type:'image',url:imageData},{type:'localImage',path}]},
    {id:'generated',type:'imageGeneration',result:imageData,status:'completed'},
    {id:'saved',type:'imageGeneration',result:'',savedPath:path,status:'completed'},
    {id:'view',type:'imageView',path},
    {id:'function',type:'functionCallOutput',output:[{type:'input_image',image_url:imageData}]},
    {id:'mcp',type:'mcpToolCall',result:{content:[{type:'image',mimeType:'image/png',data:imageBytes.toString('base64')}]}},
    {id:'dynamic',type:'dynamicToolCall',contentItems:[{type:'inputImage',imageUrl:imageData}]},
    {id:'encoded',type:'functionCallOutput',output:JSON.stringify({image_url:imageData,output_hint:'preview'})},
  ];
  const cleaned=media.turn('one',{id:'turn',items:originals});
  assert.ok(!JSON.stringify(cleaned).includes(imageBytes.toString('base64')));
  for (const item of cleaned.items) for (const image of item.remoteImages || item.content.map(part=>part.remoteImage)) assert.deepEqual((await media.get('one',image.id)).bytes,imageBytes);
  assert.equal(originals[0].content[0].url,imageData,'never mutate Codex history or input');
  const afterRestart=createMedia({directory:resolve(root,'uploads')});
  const restored=afterRestart.turn('one',{id:'turn',items:originals});
  assert.deepEqual((await afterRestart.get('one',restored.items[1].remoteImages[0].id)).bytes,imageBytes);
});
test('image serving rejects non-images and symlinks and does not fetch external URLs', async t => {
  const {root,media}=await setup(t);const path=resolve(root,'private.txt');await writeFile(path,'not an image');
  const image=media.item('one',{type:'imageView',path}).remoteImages[0];await assert.rejects(media.get('one',image.id),{status:404});
  const actual=resolve(root,'actual.png'), link=resolve(root,'link.png');await writeFile(actual,imageBytes);await symlink(actual,link);
  const linked=media.item('one',{type:'imageView',path:link}).remoteImages[0];await assert.rejects(media.get('one',linked.id),{status:404});
  const external=media.item('one',{type:'userMessage',content:[{type:'image',url:'http://127.0.0.1/private'}]});
  assert.deepEqual(external.content[0].remoteImage,{externalUrl:'http://127.0.0.1/private'});
  const remote=createMedia({directory:resolve(root,'remote'),localFiles:false});
  assert.equal(remote.item('one',{type:'imageView',path:actual}).remoteImages[0].unavailable,true);
});
test('upload, image-only send, queue, steer and download enforce auth and session ownership',async t=>{
  const {root}=await setup(t),codex=new FixtureCodex();
  const server=createWebServer({codex,token:'synthetic-image-test-access-token',publicDir:resolve('public'),mediaDir:resolve(root,'uploads')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeStreams();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,data,cookie)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(data)});
  assert.equal((await post('/api/threads/session-one/images',{data:imageData})).status,401);
  const login=await post('/api/login',{token:'synthetic-image-test-access-token'}), cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/threads/session-one/images',{data:imageData},cookie)).status,409);
  await post('/api/threads/session-one/open',{},cookie);
  const upload=await post('/api/threads/session-one/images',{data:imageData,name:'test.png'},cookie);assert.equal(upload.status,201);
  const image=await upload.json();
  assert.equal((await fetch(base+image.url)).status,401);
  assert.equal((await fetch(base+image.url,{headers:{cookie,Origin:'https://attacker.example'}})).status,403);
  const downloaded=await fetch(base+image.url+'?download=1',{headers:{cookie}});
  assert.match(downloaded.headers.get('content-disposition'),/^attachment;/);assert.equal(downloaded.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),imageBytes);
  const sent=await post('/api/threads/session-one/message',{text:'',images:[image.id],clientId:'image-only'},cookie);assert.equal(sent.status,200);
  assert.equal(codex.turns.at(-1).items[0].content[0].url,imageData);
  const long=await (await post('/api/threads/session-one/message',{text:'long'},cookie)).json();
  await post('/api/threads/session-one/message',{text:'',images:[image.id],turnId:long.turn.id,clientId:'image-steer'},cookie);
  assert.equal(codex.calls.at(-1).params.input[0].url,imageData);
  const queued=await post('/api/threads/session-one/queue',{text:'queued',images:[image.id],clientId:'queued-image'},cookie);assert.equal(queued.status,200);
  const q=await queued.json();assert.ok(q.queuedSubmission.input[1].remoteImage.id);
  await post('/api/threads/session-two/open',{},cookie);
  assert.equal((await post('/api/threads/session-two/message',{text:'wrong thread',images:[image.id]},cookie)).status,404);
  assert.equal((await fetch(base+image.url.replace('session-one','session-two'),{headers:{cookie}})).status,404);
  assert.equal((await post('/api/threads/session-one/message',{text:'bad',images:[{path:'/etc/passwd'}]},cookie)).status,400);
  assert.equal((await fetch(base+'/api/threads/session-one/images/not-an-id',{headers:{cookie}})).status,404);
});

test('JPEG, GIF and WebP uploads retain their detected format and bytes',async t=>{
  const {media}=await setup(t);
  for (const [extension,mime] of [['jpg','image/jpeg'],['gif','image/gif'],['webp','image/webp']]) {
    const bytes=await readFile(new URL(`./fixtures/image-small.${extension}`,import.meta.url));
    assert.equal(imageType(bytes),mime);
    const image=await media.upload('one',{name:`sample.${extension}`,data:`data:${mime};base64,${bytes.toString('base64')}`});
    const actual=await media.get('one',image.id);assert.equal(actual.mime,mime);assert.deepEqual(actual.bytes,bytes);
  }
});
