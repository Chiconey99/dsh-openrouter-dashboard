window.__ModuleLoader__.load({
  id: 'dsh-openrouter-dashboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const css = `
      .or-usage{box-sizing:border-box;width:100%;min-width:0;min-height:0;max-height:min(50vh,480px);overflow:auto;overscroll-behavior:contain;margin:4px 0 10px;padding:13px;border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:12px;background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,#1b1b1b) 95%,#448bff);color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.5;text-align:left}
      .or-usage *{box-sizing:border-box}.or-usage button,.or-usage select,.or-usage input{font:inherit;color:inherit}.or-usage button,.or-usage select{cursor:pointer;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;background:var(--dsw-specific-sidebar-fill,#252525);padding:3px 7px}.or-usage :focus-visible{outline:2px solid #6b9eff;outline-offset:3px}.or-usage button:disabled{cursor:wait;opacity:.5}
      .or-head,.or-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.or-head{margin-bottom:12px}.or-brand{font-weight:650;letter-spacing:.02em}.or-dot{display:inline-block;width:6px;height:6px;background:#4b99ff;border-radius:50%;margin-right:6px}.or-muted{opacity:.8}.or-value{font-size:26px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums;letter-spacing:-.6px;margin:4px 0}.or-est{font-size:11px;font-weight:600;letter-spacing:0;margin-left:5px;opacity:.65}.or-caption{font-size:11px;opacity:.8}.or-kv{display:flex;align-items:center;justify-content:space-between;gap:8px}.or-range{width:100%;margin:6px 0 0;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;background:var(--dsw-specific-sidebar-fill,#252525);padding:4px 6px}.or-balance{border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);padding-top:10px;margin-top:12px}.or-balance strong{font-size:18px;font-weight:550;font-variant-numeric:tabular-nums}.or-error{color:inherit;font-weight:600;font-size:11px;overflow-wrap:anywhere;margin:6px 0}.or-note{font-size:11px;opacity:.7;margin:6px 0}.or-detail{margin-top:10px}.or-detail summary{cursor:pointer;opacity:.7}.or-detail p{margin:7px 0}.or-detail a{color:inherit;text-decoration:underline;text-underline-offset:2px}.or-chart{margin:9px 0}.or-model{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:145px}.or-bar{height:4px;border-radius:4px;background:color-mix(in srgb,currentColor 7%,transparent);margin-top:4px}.or-bar span{display:block;height:100%;background:#398eff;border-radius:4px}.or-setup{margin:9px 0;padding-top:8px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}.or-setup input{width:100%;margin:7px 0;background:var(--dsw-specific-sidebar-fill,#222);border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;padding:6px}.or-fresh{font-size:11px;opacity:.8;margin-top:10px}.or-rail{position:relative}.or-rail>button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:18px;width:32px;height:32px}.or-popover{position:fixed;left:62px;bottom:50px;width:min(290px,calc(100vw - 76px));z-index:1000;max-height:85vh;overflow:auto;box-shadow:0 10px 35px #0005;border-radius:12px}.or-popover .or-usage{margin:0;max-height:min(75vh,560px)}.or-close{float:right;margin-bottom:6px}
    `;
    const money = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:value !== 0 && Math.abs(value)<0.1 ? 4 : 2}).format(value) : '—';
    function Panel({wide,useSessions}) {
      const sessionId = useSessions(state => state.current);
      const [provider,setProvider] = React.useState(() => {try {const p=localStorage.getItem('or-usage-provider');return p==='deepseek'?'deepseek':'openrouter';}catch{return 'openrouter';}});
      const [period,setPeriod] = React.useState(() => {try {const p=localStorage.getItem('or-usage-period');return ['Session','Day','Week','Total'].includes(p)?p:'Day';}catch{return 'Day';}});
      const isDeepSeek = provider === 'deepseek';
      // DeepSeek publishes no usage history, so `Total` is not offered for it.
      const periods = isDeepSeek ? ['Session','Day','Week'] : ['Session','Day','Week','Total'];
      const [data,setData] = React.useState(null), [error,setError] = React.useState(''), [busy,setBusy] = React.useState(false), [tick,setTick] = React.useState(0);
      const [open,setOpen] = React.useState(false), [setup,setSetup] = React.useState(false), [key,setKey] = React.useState(''), [saving,setSaving] = React.useState(false), [setupMessage,setSetupMessage] = React.useState('');
      const setupAbort = React.useRef(null), mounted = React.useRef(false), dataSession = React.useRef(sessionId);
      const triggerRef = React.useRef(null), closeRef = React.useRef(null);
      const popoverId = React.useId();
      function cancelSave() {
        const request=setupAbort.current;setupAbort.current=null;
        if(request){clearTimeout(request.timeout);request.controller.abort();}
      }
      function closeSetup() {cancelSave();setSetup(false);setKey('');setSaving(false);setSetupMessage('');}
      function closePopover(returnFocus=true) {setOpen(false);closeSetup();if(returnFocus)triggerRef.current?.focus();}
      React.useEffect(() => {mounted.current=true;return () => {mounted.current=false;cancelSave();};},[]);
      React.useEffect(() => {
        let disposed=false, timer, timeout, active=null;
        if(dataSession.current!==sessionId){dataSession.current=sessionId;setData(null);setError('');}
        async function load() {
          if(disposed || document.hidden || active) return;
          active=new AbortController();setBusy(true);
          timeout=setTimeout(()=>active?.abort(),60000);
          try {
            const query=(sessionId?'sessionId='+encodeURIComponent(sessionId)+'&':'')+(isDeepSeek?'deepseek=1&period='+encodeURIComponent(period):'');
            const response=await fetch('/api/openrouter-usage'+(query?'?'+query:''),{signal:active.signal,cache:'no-store',credentials:'same-origin'});
            const value=await response.json();
            if(!response.ok) throw new Error(value.error || 'Server unavailable');
            // Each provider answers with its own required shape; a partial body is
            // treated as a failed refresh rather than rendered as blank figures.
            const valid=isDeepSeek?(value.deepseek&&value.balance&&value.session):(value.key&&value.credits&&value.session);
            if(!valid) throw new Error('Invalid usage response');
            if(!disposed){setData(value);setError('');}
          }catch(e){if(!disposed)setError(e.name==='AbortError'?'Refresh timed out. Retrying automatically.':'Cannot refresh usage. Check the connection.');}
          finally{clearTimeout(timeout);active=null;if(!disposed){setBusy(false);timer=setTimeout(load,30000);}}
        }
        const visible=()=>{if(!document.hidden){clearTimeout(timer);load();}};
        document.addEventListener('visibilitychange',visible);load();
        return ()=>{disposed=true;clearTimeout(timer);clearTimeout(timeout);active?.abort();document.removeEventListener('visibilitychange',visible);};
      },[sessionId,tick,isDeepSeek,period]);
      React.useEffect(()=>{if(open && !wide)closeRef.current?.focus();},[open,wide]);
      const changePeriod = e => {setPeriod(e.target.value);try{localStorage.setItem('or-usage-period',e.target.value);}catch{}};
      function changeProvider(next) {
        setProvider(next);setData(null);setError('');closeSetup();
        try{localStorage.setItem('or-usage-provider',next);}catch{}
        // `Total` has no DeepSeek equivalent, so the remembered period must fall back
        // rather than request a scope the provider cannot answer.
        if(next==='deepseek' && period==='Total'){setPeriod('Day');try{localStorage.setItem('or-usage-period','Day');}catch{}}
      }
      // Hide the previous session during render, before its effect cleanup/setup runs.
      const currentData=dataSession.current===sessionId?data:null;
      const currentError=dataSession.current===sessionId?error:'';
      const session=currentData?.session, stats=currentData?.key, credits=currentData?.credits;
      const hasNumber=value=>typeof value==='number' && Number.isFinite(value);
      // DeepSeek is a different proposition from OpenRouter: its headline figure is a
      // locally priced estimate, and the account balance is the exact provider value.
      const ds=currentData?.deepseek;
      const dsTokens=ds?.tokens, dsBalance=currentData?.balance;
      const dsTotal=dsTokens?dsTokens.input+dsTokens.output+dsTokens.cacheRead+dsTokens.cacheWrite:0;
      const formatTokens=value=>value>=1e6?(value/1e6).toFixed(value>=1e7?0:1)+'M':value>=1e3?(value/1e3).toFixed(value>=1e4?0:1)+'k':String(value);
      const dsSetupHref='https://platform.deepseek.com/api_keys';
      const amount=isDeepSeek?(ds?.cost??null):period==='Session'?session?.cost:period==='Day'?stats?.usageDaily:period==='Week'?stats?.usageWeekly:stats?.usageTotal;
      const partial=isDeepSeek?(ds&&ds.calls>0&&(ds.cost===null||ds.cost===undefined)):period==='Session' && (session?.pending>0 || session?.missing>0 || session?.error);
      const scope=isDeepSeek
        ?(period==='Session'?'This session · locally estimated from recorded tokens':period==='Day'?'Recorded tokens · today (UTC)':'Recorded tokens · Mon–Sun (UTC)')
        :period==='Session'?'This session · confirmed requests':period==='Day'?'This API key · today (UTC)':period==='Week'?'This API key · Mon–Sun (UTC)':'This API key · all time';
      async function saveKey(e) {
        e.preventDefault();if(!mounted.current || saving || !key.trim())return;
        cancelSave();setSaving(true);setSetupMessage('');
        const request={controller:new AbortController(),timeout:null,timedOut:false};setupAbort.current=request;
        const isCurrent=()=>mounted.current && setupAbort.current===request;
        request.timeout=setTimeout(()=>{request.timedOut=true;if(isCurrent()){setupAbort.current=null;setSetupMessage('Saving timed out. Please try again.');setSaving(false);}request.controller.abort();},30000);
        try {
          const endpoint=isDeepSeek?'/api/openrouter-usage/deepseek-key':'/api/openrouter-usage/management-key';
          const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({key:key.trim()}),signal:request.controller.signal});
          await response.json();if(!response.ok)throw new Error('Could not store key.');
          if(isCurrent() && !request.controller.signal.aborted){setKey('');setSetupMessage('Saved securely on the server.');setTick(n=>n+1);}
        }catch(e){
          // Do not echo server/transport errors: they may contain submitted credentials.
          if(isCurrent())setSetupMessage(request.timedOut?'Saving timed out. Please try again.':isDeepSeek?'Could not save the DeepSeek key. Check the key and connection, then try again.':'Could not save the management key. Check the key and connection, then try again.');
        }finally{clearTimeout(request.timeout);if(isCurrent()){setupAbort.current=null;setSaving(false);}}

      }
      const cardLabel=isDeepSeek?'DeepSeek usage and balance':'OpenRouter usage and balance';
      const brandName=isDeepSeek?'DeepSeek':'OpenRouter';
      const refreshLabel='Refresh '+brandName+' usage';
      const dsModels=ds?.models??[];
      // Bars are scaled against the largest bar rather than the headline figure: an
      // unattributed row adds tokens but no cost, so the parts need not sum to the whole.
      const dsModelMax=Math.max(1,...dsModels.map(row=>row.cost||0));
      const dsUnpriced=(ds?.unattributedTokens||0)>0||(ds?.calls||0)>(ds?.pricedCalls||0);
      const chart=(row,max)=>{const value=row.cost||0;return h('div',{className:'or-chart',key:row.model},h('div',{className:'or-row'},h('span',{className:'or-model',title:row.model},row.model),h('span',null,row.priced===false?'—':money(value))),h('div',{className:'or-bar'},h('span',{style:{width:Math.max(0,Math.min(100,(value/max)*100))+'%'}})));};
      const dsBalanceError=dsBalance?.error?h('p',{className:'or-error'},hasNumber(dsBalance.balance)?'Account values are stale. '+dsBalance.error:dsBalance.error):null;
      const card=h('section',{className:'or-usage','aria-label':cardLabel},
        h('div',{className:'or-head'},h('span',{className:'or-brand'},h('span',{className:'or-dot'}),brandName),h('button',{type:'button',onClick:()=>setTick(n=>n+1),disabled:busy,title:'Refresh usage','aria-label':refreshLabel},busy?'…':'↻')),
        // The provider switch sits where the period control does, so both the card and
        // its persisted choices read the same way whichever provider is selected.
        h('div',{className:'or-row'},h('span',{className:'or-muted'},'Provider'),h('select',{value:provider,onChange:e=>changeProvider(e.target.value),'aria-label':'Usage provider'},[h('option',{key:'openrouter',value:'openrouter'},'OpenRouter'),h('option',{key:'deepseek',value:'deepseek'},'DeepSeek')])),
        h('div',{className:'or-row'},h('span',{className:'or-muted'},'Spend'),h('select',{value:period,onChange:changePeriod,'aria-label':'Usage period'},periods.map(p=>h('option',{key:p,value:p},p)))),
        h('div',{className:'or-value','aria-live':'polite'},money(amount),partial?h('span',{className:'or-est'},isDeepSeek?'unpriced':'partial'):null),
        h('div',{className:'or-caption'},scope),
        isDeepSeek&&period==='Session'&&!sessionId?h('p',{className:'or-note'},'Open a session to see its recorded spend. The figures below still cover every session in this ledger.'):null,
        isDeepSeek&&ds&&ds.calls?h('div',{className:'or-note'},`${formatTokens(dsTotal)} tokens recorded · ${ds.pricedCalls} priced`,ds.unattributedCalls?` · ${ds.unattributedCalls} unattributed`:''):null,
        isDeepSeek&&ds&&!ds.calls&&!currentError?h('p',{className:'or-note'},'No DeepSeek calls recorded yet. Spend is collected as DSH runs requests through the deepseek-official route.'):null,
        !isDeepSeek&&period==='Session' && !sessionId?h('p',{className:'or-note'},'Open a session to see its request costs.'):null,
        !isDeepSeek&&period==='Session' && sessionId?h('div',{className:'or-note'},`${session?.priced??0} priced`,session?.pending?` · ${session.pending} pending`:'',session?.missing?` · ${session.missing} missing request IDs`:''):null,
        // Model attribution only exists for the Session scope; showing bars under Day
        // or Week would imply a per-model breakdown those scopes do not carry.
        isDeepSeek?dsModels.length&&period==='Session'?dsModels.slice(0,4).map(row=>chart(row,dsModelMax)):null:null,
        !isDeepSeek&&period==='Session'&&session?.models?.length?session.models.slice(0,4).map(row=>chart(row,session.cost||1)):null,
        h('div',{className:'or-balance'},h('div',{className:'or-row'},h('span',{className:'or-muted'},'Available balance'),h('strong',null,money(isDeepSeek?dsBalance?.balance:credits?.balance))),h('div',{className:'or-caption'},isDeepSeek?'Account-wide · reported by DeepSeek':'Account-wide · current USD balance')),
        isDeepSeek?null:h('div',{className:'or-row',style:{marginTop:6}},h('span',{className:'or-caption'},'Key total spend'),h('span',null,money(stats?.usageTotal))),
        currentError?h('p',{className:'or-error',role:'status'},currentData?'Displayed values may be stale. '+currentError:currentError):null,
        !isDeepSeek&&stats?.error?h('p',{className:'or-error'},[stats.usageDaily,stats.usageWeekly,stats.usageTotal,stats.limitRemaining].some(hasNumber)?'Key values are stale. '+stats.error:stats.error):null,
        !isDeepSeek&&credits?.error?h('p',{className:'or-error'},[credits.balance,credits.totalUsage,credits.totalCredits].some(hasNumber)?'Account values are stale. '+credits.error:credits.error):null,
        isDeepSeek?dsBalanceError:null,
        !isDeepSeek&&period==='Session' && session?.error?h('p',{className:'or-error'},session.error):null,
        isDeepSeek&&ds?.error?h('p',{className:'or-error'},ds.error):null,
        isDeepSeek&&ds?.truncated?h('p',{className:'or-error'},'Local token ledger limit reached. Older recorded spend is no longer included in these figures.'):null,
        isDeepSeek?null:h('details',{className:'or-detail',onToggle:e=>{if(!e.currentTarget.open)closeSetup();}},h('summary',null,'Details & balance setup'),
          h('p',{className:'or-row'},h('span',null,'Account total spend'),h('span',null,money(credits?.totalUsage))),
          h('p',{className:'or-row'},h('span',null,'Account credits purchased'),h('span',null,money(credits?.totalCredits))),
          h('p',{className:'or-row'},h('span',null,'Key allowance left'),h('span',null,money(stats?.limitRemaining))),
          h('p',{className:'or-note'},'Day / Week / Total include all apps using this API key. Session excludes subagents and inherited fork history. Missing or unreported request IDs cannot be priced. Balance is not the key spending allowance.'),
          h('p',{className:'or-note'},'Refreshes every 30 seconds while this tab is visible. Charges can arrive after a response finishes. External BYOK bills are not included in key credit usage.'),
          h('a',{href:'https://openrouter.ai/activity',target:'_blank',rel:'noopener noreferrer'},'Open OpenRouter dashboard ↗'),
          h('div',{className:'or-setup'},h('button',{type:'button',onClick:()=>{if(setup)closeSetup();else{setSetup(true);setKey('');setSetupMessage('');}},'aria-expanded':setup},currentData?.managementConfigured?'Update balance key':'Set up account balance'),
            setup?h('form',{onSubmit:saveKey},h('p',{className:'or-note'},'Add a separate management key for balance access. It is saved in DSH’s server credential store, never sent to models or saved in browser storage.'),h('a',{href:'https://openrouter.ai/settings/management-keys',target:'_blank',rel:'noopener noreferrer'},'Create a management key ↗'),h('input',{type:'password',value:key,onChange:e=>setKey(e.target.value),autoComplete:'off',placeholder:'OpenRouter management key','aria-label':'OpenRouter management key',required:true}),h('button',{type:'submit',disabled:saving||!key.trim()},saving?'Validating…':'Save key'),setupMessage?h('p',{className:'or-note',role:'status'},setupMessage):null):null)),
        isDeepSeek?h('details',{className:'or-detail',onToggle:e=>{if(!e.currentTarget.open)closeSetup();}},h('summary',null,'DeepSeek API setup'),
          h('p',{className:'or-row'},h('span',null,'Account balance'),h('span',null,money(dsBalance?.balance))),
          dsBalance?.currency?h('p',{className:'or-row'},h('span',null,'Currency'),h('span',null,dsBalance.currency)):null,
          dsBalance?.granted!==null&&dsBalance?.granted!==undefined?h('p',{className:'or-row'},h('span',null,'Granted balance'),h('span',null,money(dsBalance.granted))):null,
          dsBalance?.toppedUp!==null&&dsBalance?.toppedUp!==undefined?h('p',{className:'or-row'},h('span',null,'Topped-up balance'),h('span',null,money(dsBalance.toppedUp))):null,
          dsBalance?.isAvailable===false?h('p',{className:'or-error'},'DeepSeek reports this balance is not sufficient for further API calls.'):null,
          h('p',{className:'or-row'},h('span',null,'Model route'),h('span',null,currentData?.provider??'deepseek-official')),
          h('p',{className:'or-row'},h('span',null,'Credential'),h('span',null,currentData?.keyConfigured?'configured':'not configured')),
          h('p',{className:'or-row'},h('span',null,'Scopes'),h('span',null,periods.join(' · '))),
          h('p',{className:'or-note'},'DeepSeek publishes only an account balance. It offers no usage, spend, or per-model endpoint, so Recorded spend is estimated locally from the token counts DSH recorded, priced with DeepSeek’s published peak and off-peak rates. It is not a billing record; DeepSeek remains the billing authority.'),
          h('p',{className:'or-note'},'Peak rates apply 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; off-peak is half. Cache-hit input is billed below cache-miss input. Prices are maintained in this plugin and may lag a DeepSeek change.'),
          h('p',{className:'or-note'},'Use the provider dropdown above to switch between OpenRouter and DeepSeek. The ledger records only calls this plugin observed, and reaches back only to its first run. Balance is account-wide and exact; recorded spend covers this deployment alone.'),
          dsUnpriced?h('p',{className:'or-note'},'Some recorded tokens have no resolvable model and are excluded from spend while still counting toward the token total.'):null,
          h('a',{href:dsSetupHref,target:'_blank',rel:'noopener noreferrer'},'Open DeepSeek API keys ↗'),
          h('div',{className:'or-setup'},h('button',{type:'button',onClick:()=>{if(setup)closeSetup();else{setSetup(true);setKey('');setSetupMessage('');}},'aria-expanded':setup},currentData?.keyConfigured?'Update DeepSeek key':'Set up DeepSeek key'),
            setup?h('form',{onSubmit:saveKey},h('p',{className:'or-note'},'Paste an official DeepSeek platform API key to read your account balance. It is validated with a read-only balance request and saved in DSH’s server credential store, never sent to models or kept in browser storage.'),h('p',{className:'or-note'},'DSH already routes DeepSeek calls through the deepseek-official provider. Saving a key here reuses that same credential reference; it does not change how models are called.'),h('a',{href:dsSetupHref,target:'_blank',rel:'noopener noreferrer'},'Create a DeepSeek API key ↗'),h('input',{type:'password',value:key,onChange:e=>setKey(e.target.value),autoComplete:'off',placeholder:'DeepSeek API key','aria-label':'DeepSeek API key',required:true}),h('button',{type:'submit',disabled:saving||!key.trim()},saving?'Validating…':'Save key'),setupMessage?h('p',{className:'or-note',role:'status'},setupMessage):null):null)):null,
        h('div',{className:'or-fresh'},isDeepSeek?[dsBalance?.updatedAt?'Balance '+new Date(dsBalance.updatedAt).toLocaleTimeString():'Waiting for balance']:[stats?.updatedAt?'Usage '+new Date(stats.updatedAt).toLocaleTimeString():'Waiting for usage',credits?.updatedAt?' · Balance '+new Date(credits.updatedAt).toLocaleTimeString():'']));
      return h(React.Fragment,null,h('style',null,css),wide?card:h('div',{className:'or-rail'},h('button',{ref:triggerRef,type:'button',title:cardLabel,'aria-label':cardLabel,'aria-expanded':open,'aria-haspopup':'dialog','aria-controls':open?popoverId:undefined,onClick:()=>open?closePopover():setOpen(true)},'$'),open?h('div',{id:popoverId,className:'or-popover',role:'dialog','aria-label':cardLabel,onKeyDown:e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePopover();}},onBlur:e=>{if(!e.currentTarget.contains(e.relatedTarget))closePopover(false);}},h('button',{ref:closeRef,className:'or-close',type:'button',onClick:()=>closePopover(),'aria-label':'Close '+brandName+' usage'},'×'),card):null));
    }
    return {inject:['slots'],apply(ctx){ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'openrouter-usage',order:100},Panel));}};
  }
});
