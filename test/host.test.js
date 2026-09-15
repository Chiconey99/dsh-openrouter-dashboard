import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply} from '../index.js';

function event(seq,id,provider='openrouter') {return {seq,type:'assistant/message',data:{message:{source:{kind:'model',provider,model:'example/model',replayState:{response:{responseId:id}}}}}};}
// DeepSeek logs carry no request id. The model a call used lives on the preceding
// `request/header`, and the resolved token counts live on the message's `usage`.
function header(seq,model,provider='deepseek-official',extra={}) {return {seq,type:'request/header',data:{header:{config:{provider,model}},...extra}};}
function usageEvent(seq,time,usage,provider='deepseek-official',model) {return {seq,time:time??Date.parse(OFF_PEAK),type:'assistant/message',data:{message:{source:{kind:'model',provider,...model?{model}:{}}},usage}};}
const plusHours=(base,hours)=>new Date(Date.parse(base)+hours*3600000).toISOString();
// 2026-09-15T13:00Z is a Tuesday afternoon, which is off-peak.
const OFF_PEAK='2026-09-15T13:00:00.000Z';
const deepseekUsage=(f,id,period)=>f.routes.get('/api/openrouter-usage').fetch(new Request('http://local/api/openrouter-usage?deepseek=1'+(id?'&sessionId='+id:'')+(period?'&period='+period:'')));
const deepseekKey=f=>f.routes.get('/api/openrouter-usage/deepseek-key');
// Priced sums accumulate binary floating-point error, so compare within a cent's
// worth of slack rather than demanding exact equality from division by 1e6.
const closeTo=(actual,expected,message)=>{assert.ok(Math.abs(actual-expected)<1e-9,`${message||'value'}: expected ~${expected}, got ${actual}`);};
async function fixture(events=[],inheritedEventCount=0,options={}) {
 const directory=await mkdtemp(join(tmpdir(),'or-usage-test-')), routes=new Map(),handlers=new Map(),disposers=[];
 const stored=new Map([['OPENROUTER_API_KEY','sk-or-test-model-key-123456'],['DEEPSEEK_API_KEY','sk-deepseek-test-key-000001']]);
 const ctx={logger:{warn(){}},sessions:{get(id){return id==='session-a'?{inheritedEventCount,snapshotEvents(from,to){return events.filter(e=>e.seq>=from&&e.seq<to)}}:undefined}},credentials:{async resolve(ref){return stored.has(ref)?{value:stored.get(ref)}:undefined},async readRecord(){},async set(ref,key){stored.set(ref,key)}},get(name){return name==='sessionPersistence'?options.persistence:undefined},on(name,fn){handlers.set(name,fn)},effect(fn){disposers.push(fn())},connection:{fetch:{register(route){routes.set(route.path,route);return async()=>routes.delete(route.path)}}}};
 const cachePath=join(directory,'charges.json');
 if(options.cache!==undefined)await writeFile(cachePath,typeof options.cache==='string'?options.cache:JSON.stringify(options.cache));
 apply(ctx,{cachePath,provider:options.provider});
 let disposed=false;
 const dispose=async()=>{if(disposed)return;disposed=true;for(const fn of disposers.reverse())await fn()};
 return {routes,handlers,stored,directory,cachePath,ctx,dispose,async close(){await dispose();await rm(directory,{recursive:true,force:true})}};
}
const response = data => Response.json({data});
const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));
const usageRequest = (f,id,signal) => f.routes.get('/api/openrouter-usage').fetch(new Request('http://local/api/openrouter-usage'+(id?'?sessionId='+id:''),{signal}));
const metadata = url => url.endsWith('/key') ? response({usage:2,usage_daily:.08,usage_weekly:1}) : url.endsWith('/credits') ? response({total_credits:20,total_usage:3}) : response({id:new URL(url).searchParams.get('id'),total_cost:.08,model:'example/model'});
function held(signal, gate) {
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(new DOMException('Cancelled','AbortError'))};
  if(signal.aborted)return abort();
  signal.addEventListener('abort',abort,{once:true});
  gate.promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)});
 });
}
async function bounded(promise) {
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Operation failed to settle promptly')),1500)})])}
 finally{clearTimeout(timer)}
}
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
test('simultaneous cold scans share a cursor and count missing IDs once',async()=>{
 const oldFetch=globalThis.fetch, entered=deferred(), release=deferred();let reads=0,closes=0;
 globalThis.fetch=async url=>metadata(url);
 const persistence={async open(){return {inheritedEventCount:1,async read(from,length,{signal}){reads++;assert.equal(from,1);assert.equal(length,256);entered.resolve();await held(signal,release);return {events:[event(1,undefined),event(2,'gen-cold')]};},async close(){closes++}}}};
 const f=await fixture([],0,{persistence});
 try{
  const first=usageRequest(f,'session-cold');await bounded(entered.promise);
  const second=usageRequest(f,'session-cold');await tick();assert.equal(reads,1);
  release.resolve();const results=await Promise.all([first,second]);
  for(const result of results){assert.equal(result.status,200);const data=await result.json();assert.equal(data.session.missing,1);assert.equal(data.session.requests,2)}
  assert.equal(reads,1);assert.equal(closes,1);
 }finally{release.resolve();await f.close();globalThis.fetch=oldFetch}
});

test('overlapping pricing requests have no backlog and cancellation frees slots',async()=>{
 const oldFetch=globalThis.fetch, entered=deferred(), release=deferred(), generationCalls=[];let hold=true;
 globalThis.fetch=async(url,opts)=>{
  if(!url.includes('/generation?'))return metadata(url);
  generationCalls.push({url,signal:opts.signal});if(generationCalls.length===2)entered.resolve();
  return hold?held(opts.signal,release):metadata(url);
 };
 const f=await fixture(Array.from({length:12},(_,i)=>event(i,'gen-'+i)));
 const live=f.ctx.sessions.get;f.ctx.sessions.get=id=>id==='session-b'?{inheritedEventCount:0,snapshotEvents(from,to){return [event(0,'gen-b')].filter(e=>e.seq>=from&&e.seq<to)}}:live(id);
 const cancellation=new AbortController();
 try{
  const first=usageRequest(f,'session-a',cancellation.signal);await bounded(entered.promise);
  const overlap=await bounded(usageRequest(f,'session-a'));assert.equal((await overlap.json()).session.pending,12);
  const other=await bounded(usageRequest(f,'session-b'));assert.equal((await other.json()).session.pending,1);
  assert.equal(generationCalls.length,2);
  cancellation.abort();assert.equal((await bounded(first)).status,503);await tick();
  assert.ok(generationCalls.every(call=>call.signal.aborted));assert.equal(generationCalls.length,2);
  hold=false;const recovered=await bounded(usageRequest(f,'session-b'));assert.equal((await recovered.json()).session.priced,1);assert.equal(generationCalls.length,3);
 }finally{cancellation.abort();release.resolve(response({}));await f.close();globalThis.fetch=oldFetch}
});

test('one aborted account subscriber does not cancel another tab',async()=>{
 const oldFetch=globalThis.fetch, entered=deferred(), gates=[], signals=[];let calls=0;
 globalThis.fetch=async(url,opts)=>{calls++;signals.push(opts.signal);const gate=deferred();gates.push({gate,url});if(calls===2)entered.resolve();return held(opts.signal,gate)};
 const f=await fixture(), cancellation=new AbortController();
 try{
  const first=usageRequest(f,null,cancellation.signal);await bounded(entered.promise);
  const second=usageRequest(f);await tick();cancellation.abort();assert.equal((await bounded(first)).status,503);
  assert.ok(signals.every(signal=>!signal.aborted));
  for(const {gate,url} of gates)gate.resolve(metadata(url));
  assert.equal((await bounded(second)).status,200);assert.equal(calls,2);
 }finally{cancellation.abort();for(const {gate,url} of gates)gate.resolve(metadata(url));await f.close();globalThis.fetch=oldFetch}
});

test('the last cancelled account subscriber aborts outstanding fetches',async()=>{
 const oldFetch=globalThis.fetch, entered=deferred(), gate=deferred(), signals=[];
 globalThis.fetch=async(url,opts)=>{signals.push(opts.signal);if(signals.length===2)entered.resolve();return held(opts.signal,gate)};
 const f=await fixture(), cancellation=new AbortController();
 try{
  const pending=usageRequest(f,null,cancellation.signal);await bounded(entered.promise);cancellation.abort();
  assert.equal((await bounded(pending)).status,503);await tick();assert.ok(signals.every(signal=>signal.aborted));
  globalThis.fetch=async url=>metadata(url);assert.equal((await bounded(usageRequest(f))).status,200);
 }finally{cancellation.abort();gate.resolve(response({}));await f.close();globalThis.fetch=oldFetch}
});

test('credential rotation cancels an old account refresh without mixed snapshots',async()=>{
 const oldFetch=globalThis.fetch, entered=deferred(), gate=deferred(), oldSignals=[];
 const newKey='new-key';
 globalThis.fetch=async(url,opts)=>{
  if(opts.headers.Authorization.endsWith(newKey))return url.endsWith('/key')?response({usage:90,usage_daily:9,usage_weekly:20}):response({total_credits:100,total_usage:10});
  oldSignals.push(opts.signal);if(oldSignals.length===2)entered.resolve();return held(opts.signal,gate);
 };
 const f=await fixture();
 try{
  const pending=usageRequest(f);await bounded(entered.promise);f.stored.set('OPENROUTER_API_KEY',newKey);f.handlers.get('credentials/reference-updated')();
  assert.equal((await bounded(pending)).status,503);assert.ok(oldSignals.every(signal=>signal.aborted));
  const next=await(await bounded(usageRequest(f))).json();assert.equal(next.key.usageTotal,90);assert.equal(next.credits.balance,90);
  gate.resolve(response({usage:1,usage_daily:1,usage_weekly:1}));await tick();
  assert.equal((await(await usageRequest(f)).json()).key.usageTotal,90);
 }finally{gate.resolve(response({}));await f.close();globalThis.fetch=oldFetch}
});

test('rotation during credential resolution refuses a mixed key snapshot before networking',async()=>{
 const oldFetch=globalThis.fetch,entered=deferred(),gate=deferred();let calls=0;
 globalThis.fetch=async url=>{calls++;return metadata(url)};
 const f=await fixture(),resolve=f.ctx.credentials.resolve;
 f.ctx.credentials.resolve=async ref=>{if(ref==='OPENROUTER_MANAGEMENT_KEY'){entered.resolve();await gate.promise}return resolve(ref)};
 try{
  const pending=usageRequest(f);await bounded(entered.promise);f.stored.set('OPENROUTER_API_KEY','new-key');f.handlers.get('credentials/reference-updated')();gate.resolve();
  assert.equal((await bounded(pending)).status,503);assert.equal(calls,0);
  assert.equal((await bounded(usageRequest(f))).status,200);assert.equal(calls,2);
 }finally{gate.resolve();await f.close();globalThis.fetch=oldFetch}
});

test('live history is read in bounded pages and resumes without recounting missing IDs',async()=>{
 const oldFetch=globalThis.fetch;globalThis.fetch=async url=>metadata(url);
 const events=Array.from({length:4100},(_,i)=>event(i,undefined));
 const f=await fixture(events),get=f.ctx.sessions.get;let pages=0;
 f.ctx.sessions.get=id=>{const live=get(id);if(!live)return live;return {...live,snapshotEvents(from,to){pages++;assert.equal(to-from,256);return live.snapshotEvents(from,to)}}};
 try{
  const partial=await(await usageRequest(f,'session-a')).json();assert.equal(partial.session.missing,4096);assert.match(partial.session.error,/still being recovered/);assert.equal(pages,16);
  const complete=await(await usageRequest(f,'session-a')).json();assert.equal(complete.session.missing,4100);assert.equal(complete.session.error,null);assert.equal(pages,17);
  const again=await(await usageRequest(f,'session-a')).json();assert.equal(again.session.missing,4100);
 }finally{await f.close();globalThis.fetch=oldFetch}
});

test('rotation stops remaining history pricing and does not poison the new credential',async()=>{
 const oldFetch=globalThis.fetch, entered=deferred(), gate=deferred(), calls=[];
 const newKey='new-key';
 globalThis.fetch=async(url,opts)=>{
  if(!url.includes('/generation?'))return metadata(url);
  calls.push(opts.headers.Authorization);if(opts.headers.Authorization.endsWith(newKey))return metadata(url);
  if(calls.length===2)entered.resolve();return held(opts.signal,gate);
 };
 const f=await fixture(Array.from({length:10},(_,i)=>event(i,'gen-rotation-'+i)));
 try{
  const pending=usageRequest(f,'session-a');await bounded(entered.promise);f.stored.set('OPENROUTER_API_KEY',newKey);f.handlers.get('credentials/record-updated')();
  assert.equal((await bounded(pending)).status,503);await tick();
  const data=await(await bounded(usageRequest(f,'session-a'))).json();assert.equal(data.session.priced,8);assert.equal(calls.filter(key=>!key.endsWith(newKey)).length,2);
 }finally{gate.resolve(response({}));await f.close();globalThis.fetch=oldFetch}
});

test('account Retry-After preserves successful stale fields and throttles endpoints independently',async()=>{
 const oldFetch=globalThis.fetch, oldNow=Date.now;let now=1700000000000,fail=false,keyCalls=0,creditCalls=0;
 Date.now=()=>now;
 globalThis.fetch=async url=>{
  if(url.endsWith('/key')){keyCalls++;return fail?new Response('',{status:429,headers:{'retry-after':'120'}}):metadata(url)}
  creditCalls++;return metadata(url);
 };
 const f=await fixture();
 try{
  const first=await(await usageRequest(f)).json();now+=26000;fail=true;
  const stale=await(await usageRequest(f)).json();assert.equal(stale.key.usageTotal,2);assert.equal(stale.key.updatedAt,first.key.updatedAt);assert.match(stale.key.error,/rate limit/);
  now+=30000;await usageRequest(f);assert.equal(keyCalls,2);assert.equal(creditCalls,3);
  now+=90001;fail=false;const recovered=await(await usageRequest(f)).json();assert.equal(keyCalls,3);assert.equal(recovered.key.error,null);
 }finally{Date.now=oldNow;await f.close();globalThis.fetch=oldFetch}
});

test('pricing Retry-After prevents other generations bypassing provider cooldown',async()=>{
 const oldFetch=globalThis.fetch,oldNow=Date.now;let now=1700000000000, calls=0,limited=true;
 Date.now=()=>now;
 globalThis.fetch=async url=>{if(!url.includes('/generation?'))return metadata(url);calls++;return limited?new Response('',{status:429,headers:{'retry-after':'120'}}):metadata(url)};
 const f=await fixture(Array.from({length:4},(_,i)=>event(i,'gen-retry-'+i)));
 try{
  await usageRequest(f,'session-a');assert.equal(calls,2);
  now+=31000;await usageRequest(f,'session-a');assert.equal(calls,2);
  now+=90001;limited=false;const data=await(await usageRequest(f,'session-a')).json();assert.equal(calls,6);assert.equal(data.session.priced,4);
 }finally{Date.now=oldNow;await f.close();globalThis.fetch=oldFetch}
});

test('disposal aborts pricing and flushes finished charges plus observed stream IDs',async()=>{
 const oldFetch=globalThis.fetch, entered=deferred(), gate=deferred();
 globalThis.fetch=async(url,opts)=>{if(url.includes('gen-pending')){entered.resolve();return held(opts.signal,gate)}return metadata(url)};
 const f=await fixture([event(0,'gen-finished'),event(1,'gen-pending')]);
 try{
  const pending=usageRequest(f,'session-a');await bounded(entered.promise);await tick();
  const stream=f.handlers.get('llm/stream')({provider:'openrouter',sessionId:'session-a',model:'stream/model'},()=> (async function*(){yield {type:'finish',replayState:{response:{responseId:'gen-stream'}}}})());
  for await(const chunk of stream)assert.equal(chunk.type,'finish');
  await bounded(f.dispose());assert.equal((await bounded(pending)).status,503);
  const saved=JSON.parse(await readFile(f.cachePath,'utf8'));assert.equal(saved.provider,'openrouter');assert.equal(saved.costs.find(row=>row.id==='gen-finished').cost,.08);
  assert.ok(saved.sessions[0].requests.some(row=>row.id==='gen-stream'));assert.ok((await readdir(f.directory)).every(name=>!name.endsWith('.tmp')));
 }finally{gate.resolve(response({}));await f.close();globalThis.fetch=oldFetch}
});

test('disposal closes cold history and prevents management storage after validation cancellation',async()=>{
 const oldFetch=globalThis.fetch, reading=deferred(), validating=deferred(), gate=deferred();let closes=0;
 globalThis.fetch=async(url,opts)=>{if(opts.headers.Authorization.includes('management')){validating.resolve();return held(opts.signal,gate)}return metadata(url)};
 const persistence={async open(){return {inheritedEventCount:0,async read(from,length,{signal}){reading.resolve();await held(signal,gate);return {events:[]}},async close(){closes++}}}};
 const f=await fixture([],0,{persistence});
 try{
  const pending=usageRequest(f,'session-cold');await bounded(reading.promise);
  const setup=f.routes.get('/api/openrouter-usage/management-key').fetch(new Request('http://local/api/openrouter-usage/management-key',{method:'POST',body:JSON.stringify({key:'sk-or-management-key-1234567890'})}));await bounded(validating.promise);
  await bounded(f.dispose());assert.equal(closes,1);assert.equal((await bounded(pending)).status,503);assert.equal((await bounded(setup)).status,400);assert.ok(!f.stored.has('OPENROUTER_MANAGEMENT_KEY'));
 }finally{gate.resolve(response({}));await f.close();globalThis.fetch=oldFetch}
});

test('malformed credits cannot verify or replace a management key',async()=>{
 const oldFetch=globalThis.fetch,f=await fixture();
 try{
  f.stored.set('OPENROUTER_MANAGEMENT_KEY','old-management-value');
  for(const data of [[],{},null,{total_credits:10},{total_credits:-1,total_usage:0},{total_credits:10,total_usage:'2'}]){
   globalThis.fetch=async()=>response(data);
   const result=await f.routes.get('/api/openrouter-usage/management-key').fetch(new Request('http://local/api/openrouter-usage/management-key',{method:'POST',body:JSON.stringify({key:'sk-or-management-key-1234567890'})}));
   assert.equal(result.status,400);assert.equal(f.stored.get('OPENROUTER_MANAGEMENT_KEY'),'old-management-value');
  }
 }finally{await f.close();globalThis.fetch=oldFetch}
});

test('legacy v1 cache remains supported and malformed rows cannot poison totals',async()=>{
 const oldFetch=globalThis.fetch;let generationCalls=0;
 globalThis.fetch=async url=>{if(url.includes('/generation?'))generationCalls++;return metadata(url)};
 const f=await fixture([event(0,'gen-saved'),event(1,'gen-invalid')],0,{cache:{version:1,costs:[null,{id:'gen-saved',cost:.5,model:'saved/model'},{id:'gen-invalid',cost:-10,model:'bad/model'}],sessions:[null,{id:'session-a',requests:[null,{id:'gen-saved',model:'saved/model'}]}]}});
 try{
  const data=await(await usageRequest(f,'session-a')).json();assert.equal(data.session.cost,.58);assert.equal(data.session.priced,2);assert.equal(generationCalls,1);
 }finally{await f.close();globalThis.fetch=oldFetch}
});

test('corrupt cache recovers from history without trusting invalid generation metadata',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async url=>url.includes('/generation?')?response({id:'gen-wrong',total_cost:10}):metadata(url);
 const f=await fixture([event(0,'gen-real')],0,{cache:'{bad json'});
 try{
  const data=await(await usageRequest(f,'session-a')).json();assert.equal(data.session.cost,null);assert.equal(data.session.pending,1);
  await f.dispose();const saved=JSON.parse(await readFile(f.cachePath,'utf8'));assert.equal(saved.costs.length,0);assert.equal(saved.sessions[0].requests[0].id,'gen-real');
 }finally{await f.close();globalThis.fetch=oldFetch}
});

test('provider-owned cache cannot leak charges to or be overwritten by another provider',async()=>{
 const oldFetch=globalThis.fetch;globalThis.fetch=async url=>metadata(url);
 const cache={version:1,provider:'another-provider',costs:[{id:'gen-foreign',cost:999,model:'foreign'}],sessions:[{id:'session-a',requests:[{id:'gen-foreign',model:'foreign'}]}]};
 const f=await fixture([event(0,'gen-own')],0,{cache});
 try{
  const data=await(await usageRequest(f,'session-a')).json();assert.equal(data.session.cost,.08);assert.match(data.session.error,/cache/);
  await f.dispose();assert.deepEqual(JSON.parse(await readFile(f.cachePath,'utf8')),cache);
 }finally{await f.close();globalThis.fetch=oldFetch}
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

test('the deepseek view reads the documented balance endpoint with the DeepSeek key only',async()=>{
 const oldFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,opts)=>{calls.push({url,authorization:opts.headers.Authorization});return Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'12.34',granted_balance:'1.50',topped_up_balance:'10.84'}]})};
 const f=await fixture();
 try{
  const data=await(await deepseekUsage(f)).json();
  assert.equal(calls.length,1,'only the balance endpoint is called');
  assert.equal(calls[0].url,'https://api.deepseek.com/user/balance');
  assert.equal(calls[0].authorization,'Bearer sk-deepseek-test-key-000001');
  assert.equal(data.balance.balance,12.34);assert.equal(data.balance.granted,1.5);assert.equal(data.balance.toppedUp,10.84);
  assert.equal(data.balance.currency,'USD');assert.equal(data.balance.isAvailable,true);assert.equal(data.balance.error,null);
  assert.equal(data.keyConfigured,true);assert.equal(data.updatedAt.length>0,true);
  // No DeepSeek key ever reaches the browser.
  assert.ok(!JSON.stringify(data).includes('sk-deepseek-test-key-000001'));
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('deepseek session spend is reconstructed from tokens and attributed to a model',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 const off=Date.parse(OFF_PEAK);
 const events=[header(0,'deepseek-flash'),usageEvent(1,off,{inputTokens:1e6,outputTokens:1e6,cacheReadTokens:1e6})];
 const f=await fixture(events);
 try{
  const data=await(await deepseekUsage(f,'session-a','Session')).json();
  // Off-peak flash: 1M cache-hit + 1M miss + 1M output.
  closeTo(data.deepseek.cost,0.003+0.15+0.6,'flash session spend');
  assert.equal(data.deepseek.calls,1);assert.equal(data.deepseek.pricedCalls,1);
  assert.equal(data.deepseek.models[0].model,'deepseek-flash');
  assert.deepEqual(data.deepseek.tokens,{input:1e6,output:1e6,cacheRead:1e6,cacheWrite:0});
  assert.equal(data.deepseek.unattributedCalls,0);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('deepseek attribution follows the route and never invents a model',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 const off=Date.parse(OFF_PEAK);
 const events=[
  header(0,'deepseek-flash'),
  usageEvent(1,off,{outputTokens:1e6}),
  // A changed header repoints attribution to the new model.
  header(2,'deepseek-v4-pro',"deepseek-official",{reason:'change',startsSeries:true}),
  usageEvent(3,off,{outputTokens:1e6}),
  // A series boundary re-states the same route, so every sample after it keeps that
  // model: `request/header` is what states the route, not the boundary marker.
  header(4,'deepseek-flash',"deepseek-official",{reason:'series',startsSeries:true}),
  usageEvent(5,off,{outputTokens:1e6}),
  usageEvent(6,off,{outputTokens:1e6})
 ];
 const f=await fixture(events);
 try{
  const data=await(await deepseekUsage(f,'session-a','Session')).json();
  const byModel=Object.fromEntries(data.deepseek.models.map(row=>[row.model,row]));
  closeTo(byModel['deepseek-flash'].cost,0.6*3,'flash subtotal');
  assert.equal(byModel['deepseek-flash'].calls,3,'samples 1, 5 and 6 all follow a flash header');
  closeTo(byModel['deepseek-v4-pro'].cost,1.98,'pro subtotal');
  assert.equal(byModel['deepseek-v4-pro'].calls,1);
  assert.equal(data.deepseek.unattributedCalls,0,'every sample had a preceding route');
  closeTo(data.deepseek.cost,0.6*3+1.98,'attributed spend');
  assert.equal(data.deepseek.calls,4);
  assert.equal(data.deepseek.pricedCalls,4);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('a deepseek sample with no preceding route is counted but never priced',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 // The log opens on a sample, so no `request/header` states a route for it. Its
 // tokens are real and must appear, but it cannot be priced against a guess.
 const f=await fixture([usageEvent(0,Date.parse(OFF_PEAK),{inputTokens:2e6,outputTokens:1e6})]);
 try{
  const data=await(await deepseekUsage(f,'session-a','Session')).json();
  assert.equal(data.deepseek.calls,1);
  assert.equal(data.deepseek.unattributedCalls,1);
  assert.equal(data.deepseek.cost,null,'an unattributable sample yields no cost, not zero');
  assert.deepEqual(data.deepseek.tokens,{input:2e6,output:1e6,cacheRead:0,cacheWrite:0});
  assert.equal(data.deepseek.models[0].model,'Unattributed');
  assert.equal(data.deepseek.models[0].priced,false);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('deepseek peak pricing doubles the off-peak rate for the same call',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 // 02:00 UTC on a Tuesday is inside a published peak window.
 const peak=Date.parse('2026-09-15T02:00:00.000Z');
 const f=await fixture([header(0,'deepseek-flash'),usageEvent(1,peak,{outputTokens:1e6})]);
 try{
  const data=await(await deepseekUsage(f,'session-a','Session')).json();
  assert.equal(data.deepseek.cost,1.2,'peak output rate is double the off-peak 0.6');
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('deepseek records live token usage from a stream finish without a request id',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 const f=await fixture([]);
 try{
  const stream=f.handlers.get('llm/stream')({provider:'deepseek-official',sessionId:'session-a',model:'deepseek-flash'},()=>(async function*(){
   yield {type:'text-delta',index:0,text:'hi'};
   yield {type:'usage',usage:{inputTokens:1e6,outputTokens:1e6}};
   yield {type:'finish',reason:{kind:'stop'}};
  })());
  for await(const chunk of stream)assert.ok(chunk.type);
  const data=await(await deepseekUsage(f,'session-a','Session')).json();
  assert.equal(data.deepseek.calls,1);
  assert.equal(data.deepseek.models[0].model,'deepseek-flash');
  closeTo(data.deepseek.cost,0.15+0.6,'live capture spend');
  await f.dispose();
  // The ledger is durable, so the figure survives a restart.
  const saved=JSON.parse(await readFile(f.cachePath,'utf8'));
  assert.equal(saved.deepseek.length,1);
  assert.equal(saved.deepseek[0].model,'deepseek-flash');
  assert.equal(saved.deepseek[0].outputTokens,1e6);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('an interrupted deepseek stream records no usage it never resolved',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 const f=await fixture([]);
 try{
  const stream=f.handlers.get('llm/stream')({provider:'deepseek-official',sessionId:'session-a',model:'deepseek-flash'},()=>(async function*(){
   yield {type:'text-delta',index:0,text:'partial'};
   throw new Error('stream failed');
  })());
  await assert.rejects(async()=>{for await(const chunk of stream)void chunk});
  await new Promise(resolve=>setImmediate(resolve));
  const data=await(await deepseekUsage(f,'session-a','Session')).json();
  assert.equal(data.deepseek.calls,0,'a failed stream must not invent token counts');
  assert.equal(data.deepseek.cost,null);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('deepseek day and week scopes are bounded by UTC and total never prunes a rate',async()=>{
 const oldFetch=globalThis.fetch,oldNow=Date.now;let now=Date.parse('2026-09-16T15:30:00.000Z');
 Date.now=()=>now;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 // 2026-09-16 is a Wednesday; its week began Monday 2026-09-14.
 const today=Date.parse('2026-09-16T10:00:00.000Z'), yesterday=Date.parse('2026-09-15T10:00:00.000Z'), lastWeek=Date.parse('2026-09-10T10:00:00.000Z');
 const f=await fixture([
  header(0,'deepseek-flash'),
  usageEvent(1,lastWeek,{outputTokens:1e6}),
  usageEvent(2,yesterday,{outputTokens:1e6}),
  usageEvent(3,today,{outputTokens:1e6})
 ]);
 try{
  const day=await(await deepseekUsage(f,'session-a','Day')).json();
  const week=await(await deepseekUsage(f,'session-a','Week')).json();
  const session=await(await deepseekUsage(f,'session-a','Session')).json();
  assert.equal(day.deepseek.calls,1);assert.equal(week.deepseek.calls,2);assert.equal(session.deepseek.calls,3);
  assert.equal(day.deepseek.cost,0.6);
  closeTo(week.deepseek.cost,0.6*2,'week scope spend');
  closeTo(session.deepseek.cost,0.6*3,'session scope spend');
  assert.equal(session.deepseek.scope,'Session + other sessions in this ledger');
 }finally{Date.now=oldNow;globalThis.fetch=oldFetch;await f.close()}
});

test('the deepseek token ledger is idempotent across rescans and restarts',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 const off=Date.parse(OFF_PEAK);
 const events=[header(0,'deepseek-flash'),usageEvent(1,off,{outputTokens:1e6})];
 const f=await fixture(events);
 try{
  // Three refreshes over the same unchanged log must not triple the spend.
  for(let i=0;i<3;i++){
   const data=await(await deepseekUsage(f,'session-a','Session')).json();
   assert.equal(data.deepseek.calls,1);
   assert.equal(data.deepseek.cost,0.6);
  }
  // A restart reloads the ledger from disk and reaches the identical figure.
  await f.dispose();
  const reopened=await fixture([],0,{cache:JSON.parse(await readFile(f.cachePath,'utf8'))});
  try{
   const data=await(await deepseekUsage(reopened,'session-a','Session')).json();
   assert.equal(data.deepseek.calls,1);
   assert.equal(data.deepseek.cost,0.6);
  }finally{await reopened.close()}
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('a deepseek ledger from an older cache loads and unknown extra fields are ignored',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 const off=Date.parse(OFF_PEAK);
 // The v1 file predates the ledger; the older write shape must still load.
 const f=await fixture([],0,{cache:{version:1,costs:[],sessions:[{id:'session-a',requests:[]}]}});
 try{
  const first=await(await deepseekUsage(f,'session-a','Session')).json();
  assert.equal(first.deepseek.calls,0,'an older cache simply has no token history');
  assert.equal(first.deepseek.cost,null);
  const rows=first.deepseek.models;assert.deepEqual(rows,[]);
 }finally{globalThis.fetch=oldFetch;await f.close()}
 const g=await fixture([],0,{cache:{version:1,costs:[],sessions:[],deepseek:[{session:'session-a',id:'live-1',time:off,model:'deepseek-flash',inputTokens:0,outputTokens:1e6,cacheReadTokens:0,cacheWriteTokens:0}]}});
 try{
  const data=await(await deepseekUsage(g,'session-a','Session')).json();
  assert.equal(data.deepseek.calls,1);
  assert.equal(data.deepseek.cost,0.6);
  // A row missing its owning session cannot be scoped and is dropped, not guessed at.
  const orphan=await fixture([],0,{cache:{version:1,costs:[],sessions:[],deepseek:[{id:'live-1',time:off,model:'deepseek-flash',outputTokens:1e6}]}});
  try{
   const dropped=await(await deepseekUsage(orphan,'session-a','Session')).json();
   assert.equal(dropped.deepseek.calls,0);
  }finally{await orphan.close()}
 }finally{globalThis.fetch=oldFetch;await g.close()}
});

test('a malformed deepseek ledger is refused instead of poisoning totals',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'5.00'}]});
 for(const bad of ['{"version":1,"costs":[],"deepseek":"nope"}',JSON.stringify({version:1,costs:[],deepseek:[null,{id:'live-1'},{id:'live-2',time:1,model:'deepseek-flash',outputTokens:-5}]})]){
  const f=await fixture([],0,{cache:bad});
  try{
   const data=await(await deepseekUsage(f,'session-a','Session')).json();
   assert.equal(data.deepseek.calls,0,JSON.stringify(bad));
   assert.equal(data.deepseek.cost,null);
  }finally{globalThis.fetch=oldFetch;await f.close()}
 }
});

test('deepseek balance surfaces an error without hiding a configured key',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({is_available:false,balance_infos:[{currency:'CNY',total_balance:'88.00'}]});
 const f=await fixture();
 try{
  const data=await(await deepseekUsage(f)).json();
  assert.equal(data.balance.currency,'CNY');
  assert.equal(data.balance.balance,88);
  assert.equal(data.balance.isAvailable,false);
 }finally{globalThis.fetch=oldFetch;await f.close()}

 try{
  globalThis.fetch=async()=>new Response('provider detail must not leak',{status:401});
  const g=await fixture();
  try{
   const data=await(await deepseekUsage(g)).json();
   assert.equal(data.balance.balance,null);
   assert.match(data.balance.error,/401/);
   assert.ok(!JSON.stringify(data).includes('provider detail must not leak'));
  }finally{await g.close()}
 }finally{globalThis.fetch=oldFetch}
});

test('an absent deepseek key reports setup guidance and makes no network call',async()=>{
 const oldFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'1'}]})};
 const f=await fixture();
 try{
  f.stored.delete('DEEPSEEK_API_KEY');
  const data=await(await deepseekUsage(f)).json();
  assert.equal(calls,0,'no key means no outbound request');
  assert.equal(data.keyConfigured,false);
  assert.equal(data.balance.balance,null);
  assert.match(data.balance.error,/No DeepSeek API key configured/);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('deepseek key setup validates against balance before storing it separately',async()=>{
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{assert.equal(url,'https://api.deepseek.com/user/balance');return Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'7.00'}]})};
 const f=await fixture();
 try{
  const key='sk-deepseek-management-000002';
  const result=await deepseekKey(f).fetch(new Request('http://local/api/openrouter-usage/deepseek-key',{method:'POST',body:JSON.stringify({key})}));
  assert.deepEqual(await result.json(),{ok:true});
  assert.equal(f.stored.get('DEEPSEEK_API_KEY'),key);
  // The DeepSeek key never displaces the OpenRouter credentials.
  assert.equal(f.stored.get('OPENROUTER_API_KEY'),'sk-or-test-model-key-123456');
  assert.equal(f.stored.has('OPENROUTER_MANAGEMENT_KEY'),false);
  // The stored balance is refreshed from the newly validated key.
  const data=await(await deepseekUsage(f)).json();
  assert.equal(data.balance.balance,7);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('deepseek key setup refuses junk and never replaces a stored key it cannot verify',async()=>{
 const oldFetch=globalThis.fetch,f=await fixture();
 const original='sk-deepseek-test-key-000001';
 try{
  for(const body of ['bad','{}','{"key":""}','{"key":"short"}','{"key":"has space"}','{"key":null}']){
   const result=await deepseekKey(f).fetch(new Request('http://local/api/openrouter-usage/deepseek-key',{method:'POST',body}));
   assert.equal(result.status,400,body);
   assert.equal(f.stored.get('DEEPSEEK_API_KEY'),original);
  }
  // A 2xx that is not a balance payload must not count as verification either.
  for(const payload of [{}, {balance_infos:[]}, {balance_infos:[{currency:'USD'}]}, {is_available:true}]){
   globalThis.fetch=async()=>Response.json(payload);
   const result=await deepseekKey(f).fetch(new Request('http://local/api/openrouter-usage/deepseek-key',{method:'POST',body:JSON.stringify({key:'sk-deepseek-candidate-0003'})}));
   assert.equal(result.status,400,JSON.stringify(payload));
   assert.equal(f.stored.get('DEEPSEEK_API_KEY'),original);
  }
  globalThis.fetch=async()=>new Response('',{status:401});
  const rejected=await deepseekKey(f).fetch(new Request('http://local/api/openrouter-usage/deepseek-key',{method:'POST',body:JSON.stringify({key:'sk-deepseek-candidate-0003'})}));
  assert.equal(rejected.status,400);assert.equal(f.stored.get('DEEPSEEK_API_KEY'),original);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('deepseek key rotation drops the old cached balance before the next read',async()=>{
 const oldFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,opts)=>{calls.push(opts.headers.Authorization);
  return opts.headers.Authorization.endsWith('new-deepseek-key')
   ? Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'99.00'}]})
   : Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'1.00'}]})};
 const f=await fixture();
 try{
  assert.equal((await(await deepseekUsage(f)).json()).balance.balance,1);
  f.stored.set('DEEPSEEK_API_KEY','new-deepseek-key');
  f.handlers.get('credentials/reference-updated')();
  const rotated=await(await deepseekUsage(f)).json();
  assert.equal(rotated.balance.balance,99,'the rotated key is used, not a stale cached figure');
  assert.equal(calls.length,2);
 }finally{globalThis.fetch=oldFetch;await f.close()}
});

test('an OpenRouter refresh is unaffected by the deepseek ledger and endpoint',async()=>{
 const oldFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async url=>{calls.push(url);return metadata(url)};
 const off=Date.parse(OFF_PEAK);
 const f=await fixture([event(0,'gen-own'),header(1,'deepseek-flash'),usageEvent(2,off,{outputTokens:1e6})]);
 try{
  const data=await(await usageRequest(f,'session-a')).json();
  assert.equal(data.session.cost,.08);
  assert.equal(data.deepseek,undefined,'the OpenRouter shape is unchanged');
  assert.ok(!calls.some(url=>url.includes('deepseek.com')));
 }finally{globalThis.fetch=oldFetch;await f.close()}
});
