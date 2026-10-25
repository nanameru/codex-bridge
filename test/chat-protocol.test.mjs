import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { chatToResponses, pipeChatStream } from '../src/chat-protocol.mjs';
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
