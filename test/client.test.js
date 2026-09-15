import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
function render(period='Day',data=null,current='session-a',wide=true) {
 let panel, slot, module; const states=[],saved=[];
 const h=(type,props,...children)=>({type,props:props||{},children});
 const React={createElement:h,Fragment:'fragment',useState(init){const i=states.length;const v=i===0?period:i===1?data:typeof init==='function'?init():init;states.push(v);return[v,next=>{states[i]=typeof next==='function'?next(states[i]):next}];},useEffect(){},useRef(){return{current:null}}};
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
