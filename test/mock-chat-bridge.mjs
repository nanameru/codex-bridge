import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRouter } from '../src/model-router.mjs';
import { authenticateCodex } from '../src/local-security.mjs';
const bind=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
const metrics=[];
const upstream=http.createServer(async(req,res)=>{
 let text='';for await(const chunk of req)text+=chunk;
 const body=JSON.parse(text),lastUser=body.messages.findLastIndex(m=>m.role==='user'),current=body.messages.slice(lastUser+1);
 const label=body.messages[lastUser]?.content??'';
 const outputs=current.filter(m=>m.role==='tool');
 const hasResult=outputs.length>0;
 const recovery=body.tool_choice==='none';
 metrics.push({recovery,label,tools:body.tools?.length??0});
 const poll=label.includes('POLL_TRIGGER'),loop=label.includes('LOOP_TRIGGER'),mixed=label.includes('MIXED_LOOP'),truncated=label.includes('TRUNCATED');
 const shouldCall=!recovery&&(!hasResult||loop||mixed||(poll&&!outputs.at(-1).content.includes('done')));
 res.writeHead(200,{'content-type':'text/event-stream'});
 const emit=value=>res.write('data: '+JSON.stringify(value)+'\n\n');
 if(shouldCall){
  emit({choices:[{index:0,delta:{role:'assistant',content:'Checking.',tool_calls:[{index:0,id:'call_'+metrics.length,type:'function',function:{name:'route_probe',arguments:JSON.stringify(mixed?{iteration:outputs.length}:{})}}]}}]});
  emit({choices:[{index:0,delta:{},finish_reason:truncated?'length':'tool_calls'}]});
 }else{
  emit({choices:[{index:0,delta:{role:'assistant',content:'FINAL_OK: results received.'}}]});
  emit({choices:[{index:0,delta:{},finish_reason:'stop'}]});
 }
 res.end('data: [DONE]\n\n');
});
const upstreamPort=await bind(upstream);
const reservation=http.createServer();const bridgePort=await bind(reservation);await new Promise(r=>reservation.close(r));
const bridge=spawn(process.execPath,[new URL('../src/codex-bridge.mjs',import.meta.url).pathname],{
 env:{...process.env,HOME:process.env.CODEX_HOME,PORT:String(bridgePort),OPENCODE_API_KEY:'test',UPSTREAM_BASE:`http://127.0.0.1:${upstreamPort}/v1`,CODEX_BRIDGE_TEST_UPSTREAM:'1',LOG_LEVEL:'info'},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('bridge start timed out')),5000);
 bridge.stdout.on('data',chunk=>{if(chunk.toString().includes('codex-bridge listening')){clearTimeout(timer);resolve();}});
 bridge.once('exit',()=>{clearTimeout(timer);reject(new Error('bridge exited'));});
});
const catalog=JSON.parse(readFileSync(process.env.CODEX_HOME+'/unified-model-catalog.json'));
const router=createRouter({catalog,bridgeBase:`http://127.0.0.1:${bridgePort}/v1`,authenticate:request=>authenticateCodex(request),toolRecoveryOptions:{maxRounds:10}});
const port=await bind(router);
process.stdout.write(JSON.stringify({url:`http://127.0.0.1:${port}/v1`})+'\n');
process.stdin.on('data',()=>process.stdout.write(JSON.stringify({metrics})+'\n'));
process.stdin.on('end',()=>{router.closeAllConnections();router.close();upstream.closeAllConnections();upstream.close();bridge.kill();});
