import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliControl } from '../src/cli-control.mjs';

const root = process.env.CODEX_HOME;
assert.match(root, /provider-fallback-e2e-/); // Never manage the user's daemon.
const binary = process.env.CODEX_BIN || 'codex';
const provider = process.env.CODEX_TEST_MODEL_PROVIDER || 'openai';
assert.ok(['openai','codex-live'].includes(provider));
const upstream = spawn(process.execPath, [fileURLToPath(new URL('./mock-manual.mjs', import.meta.url))], {
  env: process.env, stdio: ['pipe','pipe','inherit'] });
const lines = createInterface({ input: upstream.stdout });
const read = () => once(lines, 'line').then(([line]) => JSON.parse(line));
let control, daemon;
try {
  const base = (await read()).url;
  writeFileSync(join(root, 'config.toml'), `model="gpt-6.1-sol"\nmodel_provider=${JSON.stringify(provider)}\nopenai_base_url=${JSON.stringify(base)}\nmodel_catalog_json=${JSON.stringify(join(root,'unified-model-catalog.json'))}\n`);
  if(provider!=='openai')writeFileSync(join(root,'config.toml'),`\n[model_providers.${provider}]\nname="Mock local router"\nwire_api="responses"\nrequires_openai_auth=true\nbase_url=${JSON.stringify(base)}\n`,{flag:'a'});
  daemon=spawn(binary,['app-server','--listen','unix://'],{env:process.env,stdio:['ignore','ignore','ignore']});
  for(let i=0;!existsSync(join(root,'app-server-control/app-server-control.sock'));i++){assert.ok(i<100,'socket timeout');await new Promise(r=>setTimeout(r,50));}
  const events=[];
  control = new CliControl({ socketPath: join(root,'app-server-control/app-server-control.sock'),
    timeoutMs:5000, observeAll:true, onNotification: event => events.push(event) });
  const startedThread = await control.request('thread/start', { cwd:root, sandbox:'read-only', approvalPolicy:'never',
    model:'opencode/deepseek-v4.1-flash', modelProvider:provider, config:{openai_base_url:base,model_catalog_json:join(root,'unified-model-catalog.json')} });
  const id=startedThread.thread.id;
  const command = async text => { const result=read(); upstream.stdin.write(text+'\n'); return result; };
  const tmux='codex-bridge-test-'+process.pid;
  const tmuxCall=(...args)=>execFileSync('tmux',['-L',tmux,'-f','/dev/null',...args],{env:process.env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  let tui=false;
  try {
    await turn('opencode');
    tmuxCall('new-session','-d','-s','cli','-x','130','-y','38','sleep','30');
    tmuxCall('set-option','-t','cli','remain-on-exit','on');
    tmuxCall('respawn-pane','-k','-t','cli',binary,'--remote','unix://'+join(root,'app-server-control/app-server-control.sock'),'--no-alt-screen','resume',id);
    tui=true;
    await new Promise(r=>setTimeout(r,1500));
    const initial=tmuxCall('capture-pane','-p','-t','cli');
    assert.ok(!/Sign in|Finish signing|Error:|Pane is dead/.test(initial),'TUI bootstrap must complete without authentication operations');
    assert.ok(initial.includes('OpenCode · DeepSeek V4.1 Flash'));
    const evidence=fileURLToPath(new URL('../test-results/',import.meta.url));mkdirSync(evidence,{recursive:true});
    writeFileSync(join(evidence,'cli-sync-opencode.txt'),initial);
    if(existsSync(join(root,'staged-model-catalog.json')))writeFileSync(join(root,'unified-model-catalog.json'),readFileSync(join(root,'staged-model-catalog.json')));
    const screen=async(provider,label)=>{
      const deadline=Date.now()+5000;let text='';
      for(;;){text=tmuxCall('capture-pane','-p','-t','cli');
        if(text.split('\n').some(l=>l.trimStart().startsWith(label+' · DeepSeek V4.1 Flash')
          || (process.env.CODEX_TEST_STALE_CATALOG==='1'&&l.trimStart().startsWith('auto-'+provider+'/deepseek-v4.1-flash'))))break;
        assert.ok(Date.now()<deadline,'TUI model label did not update: '+label);await new Promise(r=>setTimeout(r,50));}
      writeFileSync(join(evidence,'cli-sync-'+provider+'.txt'),text);return text;
    };
    async function turn(provider, status='completed', manual=false) {
      const start=events.length;
      const result=await control.request('turn/start',{threadId:id,input:[{type:'text',text:'Reply OK only. Do not use tools.'}]});
      const deadline=Date.now()+10000;
      for(;;){
        const done=events.slice(start).find(e=>e.method==='turn/completed'&&e.params.turn.id===result.turn.id);
        if(done){assert.equal(done.params.turn.status,status,JSON.stringify(done));break;}
        assert.ok(Date.now()<deadline,'turn timeout');await new Promise(r=>setTimeout(r,10));
      }
      if(status==='completed')assert.ok(events.slice(start).some(e=>e.method==='item/agentMessage/delta'&&e.params.delta.includes(provider+'_OK')),provider+' missing from mock');
      const current=(await control.request('thread/read',{threadId:id,includeTurns:false})).thread;
      assert.equal(current.model,(manual||provider==='opencode'?'':'auto-')+provider+'/deepseek-v4.1-flash');
      assert.equal(current.modelProvider,process.env.CODEX_TEST_MODEL_PROVIDER||'openai');
    }
    await command('phase:1'); await turn('commandcode');
    assert.ok(events.some(e=>e.method==='thread/settings/updated' && e.params.threadSettings.model==='auto-commandcode/deepseek-v4.1-flash'));
    const changed=await screen('commandcode','Command Code');
    assert.ok(changed.includes('https://opencode.ai/console/go'));
    assert.ok(changed.includes('https://opencode.ai/console/'));
    await command('phase:2'); await turn('ollama');await screen('ollama','Ollama Cloud');
    await command('phase:0'); await command('advance:61000'); await turn('opencode');await screen('restored','OpenCode');
    await command('phase:1');await turn('commandcode');
    await command('phase:0');await command('advance:61000');
    await control.request('thread/settings/update',{threadId:id,model:'ollama/deepseek-v4.1-flash'});
    await control.request('thread/settings/update',{threadId:id,model:'commandcode/deepseek-v4.1-flash'});
    await turn('commandcode','completed',true);
    await control.request('thread/settings/update',{threadId:id,model:'ollama/deepseek-v4.1-flash'});
    await command('unpaid:ollama');await turn('ollama','failed',true);
    const deadline=Date.now()+5000;let payment='';
    for(;;){payment=tmuxCall('capture-pane','-p','-t','cli');
      if(payment.includes('https://ollama.com/signin')&&payment.includes('https://ollama.com/pricing'))break;
      assert.ok(Date.now()<deadline,'payment error links missing from TUI');await new Promise(r=>setTimeout(r,50));}
    writeFileSync(join(evidence,'cli-sync-payment.txt'),payment);
    const calls=(await command('summary')).calls;
    assert.ok(calls.every(c=>c.expectedKey&&!c.nativeLeak));
    console.log(`共有サーバー+実CLI: OpenCode/Command Code/Ollama/OpenCode復帰の実選択表示、リンク表示、手動優先が成功。模擬上流 ${calls.length}要求。`);
  } finally { if(tui)try{tmuxCall('kill-server');}catch{} }
} finally {
  control?.close();
  if(daemon && daemon.exitCode===null && daemon.signalCode===null){const exited=once(daemon,'exit');daemon.kill();await exited.catch(()=>{});}
  upstream.stdin.end(); upstream.kill(); lines.close();
}
