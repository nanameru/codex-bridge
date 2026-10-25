import assert from 'node:assert/strict';
import test from 'node:test';
import { freeWindow, publishedFree, WhatstokenFreeGate, WHATSTOKEN_POLICY } from '../src/whatstoken-free.mjs';
const at = time => Date.parse('2026-10-25T' + time + '+08:00');
const settings = { site: { default_timezone: 'Asia/Singapore', admin_display_timezone: 'Asia/Singapore' } };
function models() {
  return { models: [{ model_id: 'deepseek-v4.1-flash-1017', has_ha: false,
    discount_schedule: '{"enabled":false}', billing: { billing_type: 'tokens', billing_rule: 'standard',
      pricing_tiers: '[]', prompt_rate: 0.15, completion_rate: 0.6, cached_rate: 0.003,
      fixed_rate: 0, duration_rate: 0, claude_cache_creation_rate: 0, claude_cache_read_rate: 0,
      extended_config: JSON.stringify({ enable_time_multipliers: true, time_input_tz: 'operation',
        web_search_rate: 0, invert_time_multipliers: true, invert_remainder_multiplier: 1,
        time_multipliers: [
          { days: [1,2,3,4,5,6,7], start: '00:00', end: '08:00', multiplier: 0 },
          { days: [1,2,3,4,5,6,7], start: '22:00', end: '00:00', multiplier: 0 },
          { days: [1,2,3,4,5], start: '09:00', end: '12:00', multiplier: 2 },
        ] }) } }] };
}

test('UTC+8の毎日22時から翌8時を判定し終了前の余裕とDSTを守る', () => {
  for (const time of ['00:00:00','07:54:54','22:00:00','23:59:59']) assert.ok(freeWindow(at(time)), time);
  for (const time of ['07:54:55','07:59:59','08:00:00','21:59:59']) assert.equal(freeWindow(at(time)), null, time);
  assert.equal(freeWindow(Date.parse('2026-10-25T01:00:00+11:00')).end, at('08:00:00'));
  assert.equal(freeWindow(Date.parse('2026-06-01T00:00:00+10:00')).end, Date.parse('2026-06-01T08:00:00+08:00'));
});

test('無料料金・運用timezone・通常モデル・翌境界の変更はfail closed', () => {
  assert.equal(publishedFree(models(), settings, at('22:30:00')), true);
  const mutations = [
    m => { m.models[0].model_id += '-special'; },
    m => { m.models.push(structuredClone(m.models[0])); },
    m => { m.models[0].has_ha = true; },
    m => { m.models[0].billing.fixed_rate = 1; },
    m => { m.models[0].billing.pricing_tiers = '[{}]'; },
    m => { m.models[0].discount_schedule = '{"enabled":true}'; },
    m => { m.models[0].billing.extended_config = '{"enable_time_multipliers":false}'; },
    m => { const c=JSON.parse(m.models[0].billing.extended_config);c.time_multipliers[1].end='23:00';m.models[0].billing.extended_config=JSON.stringify(c); },
    m => { const c=JSON.parse(m.models[0].billing.extended_config);c.time_multipliers.push({days:[7],start:'22:31',end:'22:32',multiplier:1});m.models[0].billing.extended_config=JSON.stringify(c); },
    m => { const c=JSON.parse(m.models[0].billing.extended_config);c.web_search_rate=1;m.models[0].billing.extended_config=JSON.stringify(c); },
    m => { const c=JSON.parse(m.models[0].billing.extended_config);c.request_fee=1;m.models[0].billing.extended_config=JSON.stringify(c); },
  ];
  for (const mutate of mutations) { const m=models();mutate(m);assert.equal(publishedFree(m, settings, at('22:30:00')),false); }
  assert.equal(publishedFree(models(), {site:{default_timezone:'Asia/Tokyo'}}, at('22:30:00')),false);
});

test('公開料金の上限付き取得・短いcache・料金変更・ネットワーク失敗を検証する', async () => {
  let clock=at('22:30:00'), current=models(), broken=false, calls=[];
  const gate=new WhatstokenFreeGate({now:()=>clock,fetcher:async(url, options)=>{
    calls.push(url);assert.equal(options.headers.authorization,undefined);assert.equal(options.redirect,'manual');
    if(broken)throw new Error('secret error');
    return Response.json(url===WHATSTOKEN_POLICY.models?current:settings,{headers:{date:new Date(clock).toUTCString()}});
  }});
  assert.equal((await gate.check()).allowed,true);assert.equal(calls.length,2);
  assert.equal((await gate.check()).allowed,true);assert.equal(calls.length,2);
  clock+=5000;broken=true;assert.deepEqual(await gate.check(),{allowed:false,reason:'free_policy_unavailable'});
  broken=false;current.models[0].billing.extended_config='{}';assert.equal((await gate.check()).allowed,false);
  clock=at('13:00:00');calls=[];assert.equal((await gate.check()).allowed,false);assert.equal(calls.length,0);
});

test('redirect・古いserver clock・過大JSONを信用しない', async () => {
  for (const response of [new Response(null,{status:302,headers:{location:'https://untrusted.invalid'}}),
    Response.json(models(),{headers:{date:new Date(at('21:00:00')).toUTCString()}}),
    new Response('a'.repeat(1024*1024+1),{headers:{date:new Date(at('22:30:00')).toUTCString()}})]) {
    const gate=new WhatstokenFreeGate({now:()=>at('22:30:00'),fetcher:async()=>response.clone()});
    assert.equal((await gate.check()).allowed,false);
  }
});
