import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('reconnections dispose prior sockets and ignore stale callbacks', async t => {
  const auth=await fs.mkdtemp(path.join(os.tmpdir(),'pop-reconnect-'));
  process.env.AUTH_DIR=auth;process.env.LOG_LEVEL='silent';
  t.after(()=>fs.rm(auth,{recursive:true,force:true}));
  t.mock.timers.enable({apis:['setTimeout']});
  const sockets=[];
  t.mock.module('@whiskeysockets/baileys',{
    defaultExport:()=>{
      const listeners=new Map();
      const socket={ev:{on:(event,fn)=>listeners.set(event,fn),removeAllListeners:event=>listeners.delete(event)},
        listeners,ended:false,end(){this.ended=true;}};
      sockets.push(socket);return socket;
    },
    namedExports:{DisconnectReason:{loggedOut:401},downloadMediaMessage:async()=>{},
      fetchLatestBaileysVersion:async()=>({version:[2,3000,1]}),
      useMultiFileAuthState:async()=>({state:{},saveCreds:async()=>{}})}
  });
  const {startWhatsApp,getStatus}=await import('../src/baileysClient.js');
  await startWhatsApp();
  for(let i=0;i<5;i++){
    const socket=sockets.at(-1);const stale=socket.listeners.get('connection.update');
    await stale({connection:'open'});
    await stale({connection:'close',lastDisconnect:{error:new Error('disconnect')}});
    await startWhatsApp();
    const current=sockets.at(-1);
    await current.listeners.get('connection.update')({connection:'open'});
    await stale({connection:'close'});
    assert.equal(getStatus().connected,true);
    assert.equal(socket.ended,true);
    assert.equal(socket.listeners.size,0);
  }
  assert.equal(sockets.length,6);
});
