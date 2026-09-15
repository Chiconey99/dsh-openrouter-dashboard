window.__ModuleLoader__.load({
  id: 'dsh-openrouter-dashboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const css = `
      .or-usage{box-sizing:border-box;width:100%;min-width:0;margin:4px 0 10px;padding:13px;border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:12px;background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,#1b1b1b) 95%,#448bff);color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.5;text-align:left}
      .or-usage *{box-sizing:border-box}.or-usage button,.or-usage select,.or-usage input{font:inherit;color:inherit}.or-usage button,.or-usage select{cursor:pointer;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;background:var(--dsw-specific-sidebar-fill,#252525);padding:3px 7px}.or-usage :focus-visible{outline:2px solid #6b9eff;outline-offset:3px}.or-usage button:disabled{cursor:wait;opacity:.5}
      .or-head,.or-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.or-head{margin-bottom:12px}.or-brand{font-weight:650;letter-spacing:.02em}.or-dot{display:inline-block;width:6px;height:6px;background:#4b99ff;border-radius:50%;margin-right:6px}.or-muted{opacity:.62}.or-value{font-size:26px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums;letter-spacing:-.6px;margin:4px 0}.or-caption{font-size:11px;opacity:.62}.or-balance{border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);padding-top:10px;margin-top:12px}.or-balance strong{font-size:18px;font-weight:550;font-variant-numeric:tabular-nums}.or-error{color:#dca547;font-size:11px;overflow-wrap:anywhere;margin:6px 0}.or-note{font-size:11px;opacity:.7;margin:6px 0}.or-detail{margin-top:10px}.or-detail summary{cursor:pointer;opacity:.7}.or-detail p{margin:7px 0}.or-detail a{color:#73a9ff}.or-chart{margin:9px 0}.or-model{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:145px}.or-bar{height:4px;border-radius:4px;background:color-mix(in srgb,currentColor 7%,transparent);margin-top:4px}.or-bar span{display:block;height:100%;background:#398eff;border-radius:4px}.or-setup{margin:9px 0;padding-top:8px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}.or-setup input{width:100%;margin:7px 0;background:var(--dsw-specific-sidebar-fill,#222);border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;padding:6px}.or-fresh{font-size:10px;opacity:.5;margin-top:10px}.or-rail{position:relative}.or-rail>button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:18px;width:32px;height:32px}.or-popover{position:fixed;left:62px;bottom:50px;width:min(290px,calc(100vw - 76px));z-index:1000;max-height:85vh;overflow:auto;box-shadow:0 10px 35px #0005;border-radius:12px}.or-popover .or-usage{margin:0}.or-close{float:right;margin-bottom:6px}
    `;
    const money = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:value !== 0 && Math.abs(value)<0.1 ? 4 : 2}).format(value) : '—';
    function Panel({wide,useSessions}) {
      const sessionId = useSessions(state => state.current);
      const [period,setPeriod] = React.useState(() => {try {const p=localStorage.getItem('or-usage-period');return ['Session','Day','Week','Total'].includes(p)?p:'Day';}catch{return 'Day';}});
      const [data,setData] = React.useState(null), [error,setError] = React.useState(''), [busy,setBusy] = React.useState(false), [tick,setTick] = React.useState(0);
      const [open,setOpen] = React.useState(false), [setup,setSetup] = React.useState(false), [key,setKey] = React.useState(''), [saving,setSaving] = React.useState(false), [setupMessage,setSetupMessage] = React.useState('');
      const setupAbort = React.useRef(null);
      React.useEffect(() => () => setupAbort.current?.abort(),[]);
      React.useEffect(() => {
        let disposed=false, timer, active=null;
        setData(null);setError('');
        async function load() {
          if(disposed || document.hidden || active) return;
          active=new AbortController();setBusy(true);
          const timeout=setTimeout(()=>active?.abort(),60000);
          try {
            const response=await fetch('/api/openrouter-usage'+(sessionId?'?sessionId='+encodeURIComponent(sessionId):''),{signal:active.signal,cache:'no-store',credentials:'same-origin'});
            const value=await response.json();
            if(!response.ok) throw new Error(value.error || 'Server unavailable');
            if(!value.key || !value.credits || !value.session) throw new Error('Invalid usage response');
            if(!disposed){setData(value);setError('');}
          }catch(e){if(!disposed)setError(e.name==='AbortError'?'Refresh timed out. Retrying automatically.':'Cannot refresh usage. Check the connection.');}
          finally{clearTimeout(timeout);active=null;if(!disposed){setBusy(false);timer=setTimeout(load,30000);}}
        }
        const visible=()=>{if(!document.hidden){clearTimeout(timer);load();}};
        document.addEventListener('visibilitychange',visible);load();
        return ()=>{disposed=true;clearTimeout(timer);active?.abort();document.removeEventListener('visibilitychange',visible);};
      },[sessionId,tick]);
      React.useEffect(()=>{if(!open)return;const close=e=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('keydown',close);return ()=>document.removeEventListener('keydown',close);},[open]);
      const changePeriod = e => {setPeriod(e.target.value);try{localStorage.setItem('or-usage-period',e.target.value);}catch{}};
      const session=data?.session, stats=data?.key, credits=data?.credits;
      const amount=period==='Session'?session?.cost:period==='Day'?stats?.usageDaily:period==='Week'?stats?.usageWeekly:stats?.usageTotal;
      const partial=period==='Session' && (session?.pending>0 || session?.missing>0 || session?.error);
      const scope=period==='Session'?'This session · confirmed requests':period==='Day'?'This API key · today (UTC)':period==='Week'?'This API key · Mon–Sun (UTC)':'This API key · all time';
      async function saveKey(e) {
        e.preventDefault();setSaving(true);setSetupMessage('');setupAbort.current?.abort();setupAbort.current=new AbortController();
        try {
          const response=await fetch('/api/openrouter-usage/management-key',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({key:key.trim()}),signal:setupAbort.current.signal});
          const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not store key.');
          setKey('');setSetupMessage('Saved securely on the server.');setTick(n=>n+1);
        }catch(e){if(e.name!=='AbortError')setSetupMessage(e.message);}finally{setSaving(false);}
      }
      const card=h('section',{className:'or-usage','aria-label':'OpenRouter usage and balance'},
        h('div',{className:'or-head'},h('span',{className:'or-brand'},h('span',{className:'or-dot'}),'OpenRouter'),h('button',{type:'button',onClick:()=>setTick(n=>n+1),disabled:busy,title:'Refresh usage','aria-label':'Refresh OpenRouter usage'},busy?'…':'↻')),
        h('div',{className:'or-row'},h('span',{className:'or-muted'},'Spend'),h('select',{value:period,onChange:changePeriod,'aria-label':'Usage period'},['Session','Day','Week','Total'].map(p=>h('option',{key:p,value:p},p)))),
        h('div',{className:'or-value','aria-live':'polite'},money(amount),partial?h('span',{style:{fontSize:11,letterSpacing:0,marginLeft:5,opacity:.65}},'partial'):null),
        h('div',{className:'or-caption'},scope),
        period==='Session' && !sessionId?h('p',{className:'or-note'},'Open a session to see its request costs.'):null,
        period==='Session' && sessionId?h('div',{className:'or-note'},`${session?.priced??0} priced`,session?.pending?` · ${session.pending} pending`:'',session?.missing?` · ${session.missing} missing request IDs`:''):null,
        period==='Session' && session?.models?.slice(0,4).map(row=>h('div',{className:'or-chart',key:row.model},h('div',{className:'or-row'},h('span',{className:'or-model',title:row.model},row.model),h('span',null,money(row.cost))),h('div',{className:'or-bar'},h('span',{style:{width:Math.max(0,Math.min(100,(row.cost/(session.cost||1))*100))+'%'}})))),
        h('div',{className:'or-balance'},h('div',{className:'or-row'},h('span',{className:'or-muted'},'Available balance'),h('strong',null,money(credits?.balance))),h('div',{className:'or-caption'},'Account-wide · current USD balance')),
        h('div',{className:'or-row',style:{marginTop:6}},h('span',{className:'or-caption'},'Key total spend'),h('span',null,money(stats?.usageTotal))),
        error?h('p',{className:'or-error',role:'status'},error):null,
        stats?.error?h('p',{className:'or-error'},stats.error):null,
        credits?.error?h('p',{className:'or-error'},credits.balance!==null?'Balance is stale. '+credits.error:credits.error):null,
        period==='Session' && session?.error?h('p',{className:'or-error'},session.error):null,
        h('details',{className:'or-detail'},h('summary',null,'Details & balance setup'),
          h('p',{className:'or-row'},h('span',null,'Account total spend'),h('span',null,money(credits?.totalUsage))),
          h('p',{className:'or-row'},h('span',null,'Account credits purchased'),h('span',null,money(credits?.totalCredits))),
          h('p',{className:'or-row'},h('span',null,'Key allowance left'),h('span',null,stats?.limit===null && !stats?.error?'No key limit':money(stats?.limitRemaining))),
          h('p',{className:'or-note'},'Day / Week / Total include all apps using this API key. Session excludes subagents and inherited fork history. Missing or unreported request IDs cannot be priced. Balance is not the key spending allowance.'),
          h('p',{className:'or-note'},'Refreshes every 30 seconds while this tab is visible. Charges can arrive after a response finishes. External BYOK bills are not included in key credit usage.'),
          h('a',{href:'https://openrouter.ai/activity',target:'_blank',rel:'noopener noreferrer'},'Open OpenRouter dashboard ↗'),
          h('div',{className:'or-setup'},h('button',{type:'button',onClick:()=>{setSetup(!setup);setKey('');},'aria-expanded':setup},data?.managementConfigured?'Update balance key':'Set up account balance'),
            setup?h('form',{onSubmit:saveKey},h('p',{className:'or-note'},'Add a separate management key for balance access. It is saved in DSH’s server credential store, never sent to models or saved in browser storage.'),h('a',{href:'https://openrouter.ai/settings/management-keys',target:'_blank',rel:'noopener noreferrer'},'Create a management key ↗'),h('input',{type:'password',value:key,onChange:e=>setKey(e.target.value),autoComplete:'off',placeholder:'OpenRouter management key','aria-label':'OpenRouter management key',required:true}),h('button',{type:'submit',disabled:saving||!key.trim()},saving?'Validating…':'Save key'),setupMessage?h('p',{className:'or-note',role:'status'},setupMessage):null):null)),
        h('div',{className:'or-fresh'},stats?.updatedAt?'Usage '+new Date(stats.updatedAt).toLocaleTimeString():'Waiting for usage',credits?.updatedAt?' · Balance '+new Date(credits.updatedAt).toLocaleTimeString():''));
      return h(React.Fragment,null,h('style',null,css),wide?card:h('div',{className:'or-rail'},h('button',{type:'button',title:'OpenRouter usage','aria-label':'OpenRouter usage','aria-expanded':open,onClick:()=>setOpen(!open)},'$'),open?h('div',{className:'or-popover'},h('button',{className:'or-close',type:'button',onClick:()=>setOpen(false),'aria-label':'Close OpenRouter usage'},'×'),card):null));
    }
    return {inject:['slots'],apply(ctx){ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'openrouter-usage',order:100},Panel));}};
  }
});
