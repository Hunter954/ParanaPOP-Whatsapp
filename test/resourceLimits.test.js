import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { SessionStore, TaskQueue } from '../src/resourceLimits.js';
import { saveMediaStream, tempMediaStats, removeTemp, postMedia, mediaFromUrl } from '../src/media.js';

const pause = () => new Promise(resolve => setImmediate(resolve));

test('abandoned media expires without a new message and cleanup releases storage accounting', async () => {
  let now=1;
  const sessions=new SessionStore({ ttlMs:100, now:()=>now });
  const media=await saveMediaStream(Readable.from([Buffer.alloc(20)]),100,'image/jpeg');
  sessions.set('user',{startedAt:now,image:media,step:'title'});
  now=102;sessions.sweep();await sessions.flushCleanup();
  assert.equal(sessions.size,0);
  assert.equal(tempMediaStats().bytes,0);
  await assert.rejects(fs.stat(media.path),{code:'ENOENT'});
  clearInterval(sessions.timer);
});

test('stream size enforcement rejects a chunked oversize file and cleans partial output', async () => {
  await assert.rejects(saveMediaStream(Readable.from([Buffer.alloc(8),Buffer.alloc(8)]),10),/limite|maxContentLength/);
  assert.deepEqual(tempMediaStats(),{files:0,bytes:0});
});

test('bounded queue runs one job, rejects overflow, and recovers after failure', async () => {
  const queue=new TaskQueue(1);let release;let active=0;let peak=0;
  const first=queue.run(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>release=r);active--;});
  const second=queue.run(async()=>{active++;peak=Math.max(peak,active);active--;throw new Error('failure');});
  const failed=assert.rejects(second,/failure/);
  await assert.rejects(queue.run(async()=>{}),/cheia/);
  release();await first;await failed;
  assert.equal(await queue.run(async()=>42),42);
  assert.equal(peak,1);
});

test('session ceiling is enforced and replacing/cancelling a session releases its media', async () => {
  const sessions=new SessionStore({maxSessions:1});
  const media=await saveMediaStream(Readable.from([Buffer.alloc(10)]),20);
  sessions.set('a',{startedAt:Date.now(),image:media});
  assert.throws(()=>sessions.set('b',{startedAt:Date.now()}),/sessões/);
  sessions.set('a',{startedAt:Date.now()});await sessions.flushCleanup();
  assert.equal(tempMediaStats().bytes,0);
  sessions.clear();clearInterval(sessions.timer);
});

test('multipart capability sends a file stream; old servers retain JSON compatibility', async t => {
  const requests=[];
  const server=http.createServer(async (req,res)=>{
    if(req.method==='OPTIONS') {
      if(req.url==='/modern')res.setHeader('X-Media-Upload','multipart');
      res.end();return;
    }
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({url:req.url,body,type:req.headers['content-type']});
    res.setHeader('Content-Type','application/json');res.end('{"ok":true}');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const media=await saveMediaStream(Readable.from(['image-content']),100,'image/jpeg');
  try {
    assert.equal((await postMedia(base+'/modern','token',{title:'Título'},media,'image')).ok,true);
    assert.match(requests[0].type,/multipart/);
    assert.match(requests[0].body,/image-content/);
    assert.doesNotMatch(requests[0].body,/image_base64/);
    await postMedia(base+'/legacy','token',{},media,'image');
    assert.equal(JSON.parse(requests[1].body).image_base64,Buffer.from('image-content').toString('base64'));
  } finally { await removeTemp(media.path); }
});

test('chunked HTTP download enforces limit even without Content-Length', async t=>{
  const server=http.createServer((_req,res)=>{res.write(Buffer.alloc(8));res.end(Buffer.alloc(8));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  await assert.rejects(mediaFromUrl(`http://127.0.0.1:${server.address().port}/file`,10),/limite|maxContentLength/);
  assert.deepEqual(tempMediaStats(),{files:0,bytes:0});
});
