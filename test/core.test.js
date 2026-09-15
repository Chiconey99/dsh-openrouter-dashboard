import test from 'node:test';
import assert from 'node:assert/strict';
import {keyView,creditView,numberOrNull,safeError,readOpenRouter,requestFromEvent,summarizeSession} from '../core.js';

test('key usage is separate from account balance and allowance',()=>{
  assert.deepEqual(keyView({usage_daily:.08,usage_weekly:.8,usage:2,limit:10,limit_remaining:8}),{usageDaily:.08,usageWeekly:.8,usageTotal:2,limit:10,limitRemaining:8});
  assert.deepEqual(creditView({total_credits:20,total_usage:3}),{totalCredits:20,totalUsage:3,balance:17});
  assert.equal(creditView({total_credits:0,total_usage:1}).balance,-1);
});
test('unknown data is never shown as zero',()=>{
  for(const value of [undefined,null,NaN,Infinity,-1,'3'])assert.equal(numberOrNull(value),null);
  assert.equal(numberOrNull(0),0);assert.equal(creditView({}).balance,null);assert.equal(keyView({}).usageDaily,null);
});
test('reads use fixed OpenRouter origin and never leak failed bodies',async()=>{
  let called;
  const data=await readOpenRouter('/key','secret',{fetchImpl:async(url,options)=>{called={url,options};return new Response('{"data":{"usage":1}}');}});
  assert.equal(data.usage,1);assert.equal(called.url,'https://openrouter.ai/api/v1/key');assert.equal(called.options.redirect,'error');
  assert.equal(called.options.headers.Authorization,'Bearer secret');
  try {await readOpenRouter('/credits','secret',{fetchImpl:async()=>new Response('secret',{status:403})});assert.fail();}
  catch(error){assert.equal(error.status,403);assert.ok(!error.message.includes('secret'));assert.match(safeError(error),/management key/);}
});
test('session only reads its model provenance and owned leaves',()=>{
  const event={type:'assistant/message',data:{message:{source:{kind:'model',provider:'openrouter',model:'example/model',replayState:{response:{responseId:'gen-abc'}}}}}};
  assert.deepEqual(requestFromEvent(event),{id:'gen-abc',model:'example/model'});
  assert.equal(requestFromEvent(event,'other'),null);
  event.data.message.source.replayState.response.responseId=undefined;
  assert.deepEqual(requestFromEvent(event),{id:null,model:'example/model'});
});
test('session costs are exact known charges with pending and missing coverage',()=>{
  const costs=new Map([['gen-a',{cost:.08,model:'one'}],['gen-b',{cost:0,model:'free'}]]);
  const result=summarizeSession('session-a',[{id:'gen-a'},{id:'gen-b'},{id:'gen-c'}],costs,2);
  assert.equal(result.cost,.08);assert.equal(result.priced,2);assert.equal(result.requests,5);assert.equal(result.pending,1);assert.equal(result.missing,2);
  assert.equal(summarizeSession('session-a',[{id:'gen-c'}],costs).cost,null);
  assert.equal(summarizeSession('session-a',[],costs,1).cost,null);
  assert.equal(summarizeSession('session-a',[],costs).cost,0);
  assert.equal(summarizeSession(null,[],costs).cost,null);
});
