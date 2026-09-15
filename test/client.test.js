import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
function render(period='Day',data=null,current='session-a',wide=true,provider='openrouter') {
 let panel, slot, module; const states=[],saved=[];
 const h=(type,props,...children)=>({type,props:props||{},children});
 // Hook order: provider, period, then data — keep it in step with the panel.
 const React={createElement:h,Fragment:'fragment',useState(init){const i=states.length;const v=i===0?provider:i===1?period:i===2?data:typeof init==='function'?init():init;states.push(v);return[v,next=>{states[i]=typeof next==='function'?next(states[i]):next}];},useEffect(){},useRef(init){return{current:init}},useId(){return 'usage-test'}};
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(value){module=value}}},localStorage:{getItem:key=>key==='or-usage-provider'?provider:period,setItem:(...x)=>saved.push(x)},Intl,console});
 const plugin=module.factory(name=>{assert.equal(name,'react');return React});
 plugin.apply({slots:{inject(name,fn){fn()},register(info,component){slot=info;panel=component}}});
 const tree=panel({wide,useSessions:selector=>selector({current})});
 return {tree,slot,states,saved};
}
function walk(tree){if(!tree||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(walk);return[tree,...tree.children.flatMap(walk)]}
const data={key:{usageDaily:.08,usageWeekly:.8,usageTotal:2,limit:null,limitRemaining:null,updatedAt:'2026-09-15T10:00:00Z',error:null},credits:{balance:17,totalCredits:20,totalUsage:3,updatedAt:'2026-09-15T10:00:00Z',error:null},session:{cost:.04,priced:1,requests:2,pending:1,missing:0,models:[{model:'example/model',cost:.04,requests:1}],error:null}};
// DeepSeek's payload carries an estimate plus the exact provider balance, and no
// key/credits fields at all — the panel must not require what the provider lacks.
const deepseekData={updatedAt:'2026-09-15T10:00:00Z',keyConfigured:true,provider:'deepseek-official',
 balance:{isAvailable:true,currency:'USD',balance:12.34,granted:1.5,toppedUp:10.84,infos:[{currency:'USD',balance:12.34}],error:null,updatedAt:'2026-09-15T10:00:00Z'},
 session:{id:null,cost:null,requests:0,priced:0,pending:0,missing:0,models:[],error:null},
 deepseek:{id:'session-a',period:'Session',scope:'Session + other sessions in this ledger',cost:1.23,calls:4,pricedCalls:4,unattributedCalls:0,tokens:{input:1000000,output:500000,cacheRead:200000,cacheWrite:0},accountTokens:{input:1000000,output:500000,cacheRead:200000,cacheWrite:0},unattributedTokens:0,truncated:false,models:[{model:'deepseek-flash',cost:.83,calls:3,tokens:1200000,priced:true},{model:'deepseek-v4-pro',cost:.4,calls:1,tokens:500000,priced:true}],error:null}};
test('client registers the sidebar slot and exposes all period choices',()=>{
 const result=render('Day',data);assert.equal(result.slot.id,'openrouter-usage');
 const elements=walk(result.tree),select=elements.find(e=>e.props['aria-label']==='Usage period');
 assert.deepEqual(Array.from(walk(select).filter(e=>e.type==='option').map(e=>e.props.value)),['Session','Day','Week','Total']);
 select.props.onChange({target:{value:'Week'}});assert.equal(result.states[1],'Week');assert.deepEqual(result.saved,[['or-usage-period','Week']]);
});
// Structural check that ignores the CSS text node carrying the same class names.
const hasClass=(tree,name)=>walk(tree).some(node=>(typeof node.type==='string')&&node.props&&node.props.className===name);
test('session shows partial coverage and only its actual model breakdown',()=>{
 const sessionTree=render('Session',data).tree, dayTree=render('Day',data).tree;
 assert.match(JSON.stringify(sessionTree),/partial/);assert.match(JSON.stringify(sessionTree),/example\/model/);
 // Day carries no per-model attribution, so no model row may be rendered there.
 assert.ok(hasClass(sessionTree,'or-model'),'Session shows model rows');
 assert.ok(!hasClass(dayTree,'or-model'),'no model rows outside Session');
 assert.ok(!hasClass(dayTree,'or-bar'));
 assert.match(JSON.stringify(dayTree),/\$17\.00/);
});
test('home and narrow sidebar remain usable without session data',()=>{
 assert.match(JSON.stringify(render('Session',null,null).tree),/Open a session/);
 const elements=walk(render('Day',data,'session-a',false).tree);
 assert.ok(elements.some(e=>e.props['aria-label']==='OpenRouter usage and balance'));
});

const text=tree=>tree==null?'':Array.isArray(tree)?tree.map(text).join(' '):typeof tree==='object'?text(tree.children):String(tree);
// Small hook/effect runner: commits dependency changes, cleanup, fake timers and
// deferred fetches. No React/DOM dependency, and no real network or credentials.
function harness({wide=true,current='session-a',ignoreAbort=false,deepseek=false,override=null}={}) {
 let panel,module,tree,index=0,dirty=true,alive=true,now=0,nextTimer=0,focused=null,afterUnmount=0;
 const hooks=[],pending=[],timers=new Map(),listeners=new Map(),requests=[],saved=[],logs=[];
 const answer=deepseek?{...deepseekData,...override}:data;
 const h=(type,props,...children)=>({type,props:props||{},children});
 const React={createElement:h,Fragment:'fragment',
  useState(init){const i=index++;if(!hooks[i])hooks[i]={value:typeof init==='function'?init():init};return[hooks[i].value,next=>{if(!alive)afterUnmount++;const value=typeof next==='function'?next(hooks[i].value):next;if(!Object.is(value,hooks[i].value)){hooks[i].value=value;dirty=true;}}];},
  useRef(init){const i=index++;if(!hooks[i])hooks[i]={current:init};return hooks[i];},
  useId(){const i=index++;return 'usage-'+i;},
  useEffect(effect,deps){const i=index++,old=hooks[i];if(!old||deps.some((dep,n)=>!Object.is(dep,old.deps[n]))){hooks[i]={deps,cleanup:old?.cleanup};pending.push(()=>{hooks[i].cleanup?.();hooks[i].cleanup=effect();});}}
 };
 const document={hidden:false,addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);}};
 const fetch=(url,options)=>new Promise((resolve,reject)=>{
  const request={url,options,resolve(value=answer,ok=true){resolve({ok,json:async()=>value});},reject};requests.push(request);
  if(!ignoreAbort)options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
 });
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(value){module=value}}},localStorage:{getItem:key=>key==='or-usage-provider'?(deepseek?'deepseek':'openrouter'):null,setItem:(...args)=>saved.push(args)},Intl,AbortController,document,fetch,console:{log:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);}});
 module.factory(()=>React).apply({slots:{inject(name,fn){fn()},register(info,component){panel=component}}});
 function render(commit=true){index=0;dirty=false;tree=panel({wide,useSessions:selector=>selector({current})});if(commit)commitEffects();return tree;}
 function commitEffects(){for(const node of walk(tree)){if(node.props.ref&&!node.props.ref.current)node.props.ref.current={focus(){focused=node.props['aria-label'];}};}while(pending.length)pending.shift()();}
 async function flush(){for(let n=0;n<12;n++){await Promise.resolve();if(dirty)render();else commitEffects();}}
 function advance(ms){const end=now+ms;while(true){const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();}now=end;}
 function find(label){const node=walk(tree).find(node=>node.props['aria-label']===label);assert.ok(node,'Missing '+label);return node;}
 render();
 return {get tree(){return tree;},get focused(){return focused;},get afterUnmount(){return afterUnmount;},requests,timers,listeners,saved,logs,flush,advance,find,
  click(label){find(label).props.onClick();},
  button(label){const node=walk(tree).find(node=>node.type==='button'&&text(node)===label);assert.ok(node,'Missing button '+label);node.props.onClick();},
  switchSession(value,commit=true){current=value;return render(commit);},
  visibility(hidden){document.hidden=hidden;for(const listener of listeners.get('visibilitychange')||[])listener();},
  unmount(){alive=false;for(const hook of hooks)hook?.cleanup?.();}
 };
}
async function loaded(options){const app=harness(options);app.requests[0].resolve();await app.flush();return app;}
async function startSave(app,key='test-only-management-secret'){
 app.button('Set up account balance');await app.flush();
 app.find('OpenRouter management key').props.onChange({target:{value:key}});await app.flush();
 const form=walk(app.tree).find(node=>node.type==='form');form.props.onSubmit({preventDefault(){}});await app.flush();
 return app.requests.findLast(request=>request.options.method==='POST');
}

test('polling waits for settlement, never overlaps, pauses hidden and cleans up',async()=>{
 const app=harness();assert.equal(app.requests.length,1);
 app.visibility(false);app.advance(29000);assert.equal(app.requests.length,1);
 app.requests[0].resolve();await app.flush();
 app.advance(29999);assert.equal(app.requests.length,1);
 app.advance(1);assert.equal(app.requests.length,2);
 app.visibility(false);assert.equal(app.requests.length,2);
 app.requests[1].resolve();await app.flush();
 app.visibility(true);app.advance(30000);assert.equal(app.requests.length,2);
 app.visibility(false);assert.equal(app.requests.length,3);
 const active=app.requests[2];app.unmount();await app.flush();
 assert.equal(active.options.signal.aborted,true);assert.equal(app.timers.size,0);
 assert.equal(app.listeners.get('visibilitychange').size,0);assert.equal(app.afterUnmount,0);
});

test('manual refresh retains figures on failure and marks them stale until recovery',async()=>{
 const app=await loaded();assert.match(text(app.tree),/\$17\.00/);
 app.click('Refresh OpenRouter usage');await app.flush();
 assert.match(text(app.tree),/\$17\.00/);
 app.requests[1].reject(new Error('offline'));await app.flush();
 assert.match(text(app.tree),/\$17\.00/);assert.match(text(app.tree),/Displayed values may be stale/);
 app.click('Refresh OpenRouter usage');await app.flush();
 assert.match(text(app.tree),/Displayed values may be stale/);
 app.requests[2].resolve();await app.flush();assert.doesNotMatch(text(app.tree),/may be stale/);
 app.unmount();
});

test('session switch hides old figures before effects and ignores obsolete responses',async()=>{
 const app=await loaded({ignoreAbort:true});
 app.click('Refresh OpenRouter usage');await app.flush();const obsolete=app.requests[1];
 app.switchSession('session-b',false);assert.doesNotMatch(text(app.tree),/\$17\.00/);
 await app.flush();assert.equal(obsolete.options.signal.aborted,true);
 assert.match(app.requests[2].url,/sessionId=session-b/);
 obsolete.resolve();app.requests[2].reject(new Error('offline'));await app.flush();
 assert.doesNotMatch(text(app.tree),/\$17\.00|values may be stale/);assert.match(text(app.tree),/Cannot refresh/);
 app.unmount();
});

test('refresh timeout preserves stale values and schedules a retry',async()=>{
 const app=await loaded();app.click('Refresh OpenRouter usage');await app.flush();
 app.advance(60000);await app.flush();
 assert.equal(app.requests[1].options.signal.aborted,true);
 assert.match(text(app.tree),/Refresh timed out/);assert.match(text(app.tree),/\$17\.00/);
 app.advance(30000);assert.equal(app.requests.length,3);app.unmount();await app.flush();
});

test('partial API failures label only available stale key/account values',()=>{
 const failed={...data,key:{...data.key,error:'Key unavailable'},credits:{...data.credits,balance:null,error:'Credits unavailable'}};
 const stale=text(render('Day',failed).tree);
 assert.match(stale,/Key values are stale/);assert.match(stale,/Account values are stale/);
 const empty=text(render('Day',{...data,key:{error:'Key unavailable'},credits:{error:'Credits unavailable'}}).tree);
 assert.doesNotMatch(empty,/are stale/);assert.match(empty,/Key unavailable/);assert.match(empty,/Credits unavailable/);
 const zero=text(render('Day',{...data,credits:{balance:0,error:'Credits unavailable'}}).tree);
 assert.match(zero,/Account values are stale/);
});

test('missing allowance never claims an unlimited key and a real allowance is formatted',()=>{
 for(const key of [{},{limit:null,limitRemaining:null},{limit:10,limitRemaining:null}]){
  const tree=render('Day',{...data,key}).tree;
  const allowance=walk(tree).find(node=>node.type==='p'&&text(node).startsWith('Key allowance left'));
  assert.match(text(allowance),/—/);assert.doesNotMatch(text(tree),/No key limit/);
 }
 const tree=render('Day',{...data,key:{...data.key,limit:10,limitRemaining:8}}).tree;
 assert.match(text(walk(tree).find(node=>node.type==='p'&&text(node).startsWith('Key allowance left'))),/\$8\.00/);
});

test('management save times out, reenables submit and ignores a late success',async()=>{
 const app=await loaded({ignoreAbort:true});const request=await startSave(app);
 app.advance(30000);await app.flush();assert.equal(request.options.signal.aborted,true);
 assert.match(text(app.tree),/Saving timed out/);
 assert.equal(walk(app.tree).find(node=>node.props.type==='submit').props.disabled,false);
 request.resolve({ok:true});await app.flush();assert.doesNotMatch(text(app.tree),/Saved securely/);
 app.unmount();await app.flush();assert.equal(app.afterUnmount,0);
});

test('save success clears transient key and does not persist or log secrets',async()=>{
 const app=await loaded();const request=await startSave(app);
 assert.equal(JSON.parse(request.options.body).key,'test-only-management-secret');
 assert.equal(request.options.credentials,'same-origin');
 request.resolve({ok:true});await app.flush();
 assert.equal(app.find('OpenRouter management key').props.value,'');assert.match(text(app.tree),/Saved securely/);
 assert.deepEqual(app.saved,[]);assert.deepEqual(app.logs,[]);
 app.unmount();await app.flush();assert.equal(app.afterUnmount,0);
});

test('save close and unmount abort requests and suppress all late state updates',async()=>{
 const app=await loaded({ignoreAbort:true});const request=await startSave(app);
 app.button('Set up account balance');await app.flush();assert.equal(request.options.signal.aborted,true);
 request.resolve({ok:true});await app.flush();assert.doesNotMatch(text(app.tree),/Saved securely/);
 app.button('Set up account balance');await app.flush();assert.equal(app.find('OpenRouter management key').props.value,'');
 app.find('OpenRouter management key').props.onChange({target:{value:'another-test-secret'}});await app.flush();
 walk(app.tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await app.flush();
 const pending=app.requests.findLast(request=>request.options.method==='POST');app.unmount();
 assert.equal(pending.options.signal.aborted,true);assert.equal(app.timers.size,0);
 pending.reject(new Error('late failure'));await app.flush();assert.equal(app.afterUnmount,0);
});

test('save errors never echo a server or transport credential',async()=>{
 const app=await loaded();const request=await startSave(app);
 request.resolve({error:'test-only-management-secret'},false);await app.flush();
 assert.match(text(app.tree),/Could not save/);assert.doesNotMatch(text(app.tree),/test-only-management-secret/);
 assert.deepEqual(app.saved,[]);assert.deepEqual(app.logs,[]);app.unmount();
});

test('collapsed popover focuses close, handles Escape and returns trigger focus',async()=>{
 const app=await loaded({wide:false});const trigger=app.find('OpenRouter usage and balance');
 assert.equal(trigger.props['aria-haspopup'],'dialog');app.click('OpenRouter usage and balance');await app.flush();
 assert.equal(app.focused,'Close OpenRouter usage');
 const dialog=walk(app.tree).find(node=>node.props.role==='dialog');
 assert.equal(app.find('OpenRouter usage and balance').props['aria-controls'],dialog.props.id);
 const request=await startSave(app);let prevented=false,stopped=false;
 dialog.props.onKeyDown({key:'Escape',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});await app.flush();
 assert.equal(prevented,true);assert.equal(stopped,true);assert.equal(app.focused,'OpenRouter usage and balance');
 assert.equal(request.options.signal.aborted,true);assert.ok(!walk(app.tree).some(node=>node.props.role==='dialog'));
 app.click('OpenRouter usage and balance');await app.flush();app.button('Set up account balance');await app.flush();
 assert.equal(app.find('OpenRouter management key').props.value,'');
 const nextDialog=walk(app.tree).find(node=>node.props.role==='dialog');
 nextDialog.props.onBlur({currentTarget:{contains:()=>false},relatedTarget:{}});await app.flush();
 assert.ok(!walk(app.tree).some(node=>node.props.role==='dialog'));app.unmount();
});

test('closing details clears key and cancels save; card height remains bounded',async()=>{
 const app=await loaded();const request=await startSave(app);
 walk(app.tree).find(node=>node.type==='details').props.onToggle({currentTarget:{open:false}});await app.flush();
 assert.equal(request.options.signal.aborted,true);app.button('Set up account balance');await app.flush();
 assert.equal(app.find('OpenRouter management key').props.value,'');
 assert.match(source,/max-height:min\(50vh,480px\);overflow:auto/);
 assert.match(source,/\.or-detail a\{color:inherit;text-decoration:underline/);
 app.unmount();
});

// --- DeepSeek provider -----------------------------------------------------

test('the provider dropdown offers both providers and defaults to OpenRouter',()=>{
 const elements=walk(render('Day',data).tree),select=elements.find(e=>e.props['aria-label']==='Usage provider');
 assert.ok(select,'the provider dropdown is present');
 assert.deepEqual(Array.from(walk(select).filter(e=>e.type==='option').map(e=>e.props.value)),['openrouter','deepseek']);
 assert.equal(select.props.value,'openrouter');
});

test('the provider dropdown lists DeepSeek and switches without offering Total',async()=>{
 const app=await loaded();const select=()=>app.find('Usage provider');
 assert.equal(select().props.value,'openrouter');
 select().props.onChange({target:{value:'deepseek'}});await app.flush();
 // The request names the DeepSeek view, so the host answers with the DeepSeek shape.
 assert.match(app.requests.at(-1).url,/deepseek=1/);
 assert.match(app.requests.at(-1).url,/period=Day/);
 assert.equal(select().props.value,'deepseek');
 assert.ok(app.saved.some(entry=>entry[0]==='or-usage-provider'&&entry[1]==='deepseek'));
 const periods=walk(app.find('Usage period')).filter(e=>e.type==='option').map(e=>e.props.value);
 assert.deepEqual(periods,['Session','Day','Week'],'DeepSeek has no provider-reported Total');
 app.unmount();
});

test('selecting DeepSeek while Total is remembered falls back to a scope it can answer',async()=>{
 const app=harness();// period starts unset, so switch it to Total first
 app.find('Usage period').props.onChange({target:{value:'Total'}});await app.flush();
 assert.equal(app.find('Usage period').props.value,'Total');
 app.find('Usage provider').props.onChange({target:{value:'deepseek'}});await app.flush();
 assert.equal(app.find('Usage period').props.value,'Day');
 assert.ok(app.saved.some(entry=>entry[0]==='or-usage-period'&&entry[1]==='Day'));
 assert.match(app.requests.at(-1).url,/period=Day/);
 app.unmount();
});

test('the DeepSeek view renders its own estimate, balance and per-model bars',async()=>{
 const app=await loaded({deepseek:true});
 // Model attribution is a Session-scope figure, so select Session to see the bars.
 app.find('Usage period').props.onChange({target:{value:'Session'}});await app.flush();
 app.requests.at(-1).resolve();await app.flush();
 const rendered=text(app.tree);
 assert.match(rendered,/DeepSeek/);
 assert.match(rendered,/\$1\.23/,'the estimated spend is the headline figure');
 assert.match(rendered,/\$12\.34/,'the provider balance is shown');
 assert.match(rendered,/deepseek-flash/);assert.match(rendered,/deepseek-v4-pro/);
 assert.match(rendered,/1\.7M tokens recorded/);
 assert.match(rendered,/This session · locally estimated/);
 // OpenRouter-only fields must not appear in the DeepSeek view.
 assert.doesNotMatch(rendered,/Key total spend/);
 assert.doesNotMatch(rendered,/Account credits purchased/);
 assert.ok(!walk(app.tree).some(node=>node.type==='button'&&text(node)==='Set up account balance'));
 app.unmount();
});

test('the DeepSeek config menu explains the integration and saves a key',async()=>{
 const app=await loaded({deepseek:true});
 const details=()=>walk(app.tree).find(node=>node.type==='details');
 assert.match(text(walk(details()).find(node=>node.type==='summary')),/DeepSeek API setup/);
 details().props.onToggle({currentTarget:{open:true}});await app.flush();
 const rendered=text(app.tree);
 assert.match(rendered,/estimated locally/);
 assert.match(rendered,/not a billing record/);
 assert.match(rendered,/Model route deepseek-official/);
 assert.match(rendered,/01:00–04:00/);
 assert.match(rendered,/Credential configured/);
 app.button('Update DeepSeek key');await app.flush();
 app.find('DeepSeek API key').props.onChange({target:{value:'sk-test-deepseek-key-000001'}});await app.flush();
 walk(app.tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await app.flush();
 const request=app.requests.findLast(r=>r.options.method==='POST');
 assert.match(request.url,/\/api\/openrouter-usage\/deepseek-key$/);
 assert.equal(JSON.parse(request.options.body).key,'sk-test-deepseek-key-000001');
 request.resolve({ok:true});await app.flush();
 assert.match(text(app.tree),/Saved securely/);
 assert.equal(app.find('DeepSeek API key').props.value,'');
 assert.deepEqual(app.saved.filter(entry=>entry[1]==='sk-test-deepseek-key-000001'),[]);
 app.unmount();
});

test('a DeepSeek key error never echoes the submitted credential',async()=>{
 const app=await loaded({deepseek:true});
 walk(app.tree).find(node=>node.type==='details').props.onToggle({currentTarget:{open:true}});await app.flush();
 app.button('Update DeepSeek key');await app.flush();
 app.find('DeepSeek API key').props.onChange({target:{value:'sk-test-deepseek-key-000002'}});await app.flush();
 walk(app.tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await app.flush();
 const request=app.requests.findLast(r=>r.options.method==='POST');
 request.resolve({error:'sk-test-deepseek-key-000002'},false);await app.flush();
 assert.match(text(app.tree),/Could not save the DeepSeek key/);
 assert.doesNotMatch(text(app.tree),/sk-test-deepseek-key-000002/);
 assert.deepEqual(app.logs,[]);
 app.unmount();
});

test('a DeepSeek response without its ledger is treated as a failed refresh',async()=>{
 const app=await loaded({deepseek:true});
 app.click('Refresh DeepSeek usage');await app.flush();
 // Drop the ledger: the panel must refuse a partial body rather than show blanks.
 app.requests.at(-1).resolve({balance:deepseekData.balance,session:deepseekData.session});
 await app.flush();
 assert.match(text(app.tree),/Cannot refresh usage/);
 app.unmount();
});

test('switching to DeepSeek replaces stale OpenRouter figures rather than mixing them',async()=>{
 const app=await loaded();
 assert.match(text(app.tree),/\$17\.00/);
 app.find('Usage provider').props.onChange({target:{value:'deepseek'}});await app.flush();
 // The DeepSeek response has not arrived yet, so no OpenRouter figure may linger: the
 // panel must never label an OpenRouter number as DeepSeek spend.
 const pending=text(app.tree);
 assert.match(pending,/DeepSeek/);
 assert.doesNotMatch(pending,/\$17\.00/,'the OpenRouter balance is not carried into DeepSeek');
 assert.doesNotMatch(pending,/Key total spend/);
 assert.doesNotMatch(pending,/Account credits purchased/);
 app.requests.at(-1).resolve({...deepseekData});await app.flush();
 const rendered=text(app.tree);
 assert.match(rendered,/\$12\.34/);
 assert.match(rendered,/\$1\.23/);
 assert.doesNotMatch(rendered,/\$17\.00/);
 app.unmount();
});

test('an unconfigured DeepSeek key is reported plainly in the config menu',async()=>{
 const app=await loaded({deepseek:true,override:{
  keyConfigured:false,
  balance:{isAvailable:false,currency:'USD',balance:null,granted:null,toppedUp:null,infos:[],error:'No DeepSeek API key configured. Add it in Settings, or set one up below.',updatedAt:'2026-09-15T10:00:00Z'}}});
 assert.match(text(app.tree),/No DeepSeek API key configured/);
 walk(app.tree).find(node=>node.type==='details').props.onToggle({currentTarget:{open:true}});await app.flush();
 assert.match(text(app.tree),/Credential not configured/);
 assert.ok(walk(app.tree).some(node=>node.type==='button'&&text(node)==='Set up DeepSeek key'));
 assert.match(text(app.tree),/No DeepSeek API key configured/);
 app.unmount();
});
