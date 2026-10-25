import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRouter } from '../src/model-router.mjs';
import { ProviderFallbackState } from '../src/provider-fallback.mjs';
import { CHAT_PROVIDERS } from '../src/manual-providers.mjs';
const calls=[];
const automatic = process.env.CODEX_TEST_FALLBACK === '1';
let phase = 0, clock = Date.now(), unpaid = '', free = false;

const providerFallbackState = new ProviderFallbackState({ now: () => clock });
const servers=[];
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');servers.push(server);return `http://127.0.0.1:${server.address().port}/v1`;}
const bases={};
for(const provider of ['openai','opencode','commandcode','ollama',...(process.env.CODEX_TEST_WHATSTOKEN==='1'?['whatstoken']:[])]){
  bases[provider]=await listen(http.createServer(async(req,res)=>{
    let text='';for await(const c of req)text+=c;
    const body=JSON.parse(text);
    const manual=provider in CHAT_PROVIDERS;
    const summary=body.instructions?.startsWith('Produce only');
    const compact=body.input?.some(i=>i.type==='compaction_trigger');
    calls.push({provider,model:body.model,summary:Boolean(summary),compact:Boolean(compact),
      expectedKey:manual?req.headers.authorization===`Bearer fake-${provider}-key`:true,
      nativeLeak:manual?Boolean(req.headers['chatgpt-account-id']||req.headers['x-codex-bridge-auth']||req.headers.authorization==='Bearer fake-native'):false});
    if (provider === unpaid) {
      res.writeHead(402, {'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Subscription inactive. Add credits.'}}));return;
    }
    if (automatic && !summary && !compact && ((provider === 'opencode' && phase >= 1) || (provider === 'commandcode' && phase >= 2))) {
      res.writeHead(429, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{code:'usage_exceeded',window:provider === 'opencode'?'monthly':'weekly',resets_at:new Date(clock+60000).toISOString()}}));
      return;
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(manual){
      res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:provider+'_OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
    }
    const id='resp_'+calls.length;
    const item=compact?{id:'cmp_test',type:'compaction',encrypted_content:'fake-native-history'}:
      {id:'msg_'+calls.length,type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:summary?'HANDOFF':provider+'_OK',annotations:[]}]};
    const result={id,object:'response',model:body.model,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:2,total_tokens:12}};
    let n=0;const emit=(type,data)=>res.write('data: '+JSON.stringify({type,sequence_number:n++,...data})+'\n\n');
    emit('response.created',{response:{...result,status:'in_progress',output:[]}});
    emit('response.output_item.added',{output_index:0,item});
    if(!compact){emit('response.content_part.added',{output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}});
      emit('response.output_text.delta',{output_index:0,content_index:0,item_id:item.id,delta:item.content[0].text});}
    emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response:result});res.end();
  }));
}
const catalog=JSON.parse(readFileSync(process.env.CODEX_HOME+'/unified-model-catalog.json'));
const router=createRouter({catalog,providerFallbackState,
  whatstokenFreeEnabled:process.env.CODEX_TEST_WHATSTOKEN==='1',
  whatstokenFreeGate:{check:async()=>({allowed:free,end:Date.now()+3600000,reason:'outside_free_window'}),unavailable(){}},cliModelSyncEnabled:process.env.CODEX_TEST_CLI_SYNC==='1',manualProvidersEnabled:true,nativeBase:bases.openai,bridgeBase:bases.opencode,allowTestOrigins:true,
  bridgeKey:()=> 'fake-bridge-key',manualKey:p=>`fake-${p}-key`,fetcher:async(url,init)=>{
    if(!Object.values(bases).some(base=>url.startsWith(base+'/')) && !Object.values(CHAT_PROVIDERS).some(c=>url.startsWith(c.base+'/')))throw new Error('mock_destination_only');
    for(const[p,config]of Object.entries(CHAT_PROVIDERS))if(url.startsWith(config.base+'/'))return fetch(url.replace(config.base,bases[p]),init);
    return fetch(url,init);
  }});
process.stdout.write(JSON.stringify({url:await listen(router)})+'\n');
let commands='';
process.stdin.on('data',chunk=>{
  commands+=chunk;
  while(commands.includes('\n')) {
    const end=commands.indexOf('\n'), command=commands.slice(0,end); commands=commands.slice(end+1);
    if(command.startsWith('unpaid:')) unpaid=command.slice(7);
    if(command.startsWith('free:')) free=command.slice(5)==='on';
    if(command.startsWith('phase:')) phase=Number(command.slice(6));
    if(command.startsWith('advance:')) clock+=Number(command.slice(8));
    process.stdout.write(JSON.stringify({calls})+'\n');
  }
});
process.stdin.on('end',()=>{for(const server of servers){server.closeAllConnections();server.close();}});
