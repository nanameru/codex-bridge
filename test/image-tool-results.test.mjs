import test from 'node:test';
import assert from 'node:assert/strict';
import { chatMessages } from '../src/chat-protocol.mjs';

test('parallel tool image outputs stay images after all tool results, not JSON Base64 text',()=>{
 const image='data:image/png;base64,aGVsbG8=';
 const input=[{role:'user',content:'Inspect'},
 ...['a','b'].map(call_id=>({type:'function_call',call_id,name:'view_image',arguments:'{}'})),
 ...['b','a'].map(call_id=>({type:'function_call_output',call_id,output:[{type:'input_text',text:'result '+call_id},{type:'input_image',image_url:image,detail:'original'}]}))];
 const messages=chatMessages({input});
 assert.deepEqual(messages.map(m=>m.role),['user','assistant','tool','tool','user']);
 assert.deepEqual(messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id),['b','a']);
 assert.ok(messages.filter(m=>m.role==='tool').every(m=>!m.content.includes('base64')));
 assert.ok(messages[2].content.includes('result b'));assert.ok(messages[3].content.includes('result a'));
 const images=messages.at(-1).content.filter(p=>p.type==='image_url');
 assert.equal(images.length,2);assert.equal(images[0].image_url.url,image);assert.equal(images[0].image_url.detail,'original');
});

test('text-only and JSON-string tool results are not reinterpreted as images',()=>{
 const output='[{"type":"input_image","image_url":"data:image/png;base64,aGVsbG8="}]';
 const messages=chatMessages({input:[{type:'function_call',call_id:'a',name:'f',arguments:'{}'}, {type:'function_call_output',call_id:'a',output}]});
 assert.equal(messages.length,2);assert.equal(messages[1].content,output);
});

test('tool image results retain call association for mixed text and image parallel batches',()=>{
 const image='data:image/png;base64,aGVsbG8=';
 const input=[...['a','b'].map(call_id=>({type:'function_call',call_id,name:'f',arguments:'{}'})),
 {type:'function_call_output',call_id:'a',output:[{type:'input_image',image_url:image}]},
 {type:'function_call_output',call_id:'b',output:'text result'}];
 const messages=chatMessages({input});
 assert.deepEqual(messages.map(m=>m.role),['assistant','tool','tool','user']);
 assert.ok(messages.at(-1).content.some(p=>p.text==='Tool result a:'));
 assert.throws(()=>chatMessages({input:input.slice(0,-1)}),/未完了/);
});
