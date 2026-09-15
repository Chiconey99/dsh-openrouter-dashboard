import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply} from '../index.js';

function event(seq,id,provider='openrouter') {return {seq,type:'assistant/message',data:{message:{source:{kind:'model',provider,model:'example/model',replayState:{response:{responseId:id}}}}}};}
async function fixture(events=[],inheritedEventCount=0) {
 const directory=await mkdtemp(join(tmpdir(),'or-usage-test-')), routes=new Map(),handlers=new Map(),disposers=[];
 const stored=new Map([['OPENROUTER_API_KEY','sk-or-test-model-key-123456']]);
 const ctx={logger:{warn(){}},sessions:{get(id){return id==='session-a'?{inheritedEventCount,snapshotEvents(from){return events.filter(e=>e.seq>=from)}}:undefined}},credentials:{async resolve(ref){return stored.has(ref)?{value:stored.get(ref)}:undefined},async readRecord(){},async set(ref,key){stored.set(ref,key)}},get(){},on(name,fn){handlers.set(name,fn)},effect(fn){disposers.push(fn())},connection:{fetch:{register(route){routes.set(route.path,route);return async()=>routes.delete(route.path)}}}};
 apply(ctx,{cachePath:join(directory,'charges.json')});
 return {routes,handlers,stored,directory,async close(){for(const dispose of disposers.reverse())await dispose();await rm(directory,{recursive:true,force:true})}};
}
const response = data => Response.json({data});
test('host polls key and balance, excludes fork history, prices and persists known requests',async()=>{
 const oldFetch=globalThis.fetch, calls=[];
 globalThis.fetch=async(url,opts)=>{calls.push(url);if(url.endsWith('/key'))return response({usage:2,usage_daily:.08,usage_weekly:1,limit:null,limit_remaining:null});if(url.endsWith('/credits'))return response({total_credits:20,total_usage:3});return response({id:new URL(url).searchParams.get('id'),total_cost:.08,model:'example/model'})};
 const f=await fixture([event(0,'gen-inherited'),event(1,'gen-own'),event(2,undefined),event(3,'gen-other','other')],1);
 try{
  const route=f.routes.get('/api/openrouter-usage');
  const result=await (await route.fetch(new Request('http://local/api/openrouter-usage?sessionId=session-a'))).json();
  assert.equal(result.key.usageDaily,.08);assert.equal(result.credits.balance,17);assert.equal(result.session.cost,.08);assert.equal(result.session.priced,1);assert.equal(result.session.missing,1);
  assert.ok(!calls.some(url=>url.includes('gen-inherited')));
  const again=await (await route.fetch(new Request('http://local/api/openrouter-usage?sessionId=session-a'))).json();
  assert.equal(again.session.missing,1);assert.equal(calls.length,3);
  const invalid=await route.fetch(new Request('http://local/api/openrouter-usage?sessionId=../../bad'));assert.equal(invalid.status,400);
  const home=await(await route.fetch(new Request('http://local/api/openrouter-usage'))).json();assert.equal(home.session.cost,null);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});
test('management key is read-only validated and stored separately, never returned',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{assert.match(url,/\/credits$/);assert.match(opts.headers.Authorization,/management/);return response({total_credits:20,total_usage:2})};
 const f=await fixture();
 try{
  const key='sk-or-management-key-1234567890', route=f.routes.get('/api/openrouter-usage/management-key');
  const result=await route.fetch(new Request('http://local/api/openrouter-usage/management-key',{method:'POST',body:JSON.stringify({key})}));
  assert.deepEqual(await result.json(),{ok:true});assert.equal(f.stored.get('OPENROUTER_MANAGEMENT_KEY'),key);assert.notEqual(f.stored.get('OPENROUTER_API_KEY'),key);
  const bad=await route.fetch(new Request('http://local/api/openrouter-usage/management-key',{method:'POST',body:'bad'}));assert.equal(bad.status,400);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});
test('403 balance does not suppress working key totals or invent a balance',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async url=>url.endsWith('/credits')?new Response('secret provider error',{status:403}):response({usage:2,usage_daily:1,usage_weekly:2});
 const f=await fixture();
 try{
  const result=await(await f.routes.get('/api/openrouter-usage').fetch(new Request('http://local/api/openrouter-usage'))).json();
  assert.equal(result.key.usageTotal,2);assert.equal(result.credits.balance,null);assert.match(result.credits.error,/management key/);assert.ok(!JSON.stringify(result).includes('secret'));
 }finally{globalThis.fetch=oldFetch;await f.close()}
});
