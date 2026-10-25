import assert from 'node:assert/strict';
import test from 'node:test';
import { compactionHandoff } from '../src/compaction-handoff.mjs';

const options = () => ({ destination:'https://native.invalid/v1', headers:{authorization:'Bearer synthetic','chatgpt-account-id':'account'},
  threadId:'thread', signal:new AbortController().signal, prefixEnd:1 });
const body = () => ({input:[{role:'user',content:'historical data '.repeat(1000)}, {role:'user',content:'latest requirement'}]});
const completed = text => Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]});
const create = fetcher => compactionHandoff({fetcher,model:'summary-test',maxBytes:100000,maxInputBytes:100000,
  inputLimitTokens:20000,retryDelayMs:0});

test('retry after cancellation reuses completed chunks and returns only a fully completed handoff', async () => {
  const sent=[],diagnostics=[], first=new AbortController();
  const expand=create(async (_url,init)=>{
    sent.push(JSON.parse(init.body));
    if(sent.length===2) return new Promise((_resolve,reject)=>{
      init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
      first.abort(new Error('synthetic deadline'));
    });
    return completed('summary '+sent.length);
  });
  const original=body();
  await assert.rejects(expand(original,{...options(),signal:first.signal}),/synthetic deadline/);
  // Appending history changes the whole-history cache key, but not prior chunks.
  const appended={input:[original.input[0],{role:'assistant',content:'new historical result'},original.input[1]]};
  const before=structuredClone(appended);
  const result=await expand(appended,{...options(),prefixEnd:2,diagnose:d=>diagnostics.push(d)});
  assert.equal(JSON.stringify(sent[2].input)===JSON.stringify(sent[1].input),true,'retry must start at the interrupted chunk, not the beginning');
  assert.ok(diagnostics.some(d=>d.summary_checkpoint_hits>=1));
  assert.deepEqual(appended,before);
  assert.deepEqual(result.input.at(-1),original.input.at(-1));
  assert.equal(result.input.length,2);
});

test('completed chunk checkpoints never cross thread, authorization, account, destination or edited history', async () => {
  for(const change of [{threadId:'other'},{headers:{authorization:'Bearer other','chatgpt-account-id':'account'}},
    {headers:{authorization:'Bearer synthetic','chatgpt-account-id':'other'}},{destination:'https://other.invalid/v1'}, {threadId:''}, {edit:true}]) {
    const sent=[],first=new AbortController();
    const expand=create(async (_url,init)=>{
      sent.push(JSON.parse(init.body));
      if(sent.length===2) return new Promise((_resolve,reject)=>{
        init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});first.abort(new Error('cancel'));
      });
      return completed('summary');
    });
    const input=body();
    await assert.rejects(expand(input,{...options(),signal:first.signal}),/cancel/);
    if(change.edit) input.input[0].content=input.input[0].content.replace(/^h/,'H');
    const diagnostics=[];
    await expand(input,{...options(),...change,diagnose:d=>diagnostics.push(d)});
    assert.ok(!diagnostics.some(d=>d.summary_checkpoint_hits>0));
    if(!change.edit) assert.deepEqual(sent[2].input,sent[0].input);
  }
});

test('incomplete and failed steps are never reused as checkpoints', async () => {
  for(const status of ['failed','incomplete']) {
    const sent=[];
    const expand=create(async(_url,init)=>{
      sent.push(JSON.parse(init.body));
      if(sent.length===1) return Response.json({status,error:{code:'invalid_prompt'},incomplete_details:{reason:'content_filter'},output:[]});
      return completed('verified summary');
    });
    await assert.rejects(expand(body(),options()));
    await expand(body(),options());
    assert.deepEqual(sent[1].input,sent[0].input);
  }
});

test('checkpoint retention is bounded and evicted history is recomputed', async () => {
  let current,phase,count=0;
  const expand=create(async(_url,init)=>{
    count++;
    if(phase++===1) return new Promise((_resolve,reject)=>{
      init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});current.abort(new Error('cancel'));
    });
    return completed('summary');
  });
  for(let i=0;i<65;i++) {
    current=new AbortController();phase=0;
    await assert.rejects(expand(body(),{...options(),threadId:'thread-'+i,signal:current.signal}),/cancel/);
  }
  phase=100;
  const before=count,diagnostics=[];
  await expand(body(),{...options(),threadId:'thread-0',diagnose:d=>diagnostics.push(d)});
  assert.ok(count>before);
  assert.ok(!diagnostics.some(d=>d.summary_checkpoint_hits>0));
});
