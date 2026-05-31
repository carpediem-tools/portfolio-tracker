// Verrou FX manuel — centralise la politique d'invalidation des taux FX.
// Règle : un taux posé manuellement ('manual') n'est jamais écrasé
// automatiquement. Tout nouveau déclencheur d'invalidation DOIT passer
// par cette fonction — ne jamais écrire le pattern inline.
// Miroir Python : handle_syncfx dans portfolio_tracker.py (même règle, ligne unique).
function invalidateFxSource(obj, sourceField, value='ko'){
  obj[sourceField]=value;
}
// parseCryptoTicker — source de vérité partagée avec portfolio_tracker.py (parse_crypto_ticker)
// Toute modification des devises acceptées ou de la logique de parsing
// doit être répercutée manuellement dans les deux fichiers.
let DATA=null,currentTab='dashboard',expanded={},pendingSettings=null,saveErrorMsg=null;
let optNewBroker='',optNewBrokerErr=null,optNewClass='',optNewClassErr=null;
let optShowNewBroker=false,optShowNewClass=false;
let histoSortAsc=true;
const fxSyncAttempted={ctoTrades:false,cryptoTrades:false};
const TABS=[
  {id:'dashboard',label:'📊 Dashboard'},
  {id:'cto',label:'💼 Securities'},
  {id:'ctoES',label:'📋 Securities Sales'},
  {id:'crypto',label:'🪙 Cryptos'},
  {id:'cryptoES',label:'📋 Crypto Sales'},
  {id:'historique',label:'📅 History'},
  {id:'options',label:'⚙️ Options'},
  {id:'info',label:'ℹ️ Info'}
];
const COLORS=['#3b82f6','#f59e0b','#10b981','#8b5cf6','#ec4899','#06b6d4','#84cc16','#ef4444'];

// API
async function loadData(){
  const r=await fetch('/api/data');DATA=await r.json();
  if(!DATA.settings)DATA.settings={currency:'eur'};
  if(!DATA.settings.brokers)DATA.settings.brokers=[];
  if(!DATA.settings.classes)DATA.settings.classes=[];
  let migrated=false;
  (DATA.cto||[]).forEach(p=>{if(p.classe==='Metaux'){p.classe='Métaux';migrated=true;}});
  (DATA.historique||[]).forEach(h=>{
    if(!h.classes){
      h.classes={};
      if((h.actions||0)>0&&DATA.settings.classes.includes('Actions'))h.classes['Actions']=h.actions;
      if((h.metaux||0)>0&&DATA.settings.classes.includes('Métaux'))h.classes['Métaux']=h.metaux;
      if((h.immo||0)>0&&DATA.settings.classes.includes('Immo'))h.classes['Immo']=h.immo;
      delete h.actions;delete h.metaux;delete h.immo;
      migrated=true;
    }
    if(h.securities===undefined){h.securities=Object.values(h.classes||{}).reduce((s,v)=>s+(v||0),0);migrated=true;}
    if(!('fxRate' in h)){h.fxRate=null;h.fxRateSource=null;migrated=true;}
  });
  if(migrated)await saveData();
  render();
}
async function saveData(){
  await fetch('/api/data',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(DATA)});
}
async function quitApp(){
  if(!(await showConfirm('Stop the server?')))return;
  await fetch('/api/quit').catch(()=>{});
  document.body.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-size:1.4rem;color:#6b7a99">👋 Stopped.</div>';
}
function hasSyncTargets(scope){
  if(scope==='cto'||scope==='all') if((DATA.cto||[]).some(p=>p.ticker)) return true;
  if(scope==='crypto'||scope==='all') if((DATA.crypto||[]).some(p=>p.ticker)) return true;
  return false;
}
async function syncScope(scope){
  if(!hasSyncTargets(scope)){toast('⚠️ No price to sync','#7f1d1d');return;}
  const lbl={all:'all prices',cto:'Securities prices',crypto:'Crypto prices'};
  toast('⏳ Sync '+lbl[scope]+'…','#1d4ed8');
  try{
    const r=await fetch('/api/sync'+(scope==='all'?'':'/'+scope));
    const j=await r.json();DATA=j.data;
    const ns=j.stocks_ok.length,nf=j.stocks_fail.length;
    const nc=j.crypto_ok.length,ncf=j.crypto_fail.length;
    let parts=[];
    if(scope!=='crypto') parts.push('Stocks: '+ns+' ✅'+(nf?' '+nf+' ❌ ('+j.stocks_fail.join(', ')+')':''));
    if(scope!=='cto')    parts.push('Crypto: '+nc+' ✅'+(ncf?' '+ncf+' ❌':''));
    if(scope!=='cto'&&nc===0&&ncf>0) parts.push('Tip: use the CoinGecko id (bitcoin, ethereum), not the ticker symbol.');
    const ok=ns>0||nc>0;
    if(!ok&&nf>0) parts=['Yahoo inaccessible — pip install yfinance --break-system-packages'];
    toast((ok?'✅ ':'⚠ ')+parts.join(' | '),ok?'#166534':'#7f1d1d');
    render();
  }catch(e){toast('❌ Network error: '+e.message,'#7f1d1d');}
}
async function syncAll(){
  await syncScope('all');
  await syncHistoFx();
  if((DATA.ctoTrades||[]).length) await syncFx('ctoTrades');
  if((DATA.cryptoTrades||[]).length) await syncFx('cryptoTrades');
}
function toast(msg,bg){
  document.querySelectorAll('.toast').forEach(e=>e.remove());
  const d=document.createElement('div');d.className='toast';
  d.style.background=bg;d.textContent=msg;document.body.appendChild(d);
  setTimeout(()=>d.remove(),6000);
}

// Modal
let _modalResolve=null;
document.addEventListener('keydown',e=>{
  const o=document.getElementById('modal-overlay');
  if(!o||o.style.display==='none')return;
  if(e.key==='Enter'){e.preventDefault();_modalOk();}
  else if(e.key==='Escape'){e.preventDefault();_modalCancel();}
});
function _modalOk(){
  const inp=document.getElementById('modal-input');
  const v=inp.style.display!=='none'?inp.value:true;
  document.getElementById('modal-overlay').style.display='none';
  if(_modalResolve){_modalResolve(v);_modalResolve=null;}
}
function _modalCancel(){
  const inp=document.getElementById('modal-input');
  const v=inp.style.display!=='none'?null:false;
  document.getElementById('modal-overlay').style.display='none';
  if(_modalResolve){_modalResolve(v);_modalResolve=null;}
}
function showPrompt(label,defaultValue=''){
  return new Promise(resolve=>{
    _modalResolve=resolve;
    document.getElementById('modal-msg').textContent=label;
    const inp=document.getElementById('modal-input');
    inp.style.display='block';inp.value=defaultValue||'';
    document.getElementById('modal-overlay').style.display='flex';
    setTimeout(()=>inp.focus(),30);
  });
}
function showConfirm(message){
  return new Promise(resolve=>{
    _modalResolve=resolve;
    document.getElementById('modal-msg').textContent=message;
    document.getElementById('modal-input').style.display='none';
    document.getElementById('modal-overlay').style.display='flex';
    setTimeout(()=>document.querySelector('#modal-overlay .btn-blue').focus(),30);
  });
}

// Helpers
const CURRENCIES={eur:{symbol:'€',pos:'after',code:'eur'},usd:{symbol:'$',pos:'before',code:'usd'},chf:{symbol:'CHF',pos:'after',code:'chf'},gbp:{symbol:'£',pos:'before',code:'gbp'},jpy:{symbol:'¥',pos:'before',code:'jpy'},hkd:{symbol:'HK$',pos:'before',code:'hkd'},cny:{symbol:'CN¥',pos:'before',code:'cny'}};
function getCur(){return CURRENCIES[(DATA&&DATA.settings&&DATA.settings.currency)||'eur']||CURRENCIES.eur;}
function fmt(n){if(n==null)return '—';const c=getCur();const dec=c.code==='jpy'?0:2;const v=n.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec});return c.pos==='before'?c.symbol+' '+v:v+' '+c.symbol;}

function getFx(){return DATA.fxRates||{};}
function convert(amount,fromCur,toCur){
  if(amount==null||fromCur===toCur||!fromCur||!toCur)return amount;
  const fx=getFx();
  const f=fromCur.toLowerCase(),t=toCur.toLowerCase();
  // Vers EUR
  if(t==='eur'){
    if(f==='usd') return fx.eurusd?amount/fx.eurusd:null;
    if(f==='chf') return fx.eurchf?amount/fx.eurchf:null;
    if(f==='gbp') return fx.eurgbp?amount/fx.eurgbp:null;
    if(f==='jpy') return fx.eurjpy?amount/fx.eurjpy:null;
    if(f==='hkd') return fx.eurhkd?amount/fx.eurhkd:null;
    if(f==='cny') return fx.eurcny?amount/fx.eurcny:null;
  }
  // Vers USD
  if(t==='usd'){
    if(f==='eur') return fx.eurusd?amount*fx.eurusd:null;
    if(f==='chf') return fx.usdchf?amount/fx.usdchf:null;
    if(f==='gbp') return (fx.eurgbp&&fx.eurusd)?amount/fx.eurgbp*fx.eurusd:null;
    if(f==='jpy') return (fx.eurjpy&&fx.eurusd)?amount/fx.eurjpy*fx.eurusd:null;
    if(f==='hkd') return (fx.eurhkd&&fx.eurusd)?amount/fx.eurhkd*fx.eurusd:null;
    if(f==='cny') return (fx.eurcny&&fx.eurusd)?amount/fx.eurcny*fx.eurusd:null;
  }
  // Vers CHF
  if(t==='chf'){
    if(f==='eur') return fx.eurchf?amount*fx.eurchf:null;
    if(f==='usd') return fx.usdchf?amount*fx.usdchf:null;
    if(f==='gbp') return (fx.eurgbp&&fx.eurchf)?amount/fx.eurgbp*fx.eurchf:null;
    if(f==='jpy') return (fx.eurjpy&&fx.eurchf)?amount/fx.eurjpy*fx.eurchf:null;
    if(f==='hkd') return (fx.eurhkd&&fx.eurchf)?amount/fx.eurhkd*fx.eurchf:null;
    if(f==='cny') return (fx.eurcny&&fx.eurchf)?amount/fx.eurcny*fx.eurchf:null;
  }
  // Vers GBP
  if(t==='gbp'){
    if(f==='eur') return fx.eurgbp?amount*fx.eurgbp:null;
    if(f==='usd') return (fx.eurusd&&fx.eurgbp)?amount/fx.eurusd*fx.eurgbp:null;
    if(f==='chf') return (fx.eurchf&&fx.eurgbp)?amount/fx.eurchf*fx.eurgbp:null;
    if(f==='jpy') return (fx.eurjpy&&fx.eurgbp)?amount/fx.eurjpy*fx.eurgbp:null;
    if(f==='hkd') return (fx.eurhkd&&fx.eurgbp)?amount/fx.eurhkd*fx.eurgbp:null;
    if(f==='cny') return (fx.eurcny&&fx.eurgbp)?amount/fx.eurcny*fx.eurgbp:null;
  }
  // Vers JPY
  if(t==='jpy'){
    if(f==='eur') return fx.eurjpy?amount*fx.eurjpy:null;
    if(f==='usd') return (fx.eurusd&&fx.eurjpy)?amount/fx.eurusd*fx.eurjpy:null;
    if(f==='chf') return (fx.eurchf&&fx.eurjpy)?amount/fx.eurchf*fx.eurjpy:null;
    if(f==='gbp') return (fx.eurgbp&&fx.eurjpy)?amount/fx.eurgbp*fx.eurjpy:null;
    if(f==='hkd') return (fx.eurhkd&&fx.eurjpy)?amount/fx.eurhkd*fx.eurjpy:null;
    if(f==='cny') return (fx.eurcny&&fx.eurjpy)?amount/fx.eurcny*fx.eurjpy:null;
  }
  // Vers HKD
  if(t==='hkd'){
    if(f==='eur') return fx.eurhkd?amount*fx.eurhkd:null;
    if(f==='usd') return (fx.eurusd&&fx.eurhkd)?amount/fx.eurusd*fx.eurhkd:null;
    if(f==='chf') return (fx.eurchf&&fx.eurhkd)?amount/fx.eurchf*fx.eurhkd:null;
    if(f==='gbp') return (fx.eurgbp&&fx.eurhkd)?amount/fx.eurgbp*fx.eurhkd:null;
    if(f==='jpy') return (fx.eurjpy&&fx.eurhkd)?amount/fx.eurjpy*fx.eurhkd:null;
    if(f==='cny') return (fx.eurcny&&fx.eurhkd)?amount/fx.eurcny*fx.eurhkd:null;
  }
  // Vers CNY
  if(t==='cny'){
    if(f==='eur') return fx.eurcny?amount*fx.eurcny:null;
    if(f==='usd') return (fx.eurusd&&fx.eurcny)?amount/fx.eurusd*fx.eurcny:null;
    if(f==='chf') return (fx.eurchf&&fx.eurcny)?amount/fx.eurchf*fx.eurcny:null;
    if(f==='gbp') return (fx.eurgbp&&fx.eurcny)?amount/fx.eurgbp*fx.eurcny:null;
    if(f==='jpy') return (fx.eurjpy&&fx.eurcny)?amount/fx.eurjpy*fx.eurcny:null;
    if(f==='hkd') return (fx.eurhkd&&fx.eurcny)?amount/fx.eurhkd*fx.eurcny:null;
  }
  return null;
}
// getCurrencyFromTicker — cas de test
//   'AAPL'      → 'usd'    (pas de point → NASDAQ/NYSE par défaut)
//   'CW8.PA'    → 'eur'
//   'AIR.PA'    → 'eur'
//   'NESN.SW'   → 'chf'
//   'ROG.VX'    → 'chf'
//   'VUSA.AS'   → 'eur'
//   'DBK.DE'    → 'eur'
//   'SHEL.L'    → 'gbp'
//   '7203.T'    → 'jpy'
//   '0700.HK'   → 'hkd'
//   '600519.SS' → 'cny'
//   '000858.SZ' → 'cny'
//   'AAPL.XX'   → null   (suffixe non géré)
//   ''          → null
//   null        → null
//   '.PA'       → 'eur'  (cas limite : préfixe vide, suffixe valide)
function getCurrencyFromTicker(ticker){
  if(ticker==null||typeof ticker!=='string')return null;
  const t=ticker.trim();
  if(!t)return null;
  const dot=t.lastIndexOf('.');
  if(dot===-1)return 'usd';
  const suffix=t.slice(dot+1).toUpperCase();
  const EUR_SUFFIXES=['PA','AS','DE','F','MI','BR','LS','MC'];
  const CHF_SUFFIXES=['SW','VX'];
  const GBP_SUFFIXES=['L'];
  const JPY_SUFFIXES=['T'];
  const HKD_SUFFIXES=['HK'];
  const CNY_SUFFIXES=['SS','SZ'];
  if(EUR_SUFFIXES.includes(suffix))return 'eur';
  if(CHF_SUFFIXES.includes(suffix))return 'chf';
  if(GBP_SUFFIXES.includes(suffix))return 'gbp';
  if(JPY_SUFFIXES.includes(suffix))return 'jpy';
  if(HKD_SUFFIXES.includes(suffix))return 'hkd';
  if(CNY_SUFFIXES.includes(suffix))return 'cny';
  return null;
}
// parseCryptoTicker — cas de test
//   'bitcoin:usd'    → {id:'bitcoin', currency:'usd'}
//   'ethereum:EUR'   → {id:'ethereum', currency:'eur'}
//   'bitcoin'        → null   (pas de ':')
//   'bitcoin:'       → null   (currency vide)
//   ':usd'           → null   (id vide)
//   'bitcoin:btc'    → null   (devise non supportée)
//   'a:b:c'          → null   (plusieurs ':')
//   ''               → null
function parseCryptoTicker(ticker){
  if(ticker==null||typeof ticker!=='string')return null;
  const t=ticker.trim();
  if(!t)return null;
  const parts=t.split(':');
  if(parts.length!==2)return null;
  const id=parts[0].trim();
  const currency=parts[1].trim().toLowerCase();
  if(!id)return null;
  if(!['eur','usd','chf','gbp','jpy','hkd','cny'].includes(currency))return null;
  return{id,currency};
}
function fmtNative(n,curCode){
  if(n==null||!curCode)return '—';
  const c=CURRENCIES[curCode.toLowerCase()]||getCur();
  const dec=curCode.toLowerCase()==='jpy'?0:2;
  const v=n.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec});
  return c.pos==='before'?c.symbol+' '+v:v+' '+c.symbol;
}
const fmtP=n=>n==null?'—':(n*100).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})+'%';
function fmtC(n,curCode){if(n==null)return '—';const c=CURRENCIES[curCode]||getCur();const dec=(curCode||'').toLowerCase()==='jpy'?0:2;const v=n.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec});return c.pos==='before'?c.symbol+' '+v:v+' '+c.symbol;}
const fmtQ=n=>!n?'':n.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:6});
function isoToday(){const d=new Date(),p=n=>String(n).padStart(2,'0');return`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function isoNow(){const d=new Date(),p=n=>String(n).padStart(2,'0');return`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;}
const gpC=n=>n>=0?'gain':'loss';
const nextId=a=>Math.max(0,...a.map(x=>x.id))+1;
function calcPos(p){
  const tq=p.purchases.reduce((s,x)=>s+(x.qty||0),0);
  const ti=p.purchases.reduce((s,x)=>s+((x.qty||0)*(x.price||0)+(x.fees||0)),0);
  const wac=tq?ti/tq:0,valo=p.livePrice?tq*p.livePrice:0;
  return{tq,ti,wac,valo,gp:p.livePrice?valo-ti:0,evol:p.livePrice&&ti?(valo-ti)/ti:0};
}
function calcTrade(t){
  if(!(t.qSold>0&&t.priceBuy>0&&t.priceSell>0))return{ts:0,tb:0,gp:null,pct:null};
  const ts=(t.qSold||0)*(t.priceSell||0)-(t.feesSell||0);
  const tb=(t.qSold||0)*(t.priceBuy||0)+(t.feesBuy||0);
  return{ts,tb,gp:ts-tb,pct:tb?(ts-tb)/tb:0};
}
function pBg(p){
  if(p.priceSource==='stale') return 'error-cell';
  if(p.priceSource==='manual') return 'outdated-cell';
  if(!p.priceDate) return '';
  const today=isoToday();
  const pDay=p.priceDate.split(' ')[0];
  return pDay===today?'today-cell':'outdated-cell';
}
function pIco(p){
  if(p.priceSource==='stale') return '🔴';
  if(p.priceSource==='manual') return '🟡';
  if(!p.priceDate) return '⚪';
  const today=isoToday();
  const pDay=p.priceDate.split(' ')[0];
  return pDay===today?'🟢':'🟡';
}

function makeColgroup(weights){
  const s=weights.reduce((a,b)=>a+b,0);
  return`<colgroup>${weights.map(w=>`<col style="width:${(w/s*100).toFixed(1)}%">`).join('')}</colgroup>`;
}

// Render
function render(){
  document.getElementById('tabs').innerHTML=TABS.map(t=>
    `<button class="tab ${currentTab===t.id?'active':''}" onclick="switchTab('${t.id}')">${t.label}</button>`
  ).join('');
  const app=document.getElementById('app');
  if(currentTab==='options')       app.innerHTML=renderOptions();
  else if(currentTab==='dashboard')     app.innerHTML=renderDash();
  else if(currentTab==='cto')      app.innerHTML=renderSpot('cto');
  else if(currentTab==='crypto')   app.innerHTML=renderSpot('crypto');
  else if(currentTab==='ctoES')    app.innerHTML=renderES('cto');
  else if(currentTab==='cryptoES') app.innerHTML=renderES('crypto');
  else if(currentTab==='info')     app.innerHTML=renderInfo();
  else app.innerHTML=renderHisto();
}
function switchTab(t){if(currentTab==='options'&&t!=='options'){pendingSettings=null;optNewBroker='';optNewBrokerErr=null;optNewClass='';optNewClassErr=null;optShowNewBroker=false;optShowNewClass=false;}currentTab=t;render();}
function toggleExp(k){expanded[k]=!expanded[k];render();}

// Pie
function makePie(items,vk,lk,title){
  const f=items.filter(x=>x[vk]>0);
  if(!f.length) return `<div class="card" style="flex:1 1 230px"><h3>${title}</h3>
    <p style="color:var(--text2);font-size:12px">No data</p></div>`;
  const tot=f.reduce((s,x)=>s+x[vk],0); let cum=0;
  const r=66,cx=84,cy=84;
  const slices=f.length===1
    ?`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLORS[0]}" stroke="var(--bg)" stroke-width="2"/>
      <text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="9" fill="#fff">100%</text>`
    :f.map((x,i)=>{
      const pct=x[vk]/tot,a1=cum*Math.PI/180;cum+=pct*360;const a2=cum*Math.PI/180;
      const x1=cx+r*Math.sin(a1),y1=cy-r*Math.cos(a1);
      const x2=cx+r*Math.sin(a2),y2=cy-r*Math.cos(a2);
      const mid=(cum-pct*180)*Math.PI/180;
      const tx=(cx+43*Math.sin(mid)).toFixed(0),ty=(cy-43*Math.cos(mid)+4).toFixed(0);
      return`<path d="M${cx},${cy}L${x1.toFixed(1)},${y1.toFixed(1)}A${r},${r} 0 ${pct>.5?1:0},1 ${x2.toFixed(1)},${y2.toFixed(1)}Z"
        fill="${COLORS[i%8]}" stroke="var(--bg)" stroke-width="2"/>
        ${pct>.06?`<text x="${tx}" y="${ty}" text-anchor="middle" font-size="9" fill="#fff">${Math.round(pct*100)}%</text>`:''}`;
    }).join('');
  const leg=f.map((x,i)=>`<div style="display:flex;align-items:center;gap:5px;margin:2px 0">
    <span style="width:9px;height:9px;border-radius:2px;background:${COLORS[i%8]};flex-shrink:0;display:inline-block"></span>
    <span style="font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x[lk]}</span>
    <span style="font-size:10px;color:var(--text2);font-family:monospace">${fmt(x[vk])}</span>
  </div>`).join('');
  return`<div class="card" style="flex:1 1 230px"><h3>${title}</h3>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <svg viewBox="0 0 168 168" width="136" height="136">${slices}</svg>
      <div style="flex:1;min-width:100px">${leg}</div>
    </div></div>`;
}

// Line chart
function convertHistoRow(h,amount){
  if(h.fxRate==null||h.fxRateSource==='ko')return null;
  return amount*h.fxRate;
}

function lineChart(hist){
  const displayCur=getCur().code;
  const curSym={eur:'€',usd:'$',chf:'CHF',gbp:'£',jpy:'¥',hkd:'HK$',cny:'CN¥'}[displayCur]||'€';
  const pts=(hist||DATA.historique).map(h=>({year:h.year,total:convertHistoRow(h,h.total)})).filter(h=>h.total!=null&&h.total>0);
  if(pts.length<2) return '<p style="color:var(--text2);font-size:12px;padding:8px 0">At least 2 years of data required.</p>';
  const W=Math.max(500,pts.length*80),H=175,PL=60,PR=20,PT=22,PB=30;
  const xs=pts.map((_,i)=>PL+i*(W-PL-PR)/(pts.length-1));
  const vs=pts.map(p=>p.total),mn=Math.min(...vs),mx=Math.max(...vs),rng=mx-mn||1;
  const ys=vs.map(v=>PT+(H-PT-PB)*(1-(v-mn)/rng));
  const pD=xs.map((x,i)=>(i?'L':'M')+x.toFixed(1)+','+ys[i].toFixed(1)).join(' ');
  const fD=pD+` L${xs[xs.length-1].toFixed(1)},${H-PB} L${xs[0].toFixed(1)},${H-PB} Z`;
  const grid=[0,.5,1].map(t=>{
    const v=mn+t*rng,y=(PT+(H-PT-PB)*(1-t)).toFixed(1);
    return`<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>
      <text x="${PL-6}" y="${(+y+4).toFixed(0)}" text-anchor="end" font-size="9" fill="var(--text2)">${Math.round(v).toLocaleString('en-US')} ${curSym}</text>`;
  }).join('');
  const dots=xs.map((x,i)=>
    `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--bg)" stroke-width="2"/>
     <text x="${x.toFixed(1)}" y="${H-PB+13}" text-anchor="middle" font-size="9" fill="var(--text2)">${pts[i].year}</text>
     <text x="${x.toFixed(1)}" y="${(ys[i]-9).toFixed(1)}" text-anchor="middle" font-size="8" fill="var(--accent)" font-weight="600">${Math.round(pts[i].total).toLocaleString('en-US')} ${curSym}</text>`
  ).join('');
  return`<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${H-PB}" stroke="var(--border)" stroke-width="1"/>
    <line x1="${PL}" y1="${H-PB}" x2="${W-PR}" y2="${H-PB}" stroke="var(--border)" stroke-width="1"/>
    ${grid}
    <path d="${fD}" fill="url(#lg)"/>
    <path d="${pD}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;
}

// Dashboard
function renderOptions(){
  if(!pendingSettings){pendingSettings=JSON.parse(JSON.stringify(DATA.settings||{}));saveErrorMsg=null;}
  const cur=pendingSettings.currency||'eur';
  const brokers=DATA.settings.brokers||[];
  const classes=DATA.settings.classes||[];
  return `<div class="card"><h3>⚙️ Options</h3>
    <div style="margin-bottom:20px">
      <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:8px;font-weight:600">Currency</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${[{v:'eur',l:'🇪🇺 Euro (€)'},{v:'usd',l:'🇺🇸 Dollar ($)'},{v:'chf',l:'🇨🇭 Swiss Franc (CHF)'},{v:'gbp',l:'🇬🇧 Pound (£)'},{v:'jpy',l:'🇯🇵 Yen (¥)'},{v:'hkd',l:'🇭🇰 HK Dollar (HK$)'},{v:'cny',l:'🇨🇳 Yuan (CN¥)'}].map(c=>{
          const sel=cur===c.v;
          return `<button class="btn ${sel?'btn-blue':'btn-ghost'}" onclick="optSetCurrency('${c.v}')">${c.l}</button>`;
        }).join('')}
      </div>
      <p style="font-size:11px;color:var(--text2);margin-top:8px">
        Consolidation currency for all amounts displayed in the application.<br>
        Individual prices are always shown in each position's native currency.
      </p>
    </div>
    <div style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <label style="font-size:12px;color:var(--text2);font-weight:600">Securities / Brokers</label>
        ${brokers.length<10?`<button class="btn btn-ghost btn-sm" onclick="optToggleNewBroker()">+</button>`:''}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${brokers.map((b,i)=>`
          <div style="display:flex;gap:6px;align-items:center">
            <span style="min-width:180px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:12px;color:var(--text)">${b}</span>
            <button class="btn btn-ghost" onclick="optDeleteBrokerImm(${i})">✕</button>
          </div>`).join('')}
        ${optShowNewBroker?`<div style="display:flex;gap:6px;align-items:center">
          <input id="opt-new-broker" placeholder="New broker…" value="${optNewBroker}" maxlength="15" style="width:180px" onkeydown="if(event.key==='Enter'){event.preventDefault();optAddBrokerNew();}">
          <button class="btn btn-ghost" onclick="optAddBrokerNew()">✔</button>
        </div>
        ${optNewBrokerErr?`<p style="color:var(--red);font-size:11px;margin-top:2px">${optNewBrokerErr}</p>`:''}`:``}
      </div>
      ${brokers.length>=10?`<p style="font-size:11px;color:var(--text2);margin-top:4px">Maximum 10 brokers reached.</p>`:''}
    </div>
    <div style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <label style="font-size:12px;color:var(--text2);font-weight:600">Securities / Asset classes</label>
        ${classes.length<10?`<button class="btn btn-ghost btn-sm" onclick="optToggleNewClass()">+</button>`:''}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${classes.map((cl,i)=>`
          <div style="display:flex;gap:6px;align-items:center">
            <span style="min-width:180px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:12px;color:var(--text)">${cl}</span>
            <button class="btn btn-ghost" onclick="optDeleteClassImm(${i})">✕</button>
          </div>`).join('')}
        ${optShowNewClass?`<div style="display:flex;gap:6px;align-items:center">
          <input id="opt-new-class" placeholder="New class…" value="${optNewClass}" maxlength="15" style="width:180px" onkeydown="if(event.key==='Enter'){event.preventDefault();optAddClassNew();}">
          <button class="btn btn-ghost" onclick="optAddClassNew()">✔</button>
        </div>
        ${optNewClassErr?`<p style="color:var(--red);font-size:11px;margin-top:2px">${optNewClassErr}</p>`:''}`:``}
      </div>
      ${classes.length>=10?`<p style="font-size:11px;color:var(--text2);margin-top:4px">Maximum 10 classes reached.</p>`:''}
    </div>
    <div style="margin-bottom:20px">
      <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:8px;font-weight:600">Data</label>
      <button class="btn btn-ghost" onclick="exportJSON()">📥 Export JSON</button>
      <button class="btn btn-ghost" style="margin-left:8px" onclick="document.getElementById('impF').click()">📤 Import JSON</button>
      <input type="file" id="impF" accept=".json" style="display:none" onchange="importJSON(this)">
      <button id="btn-export" class="btn btn-ghost" style="margin-left:8px" onclick="exportZIP()">⬇ Export data (ZIP)</button>
    </div>
    <div style="padding-top:16px;border-top:1px solid var(--border)">
      ${saveErrorMsg?`<p style="color:var(--red);font-size:12px;margin-bottom:8px">${saveErrorMsg}</p>`:''}
      <div style="display:flex;gap:8px">
        <button class="btn btn-green" onclick="saveOptions()">💾 Save</button>
        <button class="btn btn-ghost" onclick="cancelOptions()">✕ Cancel</button>
      </div>
    </div>
  </div>`;
}
function renderInfo(){
  return`<div class="card">
    <h3>📊 Portfolio Tracker — V1.0</h3>
    <p style="color:var(--text2);margin-top:4px;margin-bottom:24px;font-size:13px">Local investment tracker</p>
    <div style="display:flex;flex-direction:column;gap:6px;font-size:13px;margin-bottom:28px">
      <div><span style="color:var(--text2);min-width:120px;display:inline-block">Version</span><span>v1.0</span></div>
      <div><span style="color:var(--text2);min-width:120px;display:inline-block">Date</span><span>2026/05/31</span></div>
      <div><span style="color:var(--text2);min-width:120px;display:inline-block">Author</span><span>Carpe Diem</span></div>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:20px">
      <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:10px;font-weight:600">Documentation</label>
      <a href="/docs" target="_blank" class="btn btn-blue" style="font-size:13px;text-decoration:none;display:inline-block">📖 Open documentation</a>
    </div>
  </div>`;
}
function optSetCurrency(c){pendingSettings.currency=c;document.getElementById('app').innerHTML=renderOptions();}
function optToggleNewBroker(){optShowNewBroker=!optShowNewBroker;if(optShowNewBroker){optNewBroker='';optNewBrokerErr=null;}document.getElementById('app').innerHTML=renderOptions();}
function optToggleNewClass(){optShowNewClass=!optShowNewClass;if(optShowNewClass){optNewClass='';optNewClassErr=null;}document.getElementById('app').innerHTML=renderOptions();}
async function optDeleteBrokerImm(i){
  const val=(DATA.settings.brokers||[])[i];
  if(val==null)return;
  const used=(DATA.cto||[]).filter(p=>p.broker===val);
  if(used.length>0){
    if(!(await showConfirm('"'+val+'" is used in '+used.length+' position(s). Deleting it will clear this field in Securities. Continue?')))return;
    DATA.cto=DATA.cto.map(p=>p.broker===val?{...p,broker:''}:p);
  }
  DATA.settings.brokers=DATA.settings.brokers.filter((_,j)=>j!==i);
  saveData();
  document.getElementById('app').innerHTML=renderOptions();
}
function optAddBrokerNew(){
  const val=(document.getElementById('opt-new-broker')?.value||'').trim();
  optNewBroker=val;
  if(!val){optNewBrokerErr='Name cannot be empty.';document.getElementById('app').innerHTML=renderOptions();return;}
  if((DATA.settings.brokers||[]).some(b=>b.toLowerCase()===val.toLowerCase())){optNewBrokerErr='"'+val+'" already exists.';document.getElementById('app').innerHTML=renderOptions();return;}
  optNewBrokerErr=null;optNewBroker='';optShowNewBroker=false;
  if(!DATA.settings.brokers)DATA.settings.brokers=[];
  DATA.settings.brokers.push(val);
  saveData();
  document.getElementById('app').innerHTML=renderOptions();
}
async function optDeleteClassImm(i){
  const val=(DATA.settings.classes||[])[i];
  if(val==null)return;
  const used=(DATA.cto||[]).filter(p=>p.classe===val);
  if(used.length>0){
    if(!(await showConfirm('"'+val+'" is used in '+used.length+' position(s). Deleting it will clear this field in Securities. Continue?')))return;
    DATA.cto=DATA.cto.map(p=>p.classe===val?{...p,classe:''}:p);
  }
  DATA.settings.classes=DATA.settings.classes.filter((_,j)=>j!==i);
  saveData();
  document.getElementById('app').innerHTML=renderOptions();
}
function optAddClassNew(){
  const val=(document.getElementById('opt-new-class')?.value||'').trim();
  optNewClass=val;
  if(!val){optNewClassErr='Name cannot be empty.';document.getElementById('app').innerHTML=renderOptions();return;}
  if((DATA.settings.classes||[]).some(c=>c.toLowerCase()===val.toLowerCase())){optNewClassErr='"'+val+'" already exists.';document.getElementById('app').innerHTML=renderOptions();return;}
  optNewClassErr=null;optNewClass='';optShowNewClass=false;
  if(!DATA.settings.classes)DATA.settings.classes=[];
  DATA.settings.classes.push(val);
  saveData();
  document.getElementById('app').innerHTML=renderOptions();
}
function saveOptions(){
  const oldCur=DATA.settings?.currency||'eur';
  const newCur=pendingSettings.currency||'eur';
  DATA.settings.currency=newCur;
  if(oldCur!==newCur){
    for(const key of ['ctoTrades','cryptoTrades']){
      DATA[key]=(DATA[key]||[]).map(t=>{
        const u={...t};
        invalidateFxSource(u,'fxRateBuySource');
        invalidateFxSource(u,'fxRateSellSource');
        return u;
      });
    }
    DATA.historique=(DATA.historique||[]).map(h=>{const u={...h};invalidateFxSource(u,'fxRateSource');return u;});
    toast('⚠️ Display currency changed — FX rates for exits invalidated. Please re-sync.','#92400e');
  }
  saveData();render();
}
function cancelOptions(){pendingSettings=JSON.parse(JSON.stringify(DATA.settings));document.getElementById('app').innerHTML=renderOptions();}
function exportJSON(){
  const b=new Blob([JSON.stringify(DATA,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);
  a.download='portfolio_data.json';a.click();
}
function importJSON(input){
  const f=input.files[0];if(!f)return;
  const r=new FileReader();r.onload=e=>{
    try{DATA=JSON.parse(e.target.result);saveData();render();
      toast('✅ Data imported','#166534');
    }catch(err){toast('❌ Invalid JSON','#7f1d1d');}
  };r.readAsText(f);
}

function renderDash(){
  const displayCur=getCur().code;
  const ctoC=DATA.cto.map(p=>({...p,c:calcPos(p)}));
  const crC=DATA.crypto.map(p=>({...p,c:calcPos(p)}));
  // Conversion de chaque valo vers la devise Options
  function convertValo(p,c){
    if(!p.livePrice||!p.currency)return null;
    return convert(c.valo,p.currency,displayCur);
  }
  let excludedCount=0;
  const cls=(DATA.settings.classes||[]).map(cl=>{
    const ps=ctoC.filter(p=>p.classe===cl&&p.livePrice);
    let valo=0;
    ps.forEach(p=>{const v=convertValo(p,p.c);if(v!=null)valo+=v;else excludedCount++;});
    return{name:cl,valo};
  });
  const unclValo=ctoC.filter(p=>p.livePrice&&!p.classe).reduce((s,p)=>{
    const v=convertValo(p,p.c);if(v!=null)return s+v;excludedCount++;return s;
  },0);
  if(unclValo>0)cls.push({name:'?',valo:unclValo});
  const crValo=crC.filter(p=>p.livePrice).reduce((s,p)=>{
    const v=convertValo(p,p.c);if(v!=null)return s+v;excludedCount++;return s;
  },0);
  cls.push({name:'Cryptos',valo:crValo});
  const totV=cls.reduce((s,c)=>s+c.valo,0);
  const hasFx=Object.keys(getFx()).length>0;
  const hasTrades=(DATA.ctoTrades||[]).length>0||(DATA.cryptoTrades||[]).length>0;
  const bmap={};
  ctoC.filter(p=>p.livePrice).forEach(p=>{
    const b=p.broker||'?';
    const v=convertValo(p,p.c);
    if(v!=null)bmap[b]=(bmap[b]||0)+v;
  });
  const bPie=Object.entries(bmap).map(([name,valo])=>({name,valo}));
  const sorted=[...DATA.historique].sort((a,b)=>a.year-b.year);
  const hRows=sorted.map((h,i)=>{
    const cSec=convertHistoRow(h,h.securities||0);
    const cCrypto=convertHistoRow(h,h.crypto||0);
    const cTotal=convertHistoRow(h,h.total||0);
    const prevH=i>0?sorted[i-1]:null;
    const prevTotal=prevH?convertHistoRow(prevH,prevH.total||0):null;
    const v=(cTotal!=null&&prevTotal!=null&&prevTotal!==0)?(cTotal-prevTotal)/prevTotal:null;
    return`<tr>
      <td class="mono">${h.year}</td>
      <td class="r mono">${cSec!=null?fmt(cSec):'—'}</td>
      <td class="r mono">${cCrypto!=null?fmt(cCrypto):'—'}</td>
      <td class="r mono">${cTotal!=null?fmt(cTotal):'—'}</td>
      <td class="r mono ${v!=null?gpC(v):''}">${v!=null?fmtP(v):'—'}</td></tr>`;
  }).join('');
  return`<div class="kpis">
    <div class="kpi">
      <div class="kpi-label">Total valuation (${displayCur.toUpperCase()})</div>
      <div class="kpi-value" style="color:var(--accent)">${fmt(totV)}</div>
    </div>
    ${excludedCount?`<div class="kpi" style="border-color:#92400e">
      <div class="kpi-label" style="color:#f59e0b">⚠️ Excluded positions</div>
      <div class="kpi-value" style="color:#f59e0b;font-size:14px">${excludedCount} without currency or FX</div>
    </div>`:''}
  </div>
  ${!hasFx&&hasTrades?`<div style="background:#2a1f08;border:1px solid #92400e;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:11px;color:#fbbf24">
    ⚠️ Exchange rates not loaded — run a sync to enable currency conversion.
  </div>`:`<div style="font-size:10px;color:var(--text2);margin-bottom:10px;padding:0 2px">
    💱 Valuations converted at today's rate — P&L and invested shown per currency in each tab.
  </div>`}
  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
    ${makePie(ctoC.filter(p=>p.livePrice).map(p=>({name:p.name||p.ticker||'?',valo:convertValo(p,p.c)})).filter(o=>o.valo!=null),'valo','name','Securities')}
    ${makePie(cls,'valo','name','Asset class')}
    ${makePie(bPie,'valo','name','Brokers')}
    ${makePie(crC.filter(p=>p.livePrice).map(p=>({name:p.name||p.ticker||'?',valo:convertValo(p,p.c)})).filter(o=>o.valo!=null),'valo','name','Cryptos')}
  </div>
  <div class="card" style="margin-bottom:12px"><h3>Total valuation over time</h3>${lineChart(sorted)}</div>
  <div class="card"><h3>Annual snapshot (Dec 31)</h3>
    <div style="overflow-x:auto;max-width:100%"><table class="resp-tbl" style="min-width:400px">${makeColgroup([6,12,12,12,8])}<thead><tr>
      <th>Year</th><th class="r">Securities</th><th class="r">Cryptos</th><th class="r">Total</th><th class="r">Chg.</th>
    </tr></thead>
    <tbody>${hRows}</tbody></table></div>
  </div>`;
}

// Spot
function renderSpot(type){
  const isCto=type==='cto';
  const displayCur=getCur().code;
  const calcs=DATA[type].map(p=>({...p,c:calcPos(p)}));
  const priced=calcs.filter(p=>p.livePrice);
  const totI=priced.reduce((s,p)=>{
    const v=convert(p.c.ti,p.currency,displayCur);
    return v!=null?s+v:s;
  },0);
  const totV=priced.reduce((s,p)=>{
    const v=convert(p.c.valo,p.currency,displayCur);
    return v!=null?s+v:s;
  },0);
  const totGP=totV-totI;
  const cols=isCto?18:15;
  const colgroupSpot=makeColgroup(isCto?[2,11,7,7,8,7,4,5,7,7,10,3,7,7,5,7,5,3]:[2,14,9,5,6,8,8,12,3,7,8,6,8,5,3]);
  const colgroupSub=makeColgroup([22,12,16,12,18,16,4]);
  let rows='';
  calcs.forEach(p=>{
    const c=p.c,k=type+p.id,exp=expanded[k];
    rows+=`<tr style="cursor:pointer" onclick="toggleExp('${k}')">
      <td style="text-align:center;color:var(--text2);font-size:10px">${exp?'▲':'▼'}</td>
      <td><input value="${p.name||''}" onchange="upPos('${type}',${p.id},'name',this.value)" onclick="event.stopPropagation()"></td>
      ${isCto?`<td><input value="${p.isin||''}" onchange="upPos('${type}',${p.id},'isin',this.value)" onclick="event.stopPropagation()"></td>`:''}
      <td><input value="${p.ticker||''}" placeholder="${isCto?'ex: CW8.PA':'ex: bitcoin:usd'}" onchange="${isCto?`upCtoTicker(${p.id},this.value)`:`upCryptoTicker(${p.id},this.value)`}" onclick="event.stopPropagation()"></td>
      ${isCto?`<td onclick="event.stopPropagation()"><select onchange="upPos('cto',${p.id},'broker',this.value)">
        <option value=""${!p.broker?' selected':''}></option>
        ${(DATA.settings.brokers||[]).map(b=>`<option${p.broker===b?' selected':''}>${b}</option>`).join('')}</select></td>
      <td onclick="event.stopPropagation()"><select onchange="upPos('cto',${p.id},'classe',this.value)">
        <option value=""${!p.classe?' selected':''}></option>
        ${(DATA.settings.classes||[]).map(cl=>`<option value="${cl}"${p.classe===cl?' selected':''}>${cl}</option>`).join('')}</select></td>`:''}
      <td style="text-align:center;font-size:11px;color:var(--text2)">${p.currency?p.currency.toUpperCase():'—'}</td>
      <td class="r mono computed">${fmtQ(c.tq)}</td>
      <td class="r mono computed">${c.wac>0?fmtNative(c.wac,p.currency):''}</td>
      <td class="r mono computed">${c.ti>0?fmtNative(c.ti,p.currency):''}</td>
      <td class="${pBg(p)} mono">
        ${pIco(p)} ${p.livePrice?fmtNative(p.livePrice,p.currency):'—'}
      </td>
      <td class="btn-col">
        <button onclick="event.stopPropagation();manualPrice('${type}',${p.id})" style="background:none;border:none;cursor:pointer;padding:2px"><span style="display:inline-block;transform:scaleX(-1)">✏️</span></button>
      </td>
      <td style="font-size:10px;color:var(--text2)">${p.priceDate||''}</td>
      <td class="r mono">${p.livePrice?fmtNative(c.valo,p.currency):''}</td>
      <td class="r mono ${p.livePrice&&c.ti?gpC(c.evol):''}">${p.livePrice&&c.ti?fmtP(c.evol):''}</td>
      <td class="r mono ${p.livePrice&&c.ti?gpC(c.gp):''}">${p.livePrice&&c.ti?fmtNative(c.gp,p.currency):''}</td>
      <td class="r mono">${p.livePrice&&totI?fmtP(c.ti/totI):''}</td>
      <td><button class="btn btn-red btn-sm" onclick="event.stopPropagation();delPos('${type}',${p.id})">🗑</button></td>
    </tr>`;
    if(exp){
      let sub='';
      p.purchases.forEach((pu,i)=>{
        const ti2=(pu.qty||0)*(pu.price||0)+(pu.fees||0);
        const lotAvgCost=(pu.qty||0)?ti2/(pu.qty||0):0;
        sub+=`<tr>
          <td><input type="date" value="${pu.date||''}" onchange="upPurch('${type}',${p.id},${i},'date',this.value)"></td>
          <td class="r"><input type="number" step="any" value="${pu.qty||''}" onchange="upPurch('${type}',${p.id},${i},'qty',this.value)"></td>
          <td class="r"><input type="number" step="any" value="${pu.price||''}" onchange="upPurch('${type}',${p.id},${i},'price',this.value)"></td>
          <td class="r"><input type="number" step="any" value="${pu.fees||''}" onchange="upPurch('${type}',${p.id},${i},'fees',this.value)"></td>
          <td class="r mono">${fmtNative(ti2,p.currency)}</td>
          <td class="r mono">${lotAvgCost?fmtNative(lotAvgCost,p.currency):''}</td>
          <td><button class="btn btn-red btn-sm" onclick="delPurch('${type}',${p.id},${i})">✕</button></td></tr>`;
      });
      if(p.purchases.length){
        const tf=p.purchases.reduce((s,x)=>s+(x.fees||0),0);
        sub+=`<tr style="background:#0f1630;border-top:2px solid var(--accent)">
          <td style="font-weight:700;color:var(--accent)">Total</td>
          <td class="r mono" style="font-weight:700;color:var(--accent)">${fmtQ(c.tq)}</td>
          <td class="r mono" style="color:var(--accent)">—</td>
          <td class="r mono" style="font-weight:700;color:var(--accent)">${fmtNative(tf,p.currency)}</td>
          <td class="r mono" style="font-weight:700;color:var(--accent)">${fmtNative(c.ti,p.currency)}</td>
          <td class="r mono" style="font-weight:700;color:var(--accent)">Avg cost: ${fmtNative(c.wac,p.currency)}</td>
          <td></td></tr>`;
      }
      rows+=`<tr><td colspan="${cols}" style="padding:0;border:none"><div class="sub">
        <div class="sub-header">
          <span class="sub-title">Purchase detail — ${p.name||'(unnamed)'}</span>
          <button class="btn btn-blue btn-sm" onclick="addPurch('${type}',${p.id})">+ Buy</button>
        </div>
        <table class="resp-tbl" style="min-width:500px">${colgroupSub}<thead><tr>
          <th>Date</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Fees</th>
          <th class="r">Total invested</th><th class="r">Lot avg cost</th><th></th>
        </tr></thead><tbody>${sub}</tbody></table>
      </div></td></tr>`;
    }
  });
  const syncBtn=isCto
    ?`<button class="btn btn-green" onclick="syncScope('cto')">🔄 Sync Securities prices</button>`
    :`<button class="btn btn-green" onclick="syncScope('crypto')">🔄 Sync Crypto prices</button>`;
  const hdrs=`<th></th><th>Nom</th>${isCto?'<th>ISIN</th>':''}<th>${isCto?'Yahoo Ticker':'Ticker (id:currency)'}</th>
    ${isCto?'<th>Broker</th><th>Class</th>':''}
    <th>Currency</th>
    <th class="r computed">Qty ←</th><th class="r computed">Avg cost ←</th><th class="r computed">Invested ←</th>
    <th>Live price</th><th class="btn-col"></th><th>Updated</th><th class="r">Valuation</th><th class="r">Chg.</th>
    <th class="r">P&L</th><th class="r">Weight</th><th></th>`;
  return`<div class="card">
    <h3>${isCto?'💼 Securities — Open positions':'🪙 Cryptos — Open positions'}</h3>
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">Invested (${displayCur.toUpperCase()})</div>
        <div class="kpi-value" style="color:var(--accent)">${totI?fmt(totI):'—'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Valuation (${displayCur.toUpperCase()})</div>
        <div class="kpi-value" style="color:var(--accent)">${totV?fmt(totV):'—'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">P&L (${displayCur.toUpperCase()})</div>
        <div class="kpi-value ${gpC(totGP)}">${totI?fmt(totGP):'—'}</div>
      </div>
    </div>
    <div class="toolbar">${syncBtn}
      <button class="btn btn-blue" onclick="addPos('${type}')">+ Add position</button>
    </div>
    <div style="overflow-x:auto;max-width:100%">
      <table class="resp-tbl">${colgroupSpot}<thead><tr>${hdrs}</tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="legend">
      <span style="background:#0a2a15;color:var(--green)">🟢 Today's price</span>
      <span style="background:#2a2a08;color:#eab308">🟡 Stale price (sync needed)</span>
      <span style="background:#2a0f0f;color:var(--red)">🔴 Sync failed</span>
    </div>
  </div>`;
}

// Utilitaires FX
function fxIco(source){
  if(source==='ok'||source==='auto')return '🟢';
  if(source==='manual')return '🟡';
  if(source==='ko')return '🔴';
  return '⚪';
}
function fxBg(source){
  if(source==='ok'||source==='auto')return 'today-cell';
  if(source==='manual')return 'outdated-cell';
  if(source==='ko')return 'error-cell';
  return '';
}
function histoFxIco(source){
  if(source==='frankfurter'||source==='auto')return '🟢';
  if(source==='manual'||source==='today')return '🟡';
  if(source==='ko')return '🔴';
  return '⚪';
}
function histoFxBg(source){
  if(source==='frankfurter'||source==='auto')return 'today-cell';
  if(source==='manual'||source==='today')return 'outdated-cell';
  if(source==='ko')return 'error-cell';
  return '';
}
function calcTradeOptions(t){
  const c=calcTrade(t);
  if(t.fxRateSell==null||t.fxRateBuy==null||c.gp==null)return{tsOpt:null,tbOpt:null,gpOpt:null};
  const tsOpt=c.ts*t.fxRateSell;
  const tbOpt=c.tb*t.fxRateBuy;
  return{tsOpt,tbOpt,gpOpt:tsOpt-tbOpt};
}
async function syncFx(key){
  if(!(DATA[key]||[]).length){toast('⚠️ No price to sync','#7f1d1d');return;}
  fxSyncAttempted[key]=true;
  const scope=key==='ctoTrades'?'cto':'crypto';
  toast('⏳ Syncing FX rates '+scope.toUpperCase()+'…','#1d4ed8');
  try{
    const r=await fetch('/api/syncfx/'+scope);
    const j=await r.json();DATA=j.data;
    const n=j.fx_ok.length,f=j.fx_fail.length;
    const ok=n>0||f===0;
    toast((ok?'✅ ':'⚠ ')+'FX rates: '+n+' OK'+(f?' / '+f+' failed':''),
          ok?'#166534':'#7f1d1d');
    render();
  }catch(e){toast('❌ Network error: '+e.message,'#7f1d1d');}
}

async function syncHistoFx(){
  toast('⏳ Syncing History FX rates…','#1d4ed8');
  try{
    const r=await fetch('/api/syncfx/historique');
    const j=await r.json();DATA=j.data;
    const n=j.fx_ok,f=j.fx_fail;
    const ok=n>0||f===0;
    toast((ok?'✅ ':'⚠ ')+'History FX: '+n+' OK'+(f?' / '+f+' failed':''),ok?'#166534':'#7f1d1d');
    render();
  }catch(e){toast('❌ Network error: '+e.message,'#7f1d1d');}
}
async function manualHistoFx(i){
  const h=DATA.historique[i];if(!h)return;
  const cur=h.currency?h.currency.toUpperCase():'?';
  const optCur=getCur().code.toUpperCase();
  const current=h.fxRate;
  const v=await showPrompt('Rate '+cur+'→'+optCur+(current?' (current: '+current.toFixed(4)+')':'')+':',
    current?current.toFixed(4):'');
  if(v===null)return;
  const p=parseFloat(v.replace(',','.'));
  if(isNaN(p)||p<=0){toast('Invalid rate','#7f1d1d');return;}
  DATA.historique[i]={...h,fxRate:p,fxRateSource:'manual'};
  saveData();render();
}

// E/S
function renderES(type){
  const isCto=type==='cto',key=isCto?'ctoTrades':'cryptoTrades';
  const calcs=DATA[key].map(t=>({...t,c:calcTrade(t)}));
  const opts=calcs.map(t=>calcTradeOptions(t));
  const countFx=opts.filter(o=>o.gpOpt!=null).length;
  const countNoFx=calcs.length-countFx;
  const gpTotal=opts.reduce((s,o)=>s+(o.gpOpt!=null?o.gpOpt:0),0);
  const cur=getCur().code.toUpperCase();
  let rows=calcs.map((t,i)=>{const c=t.c;const o=opts[i];return`<tr>
    <!-- DÉNOMINATION -->
    <td><input value="${t.name||''}" onchange="upTrade('${key}',${t.id},'name',this.value)"></td>
    ${isCto?`<td><input value="${t.isin||''}" onchange="upTrade('${key}',${t.id},'isin',this.value)"></td>`:''}
    <td><input value="${t.ticker||''}" placeholder="${isCto?'ex: CW8.PA':'ex: bitcoin:usd'}"
      onchange="upTradeTicker('${key}',${t.id},this.value)"
      onclick="event.stopPropagation()"></td>
    <td>${t.currency?t.currency.toUpperCase():'—'}</td>
    <!-- ACHAT -->
    <td style="border-left:2px solid var(--accent)">
      <input type="date" value="${t.buyDate||''}" onchange="upTrade('${key}',${t.id},'buyDate',this.value)">
    </td>
    <td class="r"><input type="number" step="any" value="${t.priceBuy||''}" onchange="upTrade('${key}',${t.id},'priceBuy',this.value)"></td>
    <td class="r"><input type="number" step="any" value="${t.feesBuy||''}" onchange="upTrade('${key}',${t.id},'feesBuy',this.value)"></td>
    <td class="${fxBg(t.fxRateBuySource)}" style="font-size:12px">
      ${fxIco(t.fxRateBuySource)} ${t.fxRateBuy!=null?t.fxRateBuy.toFixed(4):'—'}
    </td>
    <td class="btn-col">
      <button onclick="event.stopPropagation();manualFx('${key}',${t.id},'buy')" style="background:none;border:none;cursor:pointer;padding:2px"><span style="display:inline-block;transform:scaleX(-1)">✏️</span></button>
    </td>
    <!-- VENTE -->
    <td style="border-left:2px solid var(--accent)">
      <input type="date" value="${t.sellDate||''}" onchange="upTrade('${key}',${t.id},'sellDate',this.value)">
    </td>
    <td class="r"><input type="number" step="any" value="${t.qSold||''}" onchange="upTrade('${key}',${t.id},'qSold',this.value)"></td>
    <td class="r"><input type="number" step="any" value="${t.priceSell||''}" onchange="upTrade('${key}',${t.id},'priceSell',this.value)"></td>
    <td class="r"><input type="number" step="any" value="${t.feesSell||''}" onchange="upTrade('${key}',${t.id},'feesSell',this.value)"></td>
    <td class="${fxBg(t.fxRateSellSource)}" style="font-size:12px">
      ${fxIco(t.fxRateSellSource)} ${t.fxRateSell!=null?t.fxRateSell.toFixed(4):'—'}
    </td>
    <td class="btn-col">
      <button onclick="event.stopPropagation();manualFx('${key}',${t.id},'sell')" style="background:none;border:none;cursor:pointer;padding:2px"><span style="display:inline-block;transform:scaleX(-1)">✏️</span></button>
    </td>
    <!-- TOTAL -->
    <td class="r mono" style="border-left:2px solid var(--accent)">${fmt(o.tbOpt)}</td>
    <td class="r mono">${fmt(o.tsOpt)}</td>
    <td class="r mono ${o.gpOpt!=null?gpC(o.gpOpt):''}">${o.gpOpt!=null?fmt(o.gpOpt):'—'}</td>
    <td class="r mono ${c.pct!=null?gpC(c.pct):''}">${fmtP(c.pct)}</td>
    <!-- ACTIONS -->
    <td><button class="btn btn-red btn-sm" onclick="delTrade('${key}',${t.id})">🗑</button></td>
  </tr>`}).join('');
  const colgroup=`<colgroup>${(isCto?[5,5,5,3,9,5,4,6,3,9,4,5,4,6,3,7,6,5,3,3]:[7,6,3,9,4,4,6,3,9,4,4,4,6,3,8,7,7,3,3]).map(w=>`<col style="width:${w}%">`).join('')}</colgroup>`;
  return`<div class="card">
    <h3>${isCto?'📋 Securities Sales':'📋 Crypto Sales'}</h3>
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">Realized P&L</div>
        <div class="kpi-value ${gpC(gpTotal)}">${fmt(gpTotal)}</div>
        ${fxSyncAttempted[key]&&countNoFx>0?`<div style="color:var(--text2);font-size:11px">(${countNoFx} trade${countNoFx>1?'s':''} without FX rate excluded)</div>`:''}
      </div>
      ${fxSyncAttempted[key]&&countNoFx>0?`<div class="kpi" style="border-color:#92400e">
        <div class="kpi-label" style="color:#f59e0b">⚠️ No FX rate</div>
        <div class="kpi-value" style="color:#f59e0b;font-size:14px">${countNoFx} row${countNoFx>1?'s':''}</div>
      </div>`:''}
    </div>
    <div class="toolbar">
      <button class="btn btn-blue" onclick="addTrade('${key}')">+ Add sale</button>
      <button class="btn" onclick="syncFx('${key}')">🔄 Sync FX rates</button>
    </div>
    <div style="overflow-x:auto;max-width:100%"><table class="resp-tbl">${colgroup}<thead>
    <tr>
      <th colspan="${isCto?4:3}" style="text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text2);font-weight:600;padding:3px 6px">Identification</th>
      <th colspan="5" style="text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text2);font-weight:600;padding:3px 6px;border-left:2px solid var(--accent)">Buy</th>
      <th colspan="6" style="text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text2);font-weight:600;padding:3px 6px;border-left:2px solid var(--accent)">Sell</th>
      <th colspan="4" style="text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text2);font-weight:600;padding:3px 6px;border-left:2px solid var(--accent)">Total</th>
      <th></th>
    </tr>
    <tr>
      <th>Name</th>
      ${isCto?'<th>ISIN</th>':''}
      <th>Ticker</th>
      <th>Currency</th>
      <th style="border-left:2px solid var(--accent)">Buy date</th>
      <th class="r">Unit price</th>
      <th class="r">Fees B</th>
      <th>FX B</th>
      <th class="btn-col"></th>
      <th style="border-left:2px solid var(--accent)">Sell date</th>
      <th class="r">Qty</th>
      <th class="r">Unit price</th>
      <th class="r">Fees S</th>
      <th>FX S</th>
      <th class="btn-col"></th>
      <th class="r" style="border-left:2px solid var(--accent)">Total B (${cur})</th>
      <th class="r">Total S (${cur})</th>
      <th class="r">P&L (${cur})</th>
      <th class="r">P&L %</th>
      <th></th>
    </tr>
    </thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

// Historique
function renderHisto(){
  const currentYear=new Date().getFullYear();
  const colgroupHisto=makeColgroup([5,5,14,3,10,10,10,3]);
  const displayHist=DATA.historique.map((h,i)=>({h,i})).sort((a,b)=>histoSortAsc?a.h.year-b.h.year:b.h.year-a.h.year);
  let rows=displayHist.map(({h,i})=>`<tr>
    <td class="mono"><input type="number" step="any" value="${h.year||''}" onchange="upHisto(${i},'year',this.value)"></td>
    <td><select onchange="upHisto(${i},'currency',this.value)">
      ${['eur','usd','chf','gbp','jpy','hkd','cny'].map(c=>`<option value="${c}"${(h.currency||'eur')===c?' selected':''}>${c.toUpperCase()}</option>`).join('')}
    </select></td>
    <td class="${histoFxBg(h.fxRateSource)}" style="font-size:12px">
      ${histoFxIco(h.fxRateSource)} ${h.fxRate!=null?h.fxRate.toFixed(4):'—'}
      ${h.year===currentYear?`<br><span style="font-size:9px;color:#f59e0b">⚠️ Dec 31 not yet available — using today's rate</span>`:''}
    </td>
    <td class="btn-col">
      <button onclick="manualHistoFx(${i})" style="background:none;border:none;cursor:pointer;padding:2px"><span style="display:inline-block;transform:scaleX(-1)">✏️</span></button>
    </td>
    <td class="r mono"><input type="number" step="any" value="${h.securities!=null?h.securities:''}" onchange="upHisto(${i},'securities',this.value)"></td>
    <td class="r mono"><input type="number" step="any" value="${h.crypto||''}" onchange="upHisto(${i},'crypto',this.value)"></td>
    <td class="r mono" style="color:var(--text2)">${fmtNative((h.securities||0)+(h.crypto||0),h.currency||'eur')}</td>
    <td><button class="btn btn-red btn-sm" onclick="delHisto(${i})">🗑</button></td>
  </tr>`).join('');
  return`<div class="card"><h3>📅 Annual history (Dec 31)</h3>
    <div class="toolbar">
      <button class="btn btn-blue" onclick="addHisto()">+ Add year</button>
      <button class="btn" onclick="syncHistoFx()">🔄 Sync FX rates</button>
    </div>
    <div style="overflow-x:auto;max-width:100%"><table class="resp-tbl">${colgroupHisto}<thead><tr>
      <th><button class="btn btn-ghost btn-sm" onclick="histoToggleSort()" style="padding:2px 4px">${histoSortAsc?'↑':'↓'}</button> Year</th><th>Currency</th><th>FX</th><th class="btn-col"></th>
      <th class="r">Securities</th><th class="r">Cryptos</th><th class="r">Total</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}
function histoToggleSort(){histoSortAsc=!histoSortAsc;render();}

// Actions utilisateur
function upPos(type,id,f,v){DATA[type]=DATA[type].map(p=>p.id===id?{...p,[f]:v}:p);saveData();render();}
function upCtoTicker(id,newTicker){
  const t=newTicker.trim();
  const old=(DATA.cto.find(p=>p.id===id)||{}).ticker||'';
  if(t===old)return;
  if(!t){
    DATA.cto=DATA.cto.map(p=>p.id===id?{...p,ticker:'',currency:null,livePrice:null,priceSource:'none',priceDate:null}:p);
    saveData();render();return;
  }
  const currency=getCurrencyFromTicker(t);
  if(currency===null){
    toast('❌ Ticker rejected: unrecognized suffix. Accepted suffixes: none (USD), .PA .AS .DE .F .MI .BR .LS .MC (EUR), .SW .VX (CHF), .L (GBP), .T (JPY), .HK (HKD), .SS .SZ (CNY)','#7f1d1d');
    render();return;
  }
  DATA.cto=DATA.cto.map(p=>p.id===id?{...p,ticker:t,currency,livePrice:null,priceSource:'none',priceDate:null}:p);
  saveData();render();
}
function upCryptoTicker(id,newTicker){
  const t=newTicker.trim();
  const old=(DATA.crypto.find(p=>p.id===id)||{}).ticker||'';
  if(t===old)return;
  if(!t){
    DATA.crypto=DATA.crypto.map(p=>p.id===id?{...p,ticker:'',currency:null,livePrice:null,priceSource:'none',priceDate:null}:p);
    saveData();render();return;
  }
  const result=parseCryptoTicker(t);
  if(!result){
    toast('❌ Crypto ticker rejected. Expected format: id:currency (e.g. bitcoin:usd). Accepted currencies: eur, usd, chf, gbp, jpy, hkd, cny.','#7f1d1d');
    render();return;
  }
  DATA.crypto=DATA.crypto.map(p=>p.id===id?{...p,ticker:t,currency:result.currency,livePrice:null,priceSource:'none',priceDate:null}:p);
  saveData();render();
}
async function manualFx(key,id,flow){
  const trade=(DATA[key]||[]).find(x=>x.id===id);if(!trade)return;
  const rateField =flow==='buy'?'fxRateBuy':'fxRateSell';
  const sourceField=rateField+'Source';
  const cur=trade.currency?trade.currency.toUpperCase():'?';
  const optCur=getCur().code.toUpperCase();
  const current=trade[rateField];
  const v=await showPrompt(
    'Rate '+cur+'→'+optCur+(current?' (current: '+current.toFixed(4)+')':'')+':',
    current?current.toFixed(4):''
  );
  if(v===null)return;
  const p=parseFloat(v.replace(',','.'));
  if(isNaN(p)||p<=0){toast('Invalid rate','#7f1d1d');return;}
  DATA[key]=DATA[key].map(x=>x.id===id?{...x,[rateField]:p,[sourceField]:'manual'}:x);
  saveData();render();
}
async function manualPrice(type,id){
  const pos=(DATA[type]||[]).find(x=>x.id===id);
  const cur=pos&&pos.currency?pos.currency.toUpperCase():'?';
  const v=await showPrompt('Price in '+cur+':');if(!v)return;
  const p=parseFloat(v.replace(',','.'));if(isNaN(p)||p<=0){toast('Invalid price','#7f1d1d');return;}
  const now=isoNow();
  DATA[type]=DATA[type].map(x=>x.id===id?{...x,livePrice:p,priceSource:'manual',priceDate:now}:x);
  saveData();render();
}
function addPos(type){
  DATA[type].push(type==='cto'
    ?{id:nextId(DATA[type]),name:'',isin:'',ticker:'',broker:(DATA.settings.brokers||[])[0]||'',classe:(DATA.settings.classes||[])[0]||'',
      currency:null,purchases:[],livePrice:null,priceSource:'none',priceDate:null}
    :{id:nextId(DATA[type]),name:'',ticker:'',
      currency:null,purchases:[],livePrice:null,priceSource:'none',priceDate:null});
  saveData();render();
}
async function delPos(type,id){if(!(await showConfirm('Delete?')))return;DATA[type]=DATA[type].filter(p=>p.id!==id);saveData();render();}
function addPurch(type,pid){
  DATA[type]=DATA[type].map(p=>p.id===pid?{...p,purchases:[...p.purchases,{date:'',qty:0,price:0,fees:0}]}:p);
  saveData();render();
}
function upPurch(type,pid,i,f,v){
  DATA[type]=DATA[type].map(p=>{
    if(p.id!==pid)return p;
    const ps=[...p.purchases];ps[i]={...ps[i],[f]:f==='date'?v:(parseFloat(v)||0)};
    return{...p,purchases:ps};
  });saveData();render();
}
function delPurch(type,pid,i){
  DATA[type]=DATA[type].map(p=>p.id===pid?{...p,purchases:p.purchases.filter((_,j)=>j!==i)}:p);
  saveData();render();
}
function addTrade(key){
  DATA[key].push({id:nextId(DATA[key]),sellDate:'',name:'',isin:'',
    qSold:0,priceSell:0,feesSell:0,buyDate:'',priceBuy:0,feesBuy:0,
    ticker:'',currency:null,
    fxRateBuy:null,fxRateBuySource:null,
    fxRateSell:null,fxRateSellSource:null});
  saveData();render();
}
function upTrade(key,id,f,v){
  const isN=!['sellDate','buyDate','name','isin','currency'].includes(f);
  DATA[key]=DATA[key].map(t=>{
    if(t.id!==id)return t;
    const updated={...t,[f]:isN?(parseFloat(v)||0):v};
    if(f==='buyDate' ) invalidateFxSource(updated,'fxRateBuySource');
    if(f==='sellDate') invalidateFxSource(updated,'fxRateSellSource');
    return updated;
  });
  saveData();render();
}
function upTradeTicker(key,id,newTicker){
  const t=newTicker.trim();
  const old=(DATA[key].find(x=>x.id===id)||{}).ticker||'';
  if(t===old)return;
  if(!t){
    DATA[key]=DATA[key].map(x=>x.id===id?{...x,ticker:'',currency:null}:x);
    saveData();render();return;
  }
  const isCto=key==='ctoTrades';
  let currency;
  if(isCto){
    currency=getCurrencyFromTicker(t);
  }else{
    const result=parseCryptoTicker(t);
    currency=result?.currency;
  }
  if(currency==null){
    if(isCto){
      toast('❌ Ticker rejected: unrecognized suffix. Accepted suffixes: none (USD), .PA .AS .DE .F .MI .BR .LS .MC (EUR), .SW .VX (CHF), .L (GBP), .T (JPY), .HK (HKD), .SS .SZ (CNY)','#7f1d1d');
    }else{
      toast('❌ Crypto ticker rejected. Expected format: id:currency (e.g. bitcoin:usd). Accepted currencies: eur, usd, chf, gbp, jpy, hkd, cny.','#7f1d1d');
    }
    render();return;
  }
  const oldCurrency=(DATA[key].find(x=>x.id===id)||{}).currency;
  const optionsCur=DATA.settings?.currency||'eur';
  DATA[key]=DATA[key].map(x=>{
    if(x.id!==id)return x;
    const updates={...x,ticker:t,currency};
    if(currency!==oldCurrency){
      if(currency===optionsCur){
        invalidateFxSource(updates,'fxRateBuySource' ,'auto'); if(updates.fxRateBuySource ==='auto') updates.fxRateBuy =1;
        invalidateFxSource(updates,'fxRateSellSource','auto'); if(updates.fxRateSellSource==='auto') updates.fxRateSell=1;
      }else{
        invalidateFxSource(updates,'fxRateBuySource');
        invalidateFxSource(updates,'fxRateSellSource');
      }
    }
    return updates;
  });
  saveData();render();
}
async function delTrade(key,id){if(!(await showConfirm('Delete?')))return;DATA[key]=DATA[key].filter(t=>t.id!==id);saveData();render();}
function addHisto(){
  const y=DATA.historique.length?Math.max(...DATA.historique.map(h=>h.year))+1:new Date().getFullYear();
  DATA.historique.push({year:y,securities:0,crypto:0,total:0,currency:getCur().code,fxRate:null,fxRateSource:null});
  saveData();render();
}
function upHisto(i,f,v){
  const h=DATA.historique[i];
  if(f==='currency'){h.currency=v;invalidateFxSource(h,'fxRateSource');}
  else if(f==='year'){h.year=parseInt(v)||0;invalidateFxSource(h,'fxRateSource');}
  else if(f==='crypto'){h.crypto=parseFloat(v)||0;}
  else if(f==='securities'){h.securities=parseFloat(v)||0;}
  h.total=(h.securities||0)+(h.crypto||0);
  saveData();render();
}
async function delHisto(i){if(!(await showConfirm('Delete?')))return;DATA.historique.splice(i,1);saveData();render();}
function exportZIP(){
  const a=document.createElement('a');
  a.href='/api/export';
  a.download='';  // nom imposé par Content-Disposition côté serveur
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

loadData();
