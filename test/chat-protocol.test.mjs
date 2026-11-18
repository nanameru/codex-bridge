import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chatToResponses, pipeChatStream, chatMessages } from '../src/chat-protocol.mjs';
const call = { id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{"query":"status"}' } };
const chat = (finish, calls = []) => ({ choices: [{ message: { content: 'Checking', tool_calls: calls }, finish_reason: finish }] });
function response() {
  const res = new EventEmitter(); res.text = ''; res.writeHead = () => {}; res.write = text => { res.text += text; }; res.end = () => { res.writableEnded = true; }; return res;
}
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n';
const events = res => res.text.split('\n\n').filter(v=>v.startsWith('event:')).map(v=>JSON.parse(v.split('\ndata: ')[1]));
async function stream(chunks) {
  const res = response();
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close(); } });
  await pipeChatStream({ body },res,'test','thread'); return events(res);
}

test('JSON rejects truncated, malformed, error and conflicting tools without executable output', () => {
  for (const data of [chat('length',[call]),chat(null,[call]),chat('stop',[call]),chat('tool_calls'),
    chat('tool_calls',[call,call]),{error:{message:'PRIVATE'}}]) {
    const result = chatToResponses(data,'test');
    assert.equal(result.status,'failed'); assert.deepEqual(result.output,[]); assert.equal(result.error.code,'invalid_prompt');
    assert.doesNotMatch(result.error.message,/PRIVATE/);
  }
  assert.equal(chatToResponses(chat('tool_calls',[call]),'test').output[0].phase,'commentary');
  assert.equal(chatToResponses(chat('stop'),'test').output[0].phase,'final_answer');
});

test('invalid upstream tool arguments are retryable without exposing or executing any tool', async () => {
  for (const args of ['{"PRIVATE_FIXTURE":', '', 'null', '[]', '"PRIVATE_FIXTURE"', '{"input":"raw\nnewline"}']) {
    const invalid = {...call, id:'call_2', function:{name:'probe', arguments:args}};
    const json = chatToResponses(chat('tool_calls',[call, invalid]),'test');
    const output = await stream([frame({choices:[{delta:{tool_calls:[{index:0,...call},{index:1,...invalid,id:'call_2'}]}}]}),
      frame({choices:[{delta:{},finish_reason:'tool_calls'}]})]);
    // Validate the whole batch before committing even the preceding valid tool.
    const single = chatToResponses(chat('tool_calls',[invalid]),'test');
    for (const failure of [single, json, output.at(-1).response]) {
      assert.equal(failure.status,'failed');
      assert.equal(failure.error.code,'server_error');
      assert.equal(failure.error.reason,'invalid_tool_arguments');
      assert.deepEqual(failure.output,[]);
      assert.doesNotMatch(failure.error.message,/PRIVATE_FIXTURE|raw/);
    }
    assert.deepEqual(json.output,[]);
    assert.ok(!output.some(e=>e.item?.type==='function_call'));
  }
});

test('SSE cannot execute tools on EOF without finish_reason or on length/content_filter', async () => {
  const chunk = frame({choices:[{delta:{tool_calls:[{index:0,...call}]}}]});
  for (const end of ['',frame({choices:[{delta:{},finish_reason:'length'}]}),frame({choices:[{delta:{},finish_reason:'content_filter'}]})]) {
    const output = await stream([chunk,end]);
    assert.equal(output.at(-1).type,'response.failed');
    assert.equal(output.at(-1).response.error.code,'invalid_prompt');
    assert.ok(!output.some(e=>e.item?.type==='function_call'));
  }
});

test('portable launcher mock upstream completes text and tool SSE through the Bridge converter', { timeout: 10000 }, async (t) => {
  const script = fileURLToPath(new URL('./mock-upstream.mjs', import.meta.url));
  const mock = spawn(process.execPath, [script], {
    env: { MOCK_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const closed = once(mock, 'close');
  const logs = createInterface({ input: mock.stdout });
  t.after(async () => {
    logs.close();
    if (mock.exitCode === null && mock.signalCode === null) mock.kill();
    await closed;
  });
  const [ready] = await Promise.race([
    once(logs, 'line', { signal: t.signal }),
    closed.then(([code, signal]) => assert.fail(`Mock upstream exited before listening (${code ?? signal})`)),
  ]);
  const match = /^\[mock\] listening ([1-9]\d*)$/.exec(ready);
  assert.ok(match, ready);
  const url = `http://127.0.0.1:${match[1]}/v1/chat/completions`;

  async function complete(content) {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content }] }),
      signal: t.signal,
    });
    assert.equal(upstream.status, 200);
    assert.equal(upstream.headers.get('content-type'), 'text/event-stream');
    const res = response();
    await pipeChatStream(upstream, res, 'test', 'thread');
    const terminal = events(res).at(-1);
    assert.equal(terminal.type, 'response.completed', terminal.response.error?.message);
    assert.equal(terminal.response.output.length, 1);
    return terminal.response.output[0];
  }

  const answer = await complete('Reply BRIDGE_OK. Do not use tools.');
  assert.equal(answer.phase, 'final_answer');
  assert.equal(answer.content[0].text, 'BRIDGE_OK');
  const tool = await complete('USE_TOOL_NOW');
  assert.equal(tool.type, 'function_call');
  assert.equal(tool.call_id, 'call_mock_1');
  assert.equal(tool.name, 'get_weather');
  assert.deepEqual(JSON.parse(tool.arguments), { city: 'Tokyo' });
});

test('valid SSE preserves UTF8, reasoning, usage and exactly one completed tool', async () => {
  const data = frame({choices:[{index:0,delta:{reasoning_content:'test reasoning',content:'確認中',tool_calls:[{index:0,...call}]}}]})
    +frame({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+frame({choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'data: [DONE]\n\n';
  const output = await stream([...Buffer.from(data)].map(b=>Buffer.from([b])));
  const completed = output.at(-1).response;
  assert.equal(completed.status,'completed');
  assert.equal(completed.output.find(i=>i.type==='message').phase,'commentary');
  assert.equal(completed.output.find(i=>i.type==='message').content[0].text,'確認中');
  assert.equal(completed.output.filter(i=>i.type==='function_call').length,1);
  assert.equal(completed.output.find(i=>i.type==='function_call').call_id,'call_1');
  assert.equal(completed.usage.total_tokens,15);
});

test('SSE accepts final frame without newline, rejects malformed JSON and does not duplicate text', async () => {
  const success=await stream([frame({choices:[{delta:{content:'OK'}}]}),'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}']);
  assert.equal(success.at(-1).type,'response.completed');
  assert.equal(success.at(-1).response.output.length,1);
  assert.equal(success.at(-1).response.output[0].phase,'final_answer');
  const failure=await stream(['data: {broken\n\n']);
  assert.equal(failure.at(-1).type,'response.failed');
});

test('assistant commentary, reasoning and calls form one message; results survive once', async () => {
  const { chatMessages } = await import('../src/chat-protocol.mjs');
  const input = [{role:'user',content:'check'}, {id:'rs_fixture',type:'reasoning',encrypted_content:'cxb1:'+Buffer.from('fixture thinking').toString('base64url')},
    {type:'message',role:'assistant',content:[{type:'output_text',text:'Checking'}]},
    {type:'function_call',call_id:'call_1',name:'probe',arguments:'{}'},
    {type:'function_call_output',call_id:'call_1',output:'BUILD_OK'}];
  const { openCodeBody } = await import('../src/tool-adapter.mjs');
  const original=structuredClone(input),messages=chatMessages(openCodeBody({input}),true);
  assert.equal(messages.length,3);assert.equal(messages[1].content,'Checking');assert.equal(messages[1].reasoning_content,'fixture thinking');
  assert.equal(messages[1].tool_calls[0].id,'call_1');assert.equal(messages[2].role,'tool');assert.equal(messages[2].tool_call_id,'call_1');
  assert.equal(messages[2].content,'BUILD_OK');assert.deepEqual(input,original);
});

test('empty and whitespace-only final answers have a machine-readable recovery reason in JSON and SSE',async()=>{
 for(const text of ['', '  \n ']){
  const json=chatToResponses({choices:[{message:{content:text,reasoning_content:'fixture'},finish_reason:'stop'}]},'test');
  assert.equal(json.status,'failed');assert.equal(json.error.reason,'empty_output');
  const output=await stream([frame({choices:[{delta:{content:text,reasoning_content:'fixture'}}]}),frame({choices:[{delta:{},finish_reason:'stop'}]})]);
  assert.equal(output.at(-1).type,'response.failed');assert.equal(output.at(-1).response.error.reason,'empty_output');
 }
});

const serverSearchHistory = [
  {type:'tool_search_call',execution:'server',call_id:null,status:'completed',arguments:{paths:['synthetic']}},
  {type:'tool_search_output',execution:'server',call_id:null,status:'completed',tools:[]},
];
const historicalCall = call_id => ({type:'function_call',call_id,name:'probe',arguments:'{}'});
const historicalOutput = call_id => ({type:'function_call_output',call_id,output:'synthetic result ' + call_id});

test('inert server search history waits until the ordinary tool exchange is complete', () => {
  const input=[historicalCall('ordinary'),...serverSearchHistory,historicalOutput('ordinary')];
  const before=structuredClone(input),messages=chatMessages({input});
  assert.deepEqual(messages.map(message=>message.role),['assistant','tool','user','user']);
  assert.equal(messages[0].tool_calls[0].id,'ordinary');
  assert.equal(messages[1].tool_call_id,'ordinary');
  assert.ok(messages[2].content.endsWith(JSON.stringify(serverSearchHistory[0])));
  assert.ok(messages[3].content.endsWith(JSON.stringify(serverSearchHistory[1])));
  assert.deepEqual(input,before);
});

test('parallel tool batches retain inert server history in order after every matching output', () => {
  const input=[historicalCall('first'),historicalCall('second'),serverSearchHistory[0],
    historicalOutput('first'),serverSearchHistory[1],historicalOutput('second'),
    {type:'message',role:'user',content:'synthetic continuation'}];
  const messages=chatMessages({input});
  assert.deepEqual(messages.map(message=>message.role),['assistant','tool','tool','user','user','user']);
  assert.deepEqual(messages[0].tool_calls.map(call=>call.id),['first','second']);
  assert.deepEqual(messages.slice(1,3).map(message=>message.tool_call_id),['first','second']);
  assert.ok(messages[3].content.endsWith(JSON.stringify(serverSearchHistory[0])));
  assert.ok(messages[4].content.endsWith(JSON.stringify(serverSearchHistory[1])));
  assert.equal(messages[5].content,'synthetic continuation');
});

test('unfinished tool batches fail instead of dropping queued server history', () => {
  for (const input of [
    [historicalCall('missing'),...serverSearchHistory],
    [historicalCall('first'),historicalCall('missing'),...serverSearchHistory,historicalOutput('first')],
  ]) {
    const before=structuredClone(input);
    assert.throws(()=>chatMessages({input}),error=>error.constructor.name==='ProtocolError'
      && !error.message.includes('synthetic'));
    assert.deepEqual(input,before);
  }
});
