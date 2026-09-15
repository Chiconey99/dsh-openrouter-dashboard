import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
function render(period='Day',data=null,current='session-a',wide=true) {
 let panel, slot, module; const states=[],saved=[];
 const h=(type,props,...children)=>({type,props:props||{},children});
 const React={createElement:h,Fragment:'fragment',useState(init){const i=states.length;const v=i===0?period:i===1?data:typeof init==='function'?init():init;states.push(v);return[v,next=>{states[i]=typeof next==='function'?next(states[i]):next}];},useEffect(){},useRef(init){return{current:init}},useId(){return 'usage-test'}};
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(value){module=value}}},localStorage:{getItem:()=>period,setItem:(...x)=>saved.push(x)},Intl,console});
 const plugin=module.factory(name=>{assert.equal(name,'react');return React});
 plugin.apply({slots:{inject(name,fn){fn()},register(info,component){slot=info;panel=component}}});
 const tree=panel({wide,useSessions:selector=>selector({current})});
 return {tree,slot,states,saved};
}
function walk(tree){if(!tree||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(walk);return[tree,...tree.children.flatMap(walk)]}
const data={key:{usageDaily:.08,usageWeekly:.8,usageTotal:2,limit:null,limitRemaining:null,updatedAt:'2026-09-15T10:00:00Z',error:null},credits:{balance:17,totalCredits:20,totalUsage:3,updatedAt:'2026-09-15T10:00:00Z',error:null},session:{cost:.04,priced:1,requests:2,pending:1,missing:0,models:[{model:'example/model',cost:.04,requests:1}],error:null}};
test('client registers the sidebar slot and exposes all period choices',()=>{
 const result=render('Day',data);assert.equal(result.slot.id,'openrouter-usage');
 const elements=walk(result.tree),select=elements.find(e=>e.type==='select');
 assert.deepEqual(Array.from(walk(select).filter(e=>e.type==='option').map(e=>e.props.value)),['Session','Day','Week','Total']);
 select.props.onChange({target:{value:'Week'}});assert.equal(result.states[0],'Week');assert.deepEqual(result.saved,[['or-usage-period','Week']]);
});
test('session shows partial coverage and only its actual model breakdown',()=>{
 const session=JSON.stringify(render('Session',data).tree), day=JSON.stringify(render('Day',data).tree);
 assert.match(session,/partial/);assert.match(session,/example\/model/);assert.ok(!day.includes('example/model'));assert.match(day,/\$17\.00/);
});
test('home and narrow sidebar remain usable without session data',()=>{
 assert.match(JSON.stringify(render('Session',null,null).tree),/Open a session/);
 const elements=walk(render('Day',data,'session-a',false).tree);
 assert.ok(elements.some(e=>e.props['aria-label']==='OpenRouter usage'));
});

const text=tree=>tree==null?'':Array.isArray(tree)?tree.map(text).join(' '):typeof tree==='object'?text(tree.children):String(tree);
// Small hook/effect runner: commits dependency changes, cleanup, fake timers and
// deferred fetches. No React/DOM dependency, and no real network or credentials.
function harness({wide=true,current='session-a',ignoreAbort=false}={}) {
 let panel,module,tree,index=0,dirty=true,alive=true,now=0,nextTimer=0,focused=null,afterUnmount=0;
 const hooks=[],pending=[],timers=new Map(),listeners=new Map(),requests=[],saved=[],logs=[];
 const h=(type,props,...children)=>({type,props:props||{},children});
 const React={createElement:h,Fragment:'fragment',
  useState(init){const i=index++;if(!hooks[i])hooks[i]={value:typeof init==='function'?init():init};return[hooks[i].value,next=>{if(!alive)afterUnmount++;const value=typeof next==='function'?next(hooks[i].value):next;if(!Object.is(value,hooks[i].value)){hooks[i].value=value;dirty=true;}}];},
  useRef(init){const i=index++;if(!hooks[i])hooks[i]={current:init};return hooks[i];},
  useId(){const i=index++;return 'usage-'+i;},
  useEffect(effect,deps){const i=index++,old=hooks[i];if(!old||deps.some((dep,n)=>!Object.is(dep,old.deps[n]))){hooks[i]={deps,cleanup:old?.cleanup};pending.push(()=>{hooks[i].cleanup?.();hooks[i].cleanup=effect();});}}
 };
 const document={hidden:false,addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);}};
 const fetch=(url,options)=>new Promise((resolve,reject)=>{
  const request={url,options,resolve(value=data,ok=true){resolve({ok,json:async()=>value});},reject};requests.push(request);
  if(!ignoreAbort)options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
 });
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(value){module=value}}},localStorage:{getItem:()=>null,setItem:(...args)=>saved.push(args)},Intl,AbortController,document,fetch,console:{log:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);}});
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
 const app=await loaded({wide:false});const trigger=app.find('OpenRouter usage');
 assert.equal(trigger.props['aria-haspopup'],'dialog');app.click('OpenRouter usage');await app.flush();
 assert.equal(app.focused,'Close OpenRouter usage');
 const dialog=walk(app.tree).find(node=>node.props.role==='dialog');
 assert.equal(app.find('OpenRouter usage').props['aria-controls'],dialog.props.id);
 const request=await startSave(app);let prevented=false,stopped=false;
 dialog.props.onKeyDown({key:'Escape',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});await app.flush();
 assert.equal(prevented,true);assert.equal(stopped,true);assert.equal(app.focused,'OpenRouter usage');
 assert.equal(request.options.signal.aborted,true);assert.ok(!walk(app.tree).some(node=>node.props.role==='dialog'));
 app.click('OpenRouter usage');await app.flush();app.button('Set up account balance');await app.flush();
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
