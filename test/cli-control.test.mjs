import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliControl, privateControlSocket } from '../src/cli-control.mjs';
function frame(message,opcode=1,fin=true) {
  const body=Buffer.isBuffer(message)?message:Buffer.from(typeof message==='string'?message:JSON.stringify(message));
  assert.ok(body.length<126);return Buffer.concat([Buffer.from([(fin?128:0)|opcode,body.length]),body]);
}
async function fixture(t, handler) {
  const root=mkdtempSync(join(tmpdir(),'cli-control-')),path=join(root,'control.sock');
  const server=http.createServer(), sockets=[];
  server.on('upgrade',(req,socket)=>{
    sockets.push(socket);
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    let buffer=Buffer.alloc(0);
    socket.on('data',data=>{
      buffer=Buffer.concat([buffer,data]);
      while(buffer.length>=6){
        let size=buffer[1]&127,offset=2;
        if(size===126){if(buffer.length<8)return;size=buffer.readUInt16BE(2);offset=4;}
        if(buffer.length<offset+4+size)return;
        assert.ok(buffer[1]&128,'client frames must be masked');
        const mask=buffer.subarray(offset,offset+4), body=buffer.subarray(offset+4,offset+4+size).map((b,i)=>b^mask[i%4]);
        const opcode=buffer[0]&15;buffer=buffer.subarray(offset+4+size);
        if(opcode!==1)continue;
        const m=JSON.parse(body);
        if(m.method==='initialize')socket.write(frame({id:m.id,result:{}}));
        else if(m.id)handler(m,socket);
      }
    });
    socket.on('error',()=>{});
  });
  server.listen(path);await once(server,'listening');chmodSync(path,0o600);
  const events=[],client=new CliControl({socketPath:path,timeoutMs:1000,onNotification:m=>events.push(m)});
  t.after(async()=>{client.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});});
  return {client,events,path};
}
test('private Unix WebSocketでRPCを初期化し分割フレームとpingを処理する',async t=>{
  const f=await fixture(t,(m,s)=>{
    s.write(frame('ping',9));
    const text=JSON.stringify({id:m.id,result:{model:'deepseek'}});
    s.write(frame(text.slice(0,10),1,false));s.write(frame(text.slice(10),0));
    s.write(frame({method:'thread/settings/updated',params:{}}));
  });
  assert.equal((await f.client.request('model/list',{})).model,'deepseek');
  await new Promise(r=>setImmediate(r));assert.equal(f.events.length,1);
});
test('返答しないdaemonのRPCを期限付きで中止する',async t=>{
  const f=await fixture(t,()=>{});await f.client.connect();f.client.timeoutMs=50;
  await assert.rejects(f.client.request('model/list',{}),/control_timeout/);
});
test('他者から書き込み可能なcontrol socketを拒否する',async t=>{
  const f=await fixture(t,()=>{});chmodSync(f.path,0o666);
  assert.throws(()=>privateControlSocket(f.path),/control_insecure/);
  await assert.rejects(f.client.request('model/list',{}),/control_unavailable/);
});
test('binaryや不正なフレームではRPCを失敗させ内容をログへ返さない',async t=>{
  const f=await fixture(t,(_m,s)=>s.write(frame('private response',2)));
  await assert.rejects(f.client.request('model/list',{}),/control_unavailable/);
});

test('同じIDのserver requestをRPC応答と混同せず実行も承認もしない',async t=>{
  const f=await fixture(t,(m,s)=>{
    if(!m.method)return;
    s.write(frame({id:m.id,method:'item/tool/call',params:{}}));
    s.write(frame({id:m.id,result:{model:'expected'}}));
  });
  assert.equal((await f.client.request('model/list',{})).model,'expected');
});

test('古い接続の遅いclose通知で再接続先を閉じない',async t=>{
  const f=await fixture(t,(m,s)=>{if(m.method)s.write(frame({id:m.id,result:{ok:true}}));});
  await f.client.request('model/list',{});const previous=f.client.socket;f.client.close();
  await f.client.request('model/list',{});previous.emit('close');
  assert.equal(f.client.ready,true);
  assert.equal((await f.client.request('model/list',{})).ok,true);
});
