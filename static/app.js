// Centralise la politique d'invalidation des taux FX.
// Règle : tout déclencheur d'invalidation DOIT passer par cette fonction
// — ne jamais écrire le pattern inline.
// Les taux 'manual' sont écrasés comme les autres : un taux manuel encode
// natif → ancienne devise Options et devient incorrect après un changement
// de devise — l'invalider protège l'utilisateur d'un calcul silencieusement faux.
// Miroir Python : handle_syncfx dans portfolio_tracker.py.
function invalidateFxSource(obj, sourceField, value='ko'){
  obj[sourceField]=value;
}
// resolveFx(nativeCur) — court-circuit local : devise native = devise Options → taux trivialement 1,
// pas de pastille blanche ni de sync nécessaire. Miroir du court-circuit backend
// (fetch_fx_rate_at, BASE==TARGET → {rate:1.0, source:'auto'}).
function resolveFx(nativeCur){
  return(nativeCur&&nativeCur===DATA.settings.currency)?{rate:1,source:'auto'}:{rate:null,source:null};
}
// parseCryptoTicker — source de vérité partagée avec portfolio_tracker.py (parse_crypto_ticker)
// Toute modification des devises acceptées ou de la logique de parsing
// doit être répercutée manuellement dans les deux fichiers.
let DATA=null,currentTab='dashboard',expanded={},pendingSettings=null,saveErrorMsg=null;
let optNewBroker='',optNewBrokerErr=null,optNewClass='',optNewClassErr=null;
let optShowNewBroker=false,optShowNewClass=false;
let histoSortAsc=true;
let lotSortAsc=true;   // [v3.0] direction du tri d'affichage des lots (non persisté, affichage seul)
let saleSortAsc=true;  // [v3.0] direction du tri d'affichage des cessions par sellDate (non persisté)
let dashChartFilter='10Y';
const fxSyncAttempted={ctoTrades:false,cryptoTrades:false};
const TABS=[
  {id:'dashboard',label:'📊 Dashboard'},
  {id:'cto',label:'💼 Securities'},
  {id:'ctoES',label:'📋 Securities Sales'},
  {id:'crypto',label:'🪙 Cryptos'},
  {id:'cryptoES',label:'📋 Cryptos Sales'},
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
  // Migration 8 (v2.0) : lots d'achat sans fxRateSource → non résolus (fxRate/fxRateSource null).
  ['cto','crypto'].forEach(k=>{
    (DATA[k]||[]).forEach(p=>{
      (p.purchases||[]).forEach(lot=>{
        if(!('fxRateSource' in lot)){lot.fxRate=null;lot.fxRateSource=null;migrated=true;}
      });
    });
  });
  // Migration 9 (v2.0→v3.0) : cessions v1.1 → posId ajouté (null si non lié) + suppression du
  // volet achat obsolète. [v3.0] Le coût de base n'est plus figé : wacBaseAtSale/wacBaseCurrency
  // sont supprimés partout — le coût de base est lu dynamiquement via wacBaseAt(pos, sellDate).
  ['ctoTrades','cryptoTrades'].forEach(k=>{
    (DATA[k]||[]).forEach(t=>{
      if(!('posId' in t)){
        t.posId=null;
        delete t.buyDate;delete t.priceBuy;delete t.feesBuy;delete t.fxRateBuy;delete t.fxRateBuySource;
        migrated=true;
      }
      if('wacBaseAtSale' in t||'wacBaseCurrency' in t){
        delete t.wacBaseAtSale;delete t.wacBaseCurrency;migrated=true;
      }
    });
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

// ---- Modale multi-champs générique (fondation des popups posDialog/lotDialog, v3.0) ----
// Premier mécanisme de popup multi-champs du projet (au-delà de showPrompt/showConfirm à
// champ unique). Réutilisable : Sales (B4) et History (B5) s'y appuieront (saleDialog/histoDialog).
//   showForm({title, fields:[{key,label,type,value,options?,placeholder?}], validate})
//     type ∈ 'text' | 'date' | 'number' | 'select' (options=[{value,label}] pour select)
//            | 'static' (affichage lecture seule, ignoré à la collecte — identité figée)
//     validate(values) → chaîne d'erreur (Valider bloqué, popup maintenue) ou null (résolu)
//   Résout avec l'objet {key:value} à la validation, ou null à l'annulation.
// N'écrit rien : l'appelant écrit en données à partir de la valeur résolue.
let _formCfg=null,_formResolve=null;
function showForm(cfg){
  return new Promise(resolve=>{
    _formResolve=resolve;_formCfg=cfg;
    const fieldsHtml=cfg.fields.map(f=>{
      const id='form-f-'+f.key;
      let control;
      if(f.type==='static'){
        // Champ d'affichage en lecture seule (identité figée) — pas d'input, ignoré à la collecte.
        return `<div class="form-row"><label>${esc(f.label)}</label><div style="padding:6px 8px;font-size:13px;color:var(--text2)">${esc(f.value)}</div></div>`;
      }else if(f.type==='select'){
        control=`<select id="${id}">${(f.options||[]).map(o=>`<option value="${esc(o.value)}"${o.value===f.value?' selected':''}>${esc(o.label)}</option>`).join('')}</select>`;
      }else{
        const t=f.type||'text';
        control=`<input id="${id}" type="${t}"${t==='number'?' step="any"':''}${f.maxlength?` maxlength="${f.maxlength}"`:''} value="${esc(f.value)}" placeholder="${esc(f.placeholder||'')}">`;
      }
      return `<div class="form-row"><label for="${id}">${esc(f.label)}</label>${control}</div>`;
    }).join('');
    const html=`<div id="form-overlay" class="form-overlay" onclick="if(event.target===this)_formCancel()">
      <div class="form-box">
        <h3>${esc(cfg.title)}</h3>
        ${fieldsHtml}
        <p id="form-error" class="form-error" style="display:none"></p>
        <div class="form-btns">
          <button class="btn btn-ghost" onclick="_formCancel()">Cancel</button>
          <button class="btn btn-blue" onclick="_formSubmit()">Validate</button>
        </div>
      </div></div>`;
    document.body.insertAdjacentHTML('beforeend',html);
    document.addEventListener('keydown',_formKeydown,true);
    setTimeout(()=>{const first=document.querySelector('#form-overlay input,#form-overlay select');if(first)first.focus();},30);
  });
}
function _formKeydown(e){
  if(!document.getElementById('form-overlay'))return;
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();_formCancel();}
  else if(e.key==='Enter'&&e.target.tagName!=='SELECT'){e.preventDefault();e.stopPropagation();_formSubmit();}
}
function _formClose(result){
  const ov=document.getElementById('form-overlay');
  if(ov)ov.remove();
  document.removeEventListener('keydown',_formKeydown,true);
  const r=_formResolve;_formResolve=null;_formCfg=null;
  if(r)r(result);
}
function _formSubmit(){
  if(!_formCfg)return;
  const values={};
  _formCfg.fields.forEach(f=>{const el=document.getElementById('form-f-'+f.key);values[f.key]=el?el.value:'';});
  const err=_formCfg.validate?_formCfg.validate(values):null;
  if(err){const e=document.getElementById('form-error');e.textContent=err;e.style.display='block';return;}
  _formClose(values);
}
function _formCancel(){_formClose(null);}

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
// isValidCtoTicker — validation syntaxique d'un ticker Yahoo Finance (CTO)
// La devise n'est plus déduite du ticker : elle vient de fast_info.currency (sync)
// ou du dropdown (CTO Sales). Cette fonction ne fait QUE valider le suffixe.
//   'AAPL'      → true   (pas de point → US)
//   'CW8.PA'    → true
//   'NESN.SW'   → true
//   'SHEL.L'    → true
//   '7203.T'    → true
//   '0700.HK'   → true
//   '600519.SS' → true
//   'AAPL.XX'   → false  (suffixe non géré)
//   ''          → false
//   null        → false
function isValidCtoTicker(ticker){
  if(ticker==null||typeof ticker!=='string')return false;
  const t=ticker.trim();
  if(!t)return false;
  const dot=t.lastIndexOf('.');
  if(dot===-1)return true;
  const suffix=t.slice(dot+1).toUpperCase();
  const KNOWN_SUFFIXES=['PA','AS','DE','F','MI','BR','LS','MC','SW','VX','L','T','HK','SS','SZ'];
  return KNOWN_SUFFIXES.includes(suffix);
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
// Échappement HTML pour les valeurs injectées dans les popups (attributs value / contenu).
const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// calcPos(p, trades) — v3.0, partagée intégralement entre Securities (cto[]) et Cryptos (crypto[]).
// `trades` = cessions du bloc Sales (ctoTrades ou cryptoTrades) ; filtrées par posId
// pour dériver la quantité réellement détenue (remaining) ET le solde glissant temporel.
// Voir spec Securities v3.0 §4.5 / §4.5bis.
//   - wacBaseAt(T) : accesseur DATÉ (lots date ≤ T), recalculé à chaque appel — jamais figé.
//   - wacBase      : résumé de la position (tous lots) — tout-ou-rien non restreint.
//   - soldeMin     : minimum du solde cumulé sur la chronologie (achats + / ventes −),
//                    distinct de remaining (solde final). soldeMin < 0 ⇒ brèche temporelle.
function calcPos(p,trades=[]){
  const purchases=p.purchases||[];
  const tq=purchases.reduce((s,x)=>s+(x.qty||0),0);
  const ti=purchases.reduce((s,x)=>s+((x.qty||0)*(x.price||0)+(x.fees||0)),0);
  // Le test de résolution FX porte UNIQUEMENT sur fxRateSource
  // (jamais sur fxRate!=null : un fxRate périmé reste non-null après invalidation).
  const fxResolved=s=>s==='ok'||s==='auto'||s==='manual';
  const wac=tq?ti/tq:0;                              // coût moyen natif — invariant aux ventes (ti/tq, jamais ti/remaining)

  // Accesseur DATÉ (v3.0) : coût moyen pondéré des seuls lots date ≤ T, en devise de reporting.
  // Règle FX tout-ou-rien DATE-RESTREINTE : ne teste que les lots ≤ T. Un lot postérieur non
  // résolu ne bloque jamais wacBaseAt(T). Filtrage par date, jamais un gel/instantané :
  // un lot antérieur ajouté après coup corrige le résultat au prochain rendu.
  function wacBaseAt(T){
    if(T==null)return null;
    let tqUpTo=0,tiBaseUpTo=0,allResolved=true;
    for(const x of purchases){
      if(!x.date||x.date>T)continue;
      tqUpTo+=(x.qty||0);
      if(!fxResolved(x.fxRateSource))allResolved=false;
      tiBaseUpTo+=((x.qty||0)*(x.price||0)+(x.fees||0))*(x.fxRate||0);
    }
    if(tqUpTo<=0||!allResolved)return null;
    return tiBaseUpTo/tqUpTo;
  }

  // Résumé de la position (carte) : wacBase sur TOUS les lots (règle tout-ou-rien non restreinte).
  const allFxResolved=purchases.every(x=>fxResolved(x.fxRateSource));   // vacuément vrai si aucun lot, mais wacBase reste null car tq=0
  const wacBase=(tq>0&&allFxResolved)
    ?purchases.reduce((s,x)=>s+((x.qty||0)*(x.price||0)+(x.fees||0))*(x.fxRate||0),0)/tq
    :null;

  const linked=(trades||[]).filter(t=>t.posId===p.id);
  const soldQty=linked.reduce((s,t)=>s+(t.qSold||0),0);
  const remaining=tq-soldQty;                        // solde FINAL

  // Solde glissant temporel (§4.5bis) : achats (+) et ventes (−) ordonnés par date croissante,
  // achats avant ventes à date égale (on peut vendre ce qu'on a acheté le jour même).
  const events=[];
  purchases.forEach(x=>{if(x.date)events.push({date:x.date,amount:(x.qty||0)});});
  linked.forEach(t=>{if(t.sellDate)events.push({date:t.sellDate,amount:-(t.qSold||0)});});
  events.sort((a,b)=>{
    if(a.date<b.date)return -1;
    if(a.date>b.date)return 1;
    return (a.amount>0?0:1)-(b.amount>0?0:1);        // départage à date égale : achats (+) avant ventes (−)
  });
  let solde=0,soldeMin=0,breachDate=null;
  for(const e of events){
    solde+=e.amount;
    if(solde<soldeMin)soldeMin=solde;
    if(solde<0&&breachDate==null)breachDate=e.date;  // première date où le solde devient négatif
  }

  // Dès soldeMin < 0 (brèche locale) OU remaining < 0 : aucun calcul sur quantité négative.
  const unavail=remaining<0||soldeMin<0;
  // investedRemaining : DÉJÀ en devise de reporting (dérive de wacBase). Ne jamais ré-envelopper dans convert().
  const investedRemaining=(wacBase!=null&&!unavail)?remaining*wacBase:null;
  const valo=unavail?null:(p.livePrice?remaining*p.livePrice:0);   // en devise NATIVE
  const valoBase=(valo!=null&&p.currency)?convert(valo,p.currency,getCur().code):null;
  const gp=(valoBase!=null&&investedRemaining!=null)?valoBase-investedRemaining:null;
  const evol=(gp!=null&&investedRemaining>0)?gp/investedRemaining:null;
  return{tq,ti,wac,wacBase,wacBaseAt,soldQty,remaining,soldeMin,breachDate,investedRemaining,valo,gp,evol};
}
// [v3.0] Coût de base DATÉ d'une cession — délègue à calcPos(pos).wacBaseAt(date).
// pos peut être null (position orpheline) → null. Ne dépend que des lots d'achat, jamais des
// cessions (d'où trades=[]) : recalculé à chaque rendu, jamais figé sur la cession.
function wacBaseAt(pos,date){
  if(!pos)return null;
  return calcPos(pos,[]).wacBaseAt(date);
}
// [v3.0] Cession : plus aucun coût de base figé. ts = qSold×priceSell − feesSell (natif).
// Le tb natif disparaît : le coût de base vient déjà en devise de reporting via wacBaseAt (calcTradeOptions).
function calcTrade(t){
  const ts=(t.qSold>0&&t.priceSell>0)?(t.qSold||0)*(t.priceSell||0)-(t.feesSell||0):0;
  return{ts};
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
const PIE_SMALL_PCT=0.02;
// Groupe les tranches < 2% (>=2 -> "Others (N)") ou garantit un angle mini de 3° (1 seule)
function groupPieSlices(f,vk,lk,tot){
  const items=f.map(x=>({label:x[lk],value:x[vk],pct:x[vk]/tot}));
  const small=items.filter(x=>x.pct<PIE_SMALL_PCT);
  if(small.length>=2){
    const big=items.filter(x=>x.pct>=PIE_SMALL_PCT);
    const othersValue=small.reduce((s,x)=>s+x.value,0);
    big.push({label:`Others (${small.length})`,value:othersValue,pct:othersValue/tot});
    return big.map(x=>({...x,angle:x.pct*360}));
  }
  if(small.length===1){
    const angleSmall=Math.max(small[0].pct*360,3);
    const scale=(360-angleSmall)/(360-small[0].pct*360);
    return items.map(x=>x===small[0]?{...x,angle:angleSmall}:{...x,angle:x.pct*360*scale});
  }
  return items.map(x=>({...x,angle:x.pct*360}));
}
function makePie(items,vk,lk,title){
  const f=items.filter(x=>x[vk]>0);
  if(!f.length) return `<div class="card" style="flex:1 1 340px"><h3>${title}</h3>
    <p style="color:var(--text2);font-size:12px">No data</p></div>`;
  const tot=f.reduce((s,x)=>s+x[vk],0); let cum=0;
  const r=66,cx=84,cy=84;
  const sl=groupPieSlices(f,vk,lk,tot);
  const slices=sl.length===1
    ?`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLORS[0]}" stroke="var(--bg)" stroke-width="2"/>
      <text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="9" fill="#fff">100%</text>`
    :sl.map((x,i)=>{
      const a1=cum*Math.PI/180;cum+=x.angle;const a2=cum*Math.PI/180;
      const x1=cx+r*Math.sin(a1),y1=cy-r*Math.cos(a1);
      const x2=cx+r*Math.sin(a2),y2=cy-r*Math.cos(a2);
      const mid=(cum-x.angle/2)*Math.PI/180;
      const tx=(cx+43*Math.sin(mid)).toFixed(0),ty=(cy-43*Math.cos(mid)+4).toFixed(0);
      return`<path d="M${cx},${cy}L${x1.toFixed(1)},${y1.toFixed(1)}A${r},${r} 0 ${x.angle>180?1:0},1 ${x2.toFixed(1)},${y2.toFixed(1)}Z"
        fill="${COLORS[i%8]}" stroke="var(--bg)" stroke-width="2"/>
        ${x.pct>.06?`<text x="${tx}" y="${ty}" text-anchor="middle" font-size="9" fill="#fff">${Math.round(x.pct*100)}%</text>`:''}`;
    }).join('');
  const leg=sl.map((x,i)=>`<div style="display:flex;align-items:center;gap:5px;margin:2px 0">
    <span style="width:9px;height:9px;border-radius:2px;background:${COLORS[i%8]};flex-shrink:0;display:inline-block"></span>
    <span style="font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x.label}</span>
    <span style="font-size:12px;color:var(--text2);font-family:monospace">${fmt(x.value)}</span>
  </div>`).join('');
  return`<div class="card" style="flex:1 1 340px"><h3>${title}</h3>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <svg viewBox="0 0 168 168" width="260" height="260">${slices}</svg>
      <div style="flex:1;min-width:100px">${leg}</div>
    </div></div>`;
}

// Line chart
function convertHistoRow(h,amount){
  if(h.fxRate==null||h.fxRateSource==='ko')return null;
  return amount*h.fxRate;
}
function niceMax(val){
  const mag=Math.pow(10,Math.floor(Math.log10(val)));
  for(const m of [1,2,2.5,5,10]){if(m*mag>=val)return m*mag;}
}
function chartTipShow(evt,year,val){
  const t=document.getElementById('chart-tooltip');
  t.textContent=year+' — '+val;
  t.style.display='block';
  chartTipMove(evt);
}
function chartTipMove(evt){
  const t=document.getElementById('chart-tooltip');
  const x=evt.clientX,y=evt.clientY;
  const tw=t.offsetWidth,th=t.offsetHeight;
  t.style.left=(x+12+tw>window.innerWidth?x-tw-12:x+12)+'px';
  t.style.top=(y-th-8)+'px';
}
function chartTipHide(){
  document.getElementById('chart-tooltip').style.display='none';
}

function lineChart(hist){
  const displayCur=getCur().code;
  const curSym={eur:'€',usd:'$',chf:'CHF',gbp:'£',jpy:'¥',hkd:'HK$',cny:'CN¥'}[displayCur]||'€';
  const pts=(hist||DATA.historique).map(h=>({year:h.year,total:convertHistoRow(h,h.total)})).filter(h=>h.total!=null&&h.total>0);
  if(pts.length<2) return '<p style="color:var(--text2);font-size:12px;padding:8px 0">At least 2 years of data required.</p>';
  const W=900,H=175,PL=60,PR=20,PT=22,PB=30;
  const xs=pts.map((_,i)=>PL+i*(W-PL-PR)/(pts.length-1));
  const vs=pts.map(p=>p.total);
  const dataMax=Math.max(...vs),dataMin=Math.min(...vs);
  const yMax=niceMax(dataMax);
  const ys=vs.map(v=>PT+(H-PT-PB)*(1-v/yMax));
  const pD=xs.map((x,i)=>(i?'L':'M')+x.toFixed(1)+','+ys[i].toFixed(1)).join(' ');
  const fD=pD+` L${xs[xs.length-1].toFixed(1)},${H-PB} L${xs[0].toFixed(1)},${H-PB} Z`;
  const ticks=[0,.25,.5,.75,1].map(t=>Math.round(yMax*t));
  const grid=ticks.map(v=>{
    const y=(PT+(H-PT-PB)*(1-v/yMax)).toFixed(1);
    return`<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>
      <text x="${PL-6}" y="${(+y+4).toFixed(0)}" text-anchor="end" font-size="9" fill="var(--text2)">${v.toLocaleString('en-US')} ${curSym}</text>`;
  }).join('');
  const maxI=vs.indexOf(dataMax),minI=vs.indexOf(dataMin);
  const labelIdx=new Set([0,pts.length-1,maxI,minI]);
  const fmtVal=v=>Math.round(v).toLocaleString('en-US')+' '+curSym;
  const dots=xs.map((x,i)=>
    `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--bg)" stroke-width="2" onmouseover="chartTipShow(event,${pts[i].year},'${fmtVal(pts[i].total)}')" onmousemove="chartTipMove(event)" onmouseout="chartTipHide()"/>
     <text x="${x.toFixed(1)}" y="${H-PB+13}" text-anchor="middle" font-size="9" fill="var(--text2)">${pts[i].year}</text>
     ${labelIdx.has(i)?`<text x="${x.toFixed(1)}" y="${(ys[i]-9).toFixed(1)}" text-anchor="middle" font-size="8" fill="var(--accent)" font-weight="600">${fmtVal(pts[i].total)}</text>`:''}`
  ).join('');
  const svgStyle=`width:100%;display:block`;
  const svg=`<svg viewBox="0 0 ${W} ${H}" style="${svgStyle}">
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
  return svg;
}
function setChartFilter(f){dashChartFilter=f;render();}

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
    <h3>📊 Portfolio Tracker — V2.0</h3>
    <div style="display:flex;flex-direction:column;gap:6px;font-size:13px;margin-bottom:28px">
      <div><span style="color:var(--text2);min-width:120px;display:inline-block">Version</span><span>v2.0</span></div>
      <div><span style="color:var(--text2);min-width:120px;display:inline-block">Date</span><span>2026/07/22</span></div>
      <div><span style="color:var(--text2);min-width:120px;display:inline-block">Author</span><span>CarpeDiem</span></div>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:20px">
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
        invalidateFxSource(u,'fxRateSellSource');
        return u;
      });
    }
    DATA.historique=(DATA.historique||[]).map(h=>{const u={...h};invalidateFxSource(u,'fxRateSource');return u;});
    for(const key of ['cto','crypto']){
      DATA[key]=(DATA[key]||[]).map(p=>({
        ...p,
        purchases:(p.purchases||[]).map(l=>{const ul={...l};invalidateFxSource(ul,'fxRateSource');return ul;})
      }));
    }
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

// shouldShowFxBanner — 3 conditions indépendantes (spec Dashboard v2.0 §4.5).
// Ne duplique jamais la règle tout-ou-rien (calcPos) ni le filtre gpOpt (calcTradeOptions).
// [v2.0] La condition 3 (gpOpt == null) capture désormais AUSSI le cas « coût de base daté
// indisponible » via la sémantique v3.0 de gpOpt (Sales v3.0 §4.8) — pas de 4e condition FX.
function shouldShowFxBanner(){
  if(Object.keys(getFx()).length===0)return true;
  if((DATA.cto||[]).some(p=>calcPos(p,DATA.ctoTrades).wacBase==null))return true;
  if((DATA.crypto||[]).some(p=>calcPos(p,DATA.cryptoTrades).wacBase==null))return true;
  if((DATA.ctoTrades||[]).some(t=>calcTradeOptions(t,posById('cto',t.posId)).gpOpt==null))return true;
  if((DATA.cryptoTrades||[]).some(t=>calcTradeOptions(t,posById('crypto',t.posId)).gpOpt==null))return true;
  return false;
}
// [v2.0] shouldShowTemporalBanner — bandeau de cohérence temporelle, DISTINCT et INDÉPENDANT
// du bandeau FX (nature différente : chronologie vs devise ; les deux peuvent coexister).
// true si au moins une position (cto ou crypto) a soldeMin < 0 (brèche) ou remaining < 0 (§4.5bis).
// Lecture seule de calcPos — un seul et même critère, aucun calcul dupliqué, court-circuit au 1er true.
function shouldShowTemporalBanner(){
  const bad=c=>c.soldeMin<0||c.remaining<0;
  if((DATA.cto||[]).some(p=>bad(calcPos(p,DATA.ctoTrades))))return true;
  if((DATA.crypto||[]).some(p=>bad(calcPos(p,DATA.cryptoTrades))))return true;
  return false;
}
function renderDash(){
  const displayCur=getCur().code;
  const ctoC=DATA.cto.map(p=>({...p,c:calcPos(p,DATA.ctoTrades)}));
  const crC=DATA.crypto.map(p=>({...p,c:calcPos(p,DATA.cryptoTrades)}));
  // Conversion de chaque valo vers la devise Options
  function convertValo(p,c){
    if(!p.livePrice||!p.currency)return null;
    return convert(c.valo,p.currency,displayCur);
  }
  // [v2.0] valoOk : position valorisable ET valo disponible (remaining ≥ 0 ET pas de brèche).
  // Une position à valo indisponible est filtrée comme une position sans livePrice — jamais
  // comptée dans excludedCount (réservé au taux de change manquant, §4.1) ni cumulée (jamais de valo négatif).
  const valoOk=p=>p.livePrice&&p.c.valo!=null;
  let excludedCount=0;
  const cls=(DATA.settings.classes||[]).map(cl=>{
    const ps=ctoC.filter(p=>p.classe===cl&&valoOk(p));
    let valo=0;
    ps.forEach(p=>{const v=convertValo(p,p.c);if(v!=null)valo+=v;else excludedCount++;});
    return{name:cl,valo};
  });
  const unclValo=ctoC.filter(p=>valoOk(p)&&!p.classe).reduce((s,p)=>{
    const v=convertValo(p,p.c);if(v!=null)return s+v;excludedCount++;return s;
  },0);
  if(unclValo>0)cls.push({name:'?',valo:unclValo});
  const crValo=crC.filter(p=>valoOk(p)).reduce((s,p)=>{
    const v=convertValo(p,p.c);if(v!=null)return s+v;excludedCount++;return s;
  },0);
  cls.push({name:'Cryptos',valo:crValo});
  const totV=cls.reduce((s,c)=>s+c.valo,0);
  const bmap={};
  ctoC.filter(p=>valoOk(p)).forEach(p=>{
    const b=p.broker||'?';
    const v=convertValo(p,p.c);
    if(v!=null)bmap[b]=(bmap[b]||0)+v;
  });
  const bPie=Object.entries(bmap).map(([name,valo])=>({name,valo}));
  const sorted=[...DATA.historique].sort((a,b)=>a.year-b.year);
  const _maxYear=sorted.length?Math.max(...sorted.map(h=>h.year)):0;
  const _filterN=dashChartFilter==='5Y'?5:dashChartFilter==='10Y'?10:dashChartFilter==='15Y'?15:Infinity;
  const chartData=sorted.filter(h=>h.year>_maxYear-_filterN);
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
      <div class="kpi-label" style="font-size:12px">Total valuation (${displayCur.toUpperCase()})</div>
      <div class="kpi-value" style="color:var(--accent);font-size:21px">${fmt(totV)}</div>
    </div>
    ${excludedCount?`<div class="kpi" style="border-color:#92400e">
      <div class="kpi-label" style="color:#f59e0b">⚠️ Excluded positions</div>
      <div class="kpi-value" style="color:#f59e0b;font-size:14px">${excludedCount} without currency or FX</div>
    </div>`:''}
  </div>
  ${shouldShowFxBanner()?`<div style="background:#2a1f08;border:1px solid #92400e;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:11px;color:#fbbf24">
    ⚠️ Some FX rates are missing — a sync is recommended.
  </div>`:''}
  ${shouldShowTemporalBanner()?`<div style="background:#2a1f08;border:1px solid #92400e;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:11px;color:#fbbf24">
    ⚠️ Some positions have a negative stock at some point in time — check your buys and sales.
  </div>`:''}
  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
    ${makePie(ctoC.filter(p=>valoOk(p)).map(p=>({name:p.name||p.ticker||'?',valo:convertValo(p,p.c)})).filter(o=>o.valo!=null),'valo','name','Securities')}
    ${makePie(cls,'valo','name','Asset class')}
    ${makePie(bPie,'valo','name','Brokers')}
    ${makePie(crC.filter(p=>valoOk(p)).map(p=>({name:p.name||p.ticker||'?',valo:convertValo(p,p.c)})).filter(o=>o.valo!=null),'valo','name','Cryptos')}
  </div>
  <div class="card" style="margin-bottom:12px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <h3 style="margin:0">Total valuation over time</h3>
      <div style="display:flex;gap:4px">${['5Y','10Y','15Y','All'].map(f=>dashChartFilter===f
        ?`<button class="btn btn-sm" style="background:var(--accent);color:#fff;border-color:var(--accent)" onclick="setChartFilter('${f}')">${f}</button>`
        :`<button class="btn btn-sm btn-ghost" onclick="setChartFilter('${f}')">${f}</button>`
      ).join('')}</div>
    </div>
    ${lineChart(chartData)}
  </div>
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
  const trades=isCto?DATA.ctoTrades:DATA.cryptoTrades;
  const calcs=DATA[type].map(p=>({...p,c:calcPos(p,trades)}));
  // KPIs consolidés (§4.10) : uniquement positions valorisées (livePrice ET wacBase disponibles → investedRemaining calculable).
  const priced=calcs.filter(p=>p.livePrice&&p.c.investedRemaining!=null);
  const totI=priced.reduce((s,p)=>s+p.c.investedRemaining,0);   // DÉJÀ en devise de reporting — pas de convert() (piège §4.10)
  const totV=priced.reduce((s,p)=>{
    const v=convert(p.c.valo,p.currency,displayCur);            // valo NATIVE → convert() nécessaire
    return v!=null?s+v:s;
  },0);
  const totGP=totV-totI;
  const cols=isCto?18:15;
  const colgroupSpot=makeColgroup(isCto?[2,9,8,7,8,8,4,5,7,7,10,3,7,7,5,7,5,3]:[2,10,10,5,6,9,9,11,3,7,9,6,9,5,3]);
  const colgroupSub=makeColgroup([18,10,12,10,14,12,14,5,5]);
  let rows='';
  calcs.forEach(p=>{
    const c=p.c,k=type+p.id,exp=expanded[k];
    const breach=c.soldeMin<0;
    // [v3.0] Cellules en affichage seul — clic sur le nom = popup identité (édition, §4.13).
    rows+=`<tr style="cursor:pointer" onclick="toggleExp('${k}')">
      <td style="text-align:center;color:var(--text2);font-size:10px">${exp?'▲':'▼'}</td>
      <td><span class="cell-edit" onclick="event.stopPropagation();posDialog('${type}',${p.id})" title="Edit position">${esc(p.name)||'<span style="color:var(--text2)">(unnamed)</span>'}</span></td>
      ${isCto?`<td style="font-size:11px;color:var(--text2)">${esc(p.isin)}</td>`:''}
      <td style="font-size:11px;color:var(--text2)">${esc(p.ticker)}</td>
      ${isCto?`<td style="font-size:11px;color:var(--text2)">${esc(p.broker)}</td>
      <td style="font-size:11px;color:var(--text2)">${esc(p.classe)}</td>`:''}
      <td style="text-align:center;font-size:11px;color:var(--text2)">${p.currency?p.currency.toUpperCase():'—'}</td>
      <td class="r mono computed ${(c.remaining<0||breach)?'error-cell':''}">${c.soldQty>0
        ?`<div style="color:var(--text2);font-size:10px">${fmtQ(c.tq)}</div><div style="color:var(--red);font-size:10px">−${fmtQ(c.soldQty)}</div><div style="border-top:1px solid var(--border);font-weight:700">${fmtQ(c.remaining)||'0'}</div>`
        :fmtQ(c.remaining)}${breach?`<div style="color:var(--red);font-size:9px">Negative stock at ${c.breachDate}</div>`:''}</td>
      <td class="r mono computed">${c.wac>0?fmtNative(c.wac,p.currency):''}</td>
      <td class="r mono computed">${c.investedRemaining!=null?fmt(c.investedRemaining):''}</td>
      <td class="${pBg(p)} mono">
        ${pIco(p)} ${p.livePrice?fmtNative(p.livePrice,p.currency):'—'}
      </td>
      <td class="btn-col">
        <button onclick="event.stopPropagation();manualPrice('${type}',${p.id})" style="background:none;border:none;cursor:pointer;padding:2px"><span style="display:inline-block;transform:scaleX(-1)">✏️</span></button>
      </td>
      <td style="font-size:10px;color:var(--text2)">${p.priceDate||''}</td>
      <td class="r mono">${(p.livePrice&&c.valo!=null&&convert(c.valo,p.currency,displayCur)!=null)?fmt(convert(c.valo,p.currency,displayCur)):''}</td>
      <td class="r mono ${c.evol!=null?gpC(c.evol):''}">${c.evol!=null?fmtP(c.evol):''}</td>
      <td class="r mono ${c.gp!=null?gpC(c.gp):''}">${c.gp!=null?fmt(c.gp):''}</td>
      <td class="r mono">${c.investedRemaining!=null&&totI?fmtP(c.investedRemaining/totI):''}</td>
      <td><button class="btn btn-red btn-sm" onclick="event.stopPropagation();delPos('${type}',${p.id})">🗑</button></td>
    </tr>`;
    if(exp){
      let sub='';
      // [v3.0] Tri d'AFFICHAGE des lots par date sur une copie {lot, i} — l'index réel i
      // est préservé pour upPurch/delPurch/manualLotFx (jamais de tri de purchases[] en place).
      const lotEntries=p.purchases.map((lot,i)=>({lot,i})).sort((a,b)=>{
        const da=a.lot.date||'',db=b.lot.date||'';
        if(da<db)return lotSortAsc?-1:1;
        if(da>db)return lotSortAsc?1:-1;
        return 0;
      });
      lotEntries.forEach(({lot:pu,i})=>{
        const ti2=(pu.qty||0)*(pu.price||0)+(pu.fees||0);
        const lotAvgCost=(pu.qty||0)?ti2/(pu.qty||0):0;
        // Ligne en affichage seul — clic = popup lot (édition, §4.13) ; boutons FX/suppr. isolés.
        sub+=`<tr style="cursor:pointer" onclick="lotDialog('${type}',${p.id},${i})" title="Edit lot">
          <td class="mono">${pu.date||'<span style="color:var(--red)">— required —</span>'}</td>
          <td class="r mono">${fmtQ(pu.qty)}</td>
          <td class="r mono">${pu.price!=null?fmtNative(pu.price,p.currency):''}</td>
          <td class="r mono">${pu.fees!=null?fmtNative(pu.fees,p.currency):''}</td>
          <td class="r mono">${fmtNative(ti2,p.currency)}</td>
          <td class="r mono">${lotAvgCost?fmtNative(lotAvgCost,p.currency):''}</td>
          <td class="${fxBg(pu.fxRateSource)}" style="font-size:12px">
            ${fxIco(pu.fxRateSource)} ${pu.fxRate!=null?pu.fxRate.toFixed(2):'—'}
          </td>
          <td class="btn-col">
            <button onclick="event.stopPropagation();manualLotFx('${type}',${p.id},${i})" style="background:none;border:none;cursor:pointer;padding:2px"><span style="display:inline-block;transform:scaleX(-1)">✏️</span></button>
          </td>
          <td><button class="btn btn-red btn-sm" onclick="event.stopPropagation();delPurch('${type}',${p.id},${i})">✕</button></td></tr>`;
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
          <td class="r mono" style="font-weight:700;color:var(--accent)">${c.wacBase!=null?'Opt: '+fmt(c.wacBase):'—'}</td>
          <td></td><td></td></tr>`;
      }
      rows+=`<tr><td colspan="${cols}" style="padding:0;border:none"><div class="sub">
        <div class="sub-header">
          <span class="sub-title">Purchase detail — ${p.name||'(unnamed)'}</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-blue btn-sm" onclick="addPurch('${type}',${p.id})">+ Add lot</button>
            <button class="btn btn-blue btn-sm" onclick="sellFromPos('${type}',${p.id})">- Sell</button>
          </div>
        </div>
        <table class="resp-tbl" style="min-width:500px">${colgroupSub}<thead><tr>
          <th><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();toggleLotSort()" style="padding:2px 4px">${lotSortAsc?'↑':'↓'}</button> Date</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Fees</th>
          <th class="r">Total invested</th><th class="r">Lot avg cost</th><th>FX</th><th class="btn-col"></th><th></th>
        </tr></thead><tbody>${sub}</tbody></table>
      </div></td></tr>`;
    }
  });
  const syncBtn=isCto
    ?`<button class="btn btn-green" onclick="syncScope('cto')">🔄 Sync Securities prices</button>`
    :`<button class="btn btn-green" onclick="syncScope('crypto')">🔄 Sync Crypto prices</button>`;
  const hdrs=`<th></th><th>Name</th>${isCto?'<th>ISIN</th>':''}<th>${isCto?'Yahoo Ticker':'Ticker (id:currency)'}</th>
    ${isCto?'<th>Broker</th><th>Class</th>':''}
    <th>CCY</th>
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
      <button class="btn" onclick="syncLotFx('${type}')">🔄 Sync FX rates</button>
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
// [v3.0] wb = wacBaseAt(pos, t.sellDate) — coût de base DÉJÀ en devise de reporting courante
// (plus de tbDisplay/convert). tb = qSold×wb ; null si wb indisponible (orphelin, aucun lot ≤ date,
// lot ≤ date non résolu). gpOpt/tsOpt/pctOpt exigent fxRateSell résolu ET tb non-null — les deux
// conjointement (piège spec §4.5/§9). Retourne wb pour la colonne « Avg cost » live.
function calcTradeOptions(t,pos){
  const c=calcTrade(t);
  const wb=wacBaseAt(pos,t.sellDate);
  const tb=wb!=null?(t.qSold||0)*wb:null;
  if(t.fxRateSell==null||t.fxRateSellSource==='ko'||tb==null)
    return{wb,tb,tsOpt:null,gpOpt:null,pctOpt:null};
  const tsOpt=c.ts*t.fxRateSell;
  const gpOpt=tsOpt-tb;
  return{wb,tb,tsOpt,gpOpt,pctOpt:tb>0?gpOpt/tb:null};
}
// KPIs consolidés du bandeau — les 4 totaux partagent STRICTEMENT le même périmètre
// (gpOpt != null : fxRateSell résolu ET wacBaseAt(pos, sellDate) disponible). Fonction pure de l'état.
function calcSalesKpis(type){
  const key=type==='cto'?'ctoTrades':'cryptoTrades';
  const trades=DATA[key]||[];
  const complete=trades.map(t=>calcTradeOptions(t,posById(type,t.posId))).filter(o=>o.gpOpt!=null);
  const totalB=complete.reduce((s,o)=>s+o.tb,0);
  const totalS=complete.reduce((s,o)=>s+o.tsOpt,0);
  const gpTotal=complete.reduce((s,o)=>s+o.gpOpt,0);
  return{totalB,totalS,gpTotal,pctTotal:totalB>0?gpTotal/totalB:null,
         countFx:complete.length,countNoFx:trades.length-complete.length};
}
// Lecture ponctuelle et non fonctionnelle de Securities/Cryptos : existence uniquement.
// Ne sert JAMAIS à recalculer name/isin/ticker (toujours lus sur la cession figée).
function posExists(type,posId){return (DATA[type]||[]).some(p=>p.id===posId);}
// [v3.0] posById — récupère la position pour lire wacBaseAt/le solde glissant. null si orpheline
// → coût de base « — ». N'alimente JAMAIS name/isin/ticker (figés sur la cession, lecture seule).
function posById(type,posId){return (DATA[type]||[]).find(p=>p.id===posId)||null;}
// [v3.0] Plafond temporel (§4.2) : quantité max cessible à sellDate SANS rendre le solde glissant
// de la position négatif à aucune date ≥ sellDate. Reprend l'algo de solde glissant de calcPos
// (achats + / ventes −, achats avant ventes à date égale), en excluant la cession éditée.
// Se réduit au plafond global (tq − Σ autres qSold) quand sellDate est postérieure à tous les
// événements. Le niveau du solde À sellDate compte dans le min car il court jusqu'au prochain événement.
function maxSellableAt(pos,trades,sellDate,excludeId){
  if(!pos||!sellDate)return 0;
  const events=[];
  (pos.purchases||[]).forEach(x=>{if(x.date)events.push({date:x.date,amount:(x.qty||0)});});
  (trades||[]).forEach(t=>{if(t.posId===pos.id&&t.id!==excludeId&&t.sellDate)events.push({date:t.sellDate,amount:-(t.qSold||0)});});
  events.sort((a,b)=>{
    if(a.date<b.date)return -1;
    if(a.date>b.date)return 1;
    return (a.amount>0?0:1)-(b.amount>0?0:1);        // départage à date égale : achats (+) avant ventes (−)
  });
  let running=0,soldeAt=0,dispo=Infinity;
  for(const e of events){
    running+=e.amount;
    if(e.date<=sellDate)soldeAt=running;             // solde à sellDate (dernier cumul de date ≤ sellDate)
    else if(running<dispo)dispo=running;             // min du solde glissant sur les événements > sellDate
  }
  if(soldeAt<dispo)dispo=soldeAt;                     // le niveau à sellDate court jusqu'au 1er événement > sellDate
  if(dispo===Infinity)dispo=soldeAt;                 // aucun événement > sellDate ⇒ plafond = solde à sellDate
  return dispo<0?0:dispo;
}
// Navigation depuis une cession vers sa position d'origine (identification cliquable).
function goToPos(type,posId){expanded[type+posId]=true;switchTab(type);}
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

// Sync FX des lots d'achat (purchases[]) — symétrique de syncFx (Sales).
// Retraite systématiquement tous les lots datés, y compris 'ok'/'manual'.
async function syncLotFx(type){
  const positions=DATA[type]||[];
  if(!positions.some(p=>(p.purchases||[]).some(l=>l.date))){
    toast('⚠️ No purchase lot to sync','#7f1d1d');return;
  }
  toast('⏳ Syncing lot FX rates '+type.toUpperCase()+'…','#1d4ed8');
  try{
    const r=await fetch('/api/syncfx/'+type+'-purchases');
    const j=await r.json();DATA=j.data;
    const n=j.fx_ok.length,f=j.fx_fail.length;
    const ok=n>0||f===0;
    toast((ok?'✅ ':'⚠ ')+'Lot FX rates: '+n+' OK'+(f?' / '+f+' failed':''),
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
// [v2.0] manualHistoFx — applique un taux manuel saisi dans le champ « FX rate (manual) » de
// histoDialog (plus de showPrompt inline). Rejet si NaN/≤0 ; no-op si égal au taux courant arrondi
// à 4 décimales ; sinon fxRate=valeur, fxRateSource='manual' (§4.5). Accepte la virgule décimale.
function manualHistoFx(i,raw){
  const h=DATA.historique[i];if(!h)return;
  const p=parseFloat(String(raw).replace(',','.'));
  if(isNaN(p)||p<=0)return;
  const current=h.fxRate;
  if(current!=null&&p===parseFloat(current.toFixed(4)))return;
  DATA.historique[i]={...h,fxRate:p,fxRateSource:'manual'};
  saveData();render();
}

// E/S
function renderES(type){
  const isCto=type==='cto',key=isCto?'ctoTrades':'cryptoTrades';
  const trades=DATA[key]||[];
  const kpi=calcSalesKpis(type);
  const cur=getCur().code.toUpperCase();
  const badge=`<span style="font-size:9px;background:#2a0f0f;color:var(--red);padding:1px 5px;border-radius:3px;white-space:nowrap;margin-left:4px">Deleted position</span>`;
  // [v3.0] Tri d'affichage par sellDate sur une COPIE {t,i} — jamais le tableau stocké.
  // upTrade/delTrade opèrent sur l'id réel de la cession (§4.11).
  const display=trades.map((t,i)=>({t,i})).sort((a,b)=>{
    const da=a.t.sellDate||'',db=b.t.sellDate||'';
    if(da<db)return saleSortAsc?-1:1;
    if(da>db)return saleSortAsc?1:-1;
    return 0;
  });
  let rows=display.map(({t})=>{
    const pos=posById(type,t.posId);
    const o=calcTradeOptions(t,pos);       // {wb,tb,tsOpt,gpOpt,pctOpt}
    const exists=posExists(type,t.posId);
    const nm=t.name||'(unnamed)';
    return`<tr>
    <!-- IDENTIFICATION (lecture seule, figée sur la cession) -->
    <td>${exists
      ?`<span style="cursor:pointer;color:var(--accent);text-decoration:underline" onclick="goToPos('${type}',${t.posId})">${esc(nm)}</span>`
      :`${esc(nm)}${badge}`}</td>
    ${isCto?`<td style="font-size:11px;color:var(--text2)">${esc(t.isin||'')}</td>`:''}
    ${isCto?`<td style="font-size:11px;color:var(--text2)">${esc(t.ticker||'')}</td>`:''}
    <td style="text-align:center;font-size:11px;color:var(--text2)">${t.currency?t.currency.toUpperCase():'—'}</td>
    <td class="r mono" style="font-size:11px;color:var(--text2)">${o.wb!=null?fmt(o.wb):'—'}</td>
    <!-- VENTE (affichage seul) -->
    <td style="border-left:2px solid var(--accent);font-size:12px">${t.sellDate||'—'}</td>
    <td class="r mono">${fmtQ(t.qSold)||'—'}</td>
    <td class="r mono">${t.priceSell?fmtNative(t.priceSell,t.currency):'—'}</td>
    <td class="r mono">${t.feesSell?fmtNative(t.feesSell,t.currency):'—'}</td>
    <td class="${fxBg(t.fxRateSellSource)}" style="font-size:12px">
      ${fxIco(t.fxRateSellSource)} ${t.fxRateSell!=null?t.fxRateSell.toFixed(2):'—'}
    </td>
    <!-- TOTAL (devise Options) -->
    <td class="r mono" style="border-left:2px solid var(--accent)">${o.tb!=null?fmt(o.tb):'—'}</td>
    <td class="r mono">${o.tsOpt!=null?fmt(o.tsOpt):'—'}</td>
    <td class="r mono ${o.gpOpt!=null?gpC(o.gpOpt):''}">${o.gpOpt!=null?fmt(o.gpOpt):'—'}</td>
    <td class="r mono ${o.pctOpt!=null?gpC(o.pctOpt):''}">${o.pctOpt!=null?fmtP(o.pctOpt):'—'}</td>
    <!-- ACTIONS -->
    <td class="btn-col" style="white-space:nowrap">
      <button class="btn btn-sm" onclick="saleDialog('${type}',${t.posId},${t.id})" title="Edit sale">✏️</button>
      <button class="btn btn-red btn-sm" onclick="delTrade('${key}',${t.id})">🗑</button>
    </td>
  </tr>`}).join('');
  const colgroup=`<colgroup>${(isCto?[9,8,6,5,7,7,7,7,6,6,7,8,7,5,5]:[11,6,8,8,8,8,7,7,8,8,7,6,8]).map(w=>`<col style="width:${w}%">`).join('')}</colgroup>`;
  return`<div class="card">
    <h3>${isCto?'📋 Securities — Sales':'📋 Cryptos — Sales'}</h3>
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">Realized P&L (${cur})</div>
        <div class="kpi-value ${gpC(kpi.gpTotal)}">${kpi.countFx?fmt(kpi.gpTotal):'—'}</div>
        ${fxSyncAttempted[key]&&kpi.countNoFx>0?`<div style="color:var(--text2);font-size:11px">(${kpi.countNoFx} trade${kpi.countNoFx>1?'s':''} without FX rate excluded)</div>`:''}
      </div>
      <div class="kpi">
        <div class="kpi-label">Total B (${cur})</div>
        <div class="kpi-value" style="color:var(--accent)">${kpi.countFx?fmt(kpi.totalB):'—'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Total S (${cur})</div>
        <div class="kpi-value" style="color:var(--accent)">${kpi.countFx?fmt(kpi.totalS):'—'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">P&L %</div>
        <div class="kpi-value ${kpi.pctTotal!=null?gpC(kpi.pctTotal):''}">${kpi.pctTotal!=null?fmtP(kpi.pctTotal):'—'}</div>
      </div>
      ${fxSyncAttempted[key]&&kpi.countNoFx>0?`<div class="kpi" style="border-color:#92400e">
        <div class="kpi-label" style="color:#f59e0b">⚠️ No FX rate</div>
        <div class="kpi-value" style="color:#f59e0b;font-size:14px">${kpi.countNoFx} row${kpi.countNoFx>1?'s':''}</div>
      </div>`:''}
    </div>
    <div class="toolbar">
      <button class="btn" onclick="syncFx('${key}')">🔄 Sync FX rates</button>
    </div>
    <div style="overflow-x:auto;max-width:100%"><table class="resp-tbl">${colgroup}<thead>
    <tr>
      <th colspan="${isCto?5:3}" style="text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text2);font-weight:600;padding:3px 6px">Identification</th>
      <th colspan="5" style="text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text2);font-weight:600;padding:3px 6px;border-left:2px solid var(--accent)">Sell</th>
      <th colspan="4" style="text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text2);font-weight:600;padding:3px 6px;border-left:2px solid var(--accent)">Total</th>
      <th></th>
    </tr>
    <tr>
      <th>Name</th>
      ${isCto?'<th>ISIN</th>':''}
      ${isCto?'<th>Ticker</th>':''}
      <th>CCY</th>
      <th class="r">Avg cost</th>
      <th style="border-left:2px solid var(--accent)"><button class="btn btn-ghost btn-sm" onclick="toggleSaleSort()" style="padding:2px 4px">${saleSortAsc?'↑':'↓'}</button> Sell date</th>
      <th class="r">Qty</th>
      <th class="r">Unit price</th>
      <th class="r">Fees S</th>
      <th>FX S</th>
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
// [v2.0] Tableau en AFFICHAGE SEUL — plus aucun input/onchange inline. Édition/création via
// histoDialog. Indirection tri : paires {h,i} où i = index RÉEL dans DATA.historique, transmis
// à histoDialog(i)/delHisto(i) — jamais l'index visuel post-tri.
function renderHisto(){
  const currentYear=new Date().getFullYear();
  const colgroupHisto=makeColgroup([6,7,12,10,10,10,6]);
  const displayHist=DATA.historique.map((h,i)=>({h,i})).sort((a,b)=>histoSortAsc?a.h.year-b.h.year:b.h.year-a.h.year);
  let rows=displayHist.map(({h,i})=>`<tr>
    <td class="mono">${h.year!=null?h.year:'—'}</td>
    <td style="font-size:11px;color:var(--text2)">${(h.currency||'eur').toUpperCase()}</td>
    <td class="${histoFxBg(h.fxRateSource)}" style="font-size:12px">
      ${histoFxIco(h.fxRateSource)} ${h.fxRate!=null?h.fxRate.toFixed(2):'—'}
      ${h.year===currentYear?`<br><span style="font-size:9px;color:#f59e0b">⚠️ Dec 31 not yet available — using today's rate</span>`:''}
    </td>
    <td class="r mono">${fmtNative(h.securities||0,h.currency||'eur')}</td>
    <td class="r mono">${fmtNative(h.crypto||0,h.currency||'eur')}</td>
    <td class="r mono" style="color:var(--text2)">${fmtNative((h.securities||0)+(h.crypto||0),h.currency||'eur')}</td>
    <td class="btn-col" style="white-space:nowrap">
      <button class="btn btn-sm" onclick="histoDialog(${i})" title="Edit year">✏️</button>
      <button class="btn btn-red btn-sm" onclick="delHisto(${i})">🗑</button>
    </td>
  </tr>`).join('');
  return`<div class="card"><h3>📅 Annual history (Dec 31)</h3>
    <div class="toolbar">
      <button class="btn btn-blue" onclick="addHisto()">+ Add year</button>
      <button class="btn" onclick="syncHistoFx()">🔄 Sync FX rates</button>
    </div>
    <div style="overflow-x:auto;max-width:100%"><table class="resp-tbl">${colgroupHisto}<thead><tr>
      <th><button class="btn btn-ghost btn-sm" onclick="histoToggleSort()" style="padding:2px 4px">${histoSortAsc?'↑':'↓'}</button> Year</th><th>Currency</th><th>FX</th>
      <th class="r">Securities</th><th class="r">Cryptos</th><th class="r">Total</th><th class="btn-col"></th>
    </tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}
function histoToggleSort(){histoSortAsc=!histoSortAsc;render();}

// Actions utilisateur
function toggleLotSort(){lotSortAsc=!lotSortAsc;render();}   // [v3.0] affichage seul, non persisté
function toggleSaleSort(){saleSortAsc=!saleSortAsc;render();} // [v3.0] tri cessions par sellDate, affichage seul
// [v3.0] Point d'écriture identité — appelé par la validation de posDialog (plus par onchange de cellule).
// `patch` = sous-ensemble de {name,isin,broker,classe} (jamais le ticker, qui passe par up*Ticker).
function upPos(type,id,patch){DATA[type]=DATA[type].map(p=>p.id===id?{...p,...patch}:p);saveData();render();}
function upCtoTicker(id,newTicker){
  const t=newTicker.trim();
  const old=(DATA.cto.find(p=>p.id===id)||{}).ticker||'';
  if(t===old)return;
  if(!t){
    DATA.cto=DATA.cto.map(p=>p.id===id?{...p,ticker:'',currency:null,livePrice:null,priceSource:'none',priceDate:null}:p);
    saveData();render();return;
  }
  if(!isValidCtoTicker(t)){
    toast('❌ Ticker rejected: unrecognized suffix. Accepted suffixes: none (USD), .PA .AS .DE .F .MI .BR .LS .MC (EUR), .SW .VX (CHF), .L (GBP), .T (JPY), .HK (HKD), .SS .SZ (CNY)','#7f1d1d');
    render();return;
  }
  DATA.cto=DATA.cto.map(p=>p.id===id?{...p,ticker:t,currency:null,livePrice:null,priceSource:'none',priceDate:null}:p);
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
// [v3.0] posDialog — popup identité PARTAGÉE Securities/Cryptos, paramétrée par type.
// En mode crypto : masque isin/broker/classe et route la validation du ticker sur parseCryptoTicker.
// Création si id omis, édition sinon. N'écrit qu'à la validation ; Annuler n'écrit rien.
async function posDialog(type,id){
  const isCto=type==='cto';
  const isEdit=id!=null;
  const pos=isEdit?DATA[type].find(p=>p.id===id):null;
  if(isEdit&&!pos)return;
  const brokers=DATA.settings.brokers||[];
  const classes=DATA.settings.classes||[];
  const hasLots=isEdit&&pos&&(pos.purchases||[]).length>0;
  const fields=[{key:'name',label:'Name',type:'text',value:pos?pos.name||'':'',maxlength:25}];
  if(isCto)fields.push({key:'isin',label:'ISIN',type:'text',value:pos?pos.isin||'':''});
  if(hasLots){
    fields.push({key:'ticker',label:isCto?'Yahoo Ticker':'Ticker (id:currency)',type:'static',value:pos.ticker||''});
  }else{
    fields.push({key:'ticker',label:isCto?'Yahoo Ticker':'Ticker (id:currency)',type:'text',
      value:pos?pos.ticker||'':'',placeholder:isCto?'ex: CW8.PA':'ex: bitcoin:usd'});
  }
  if(isCto){
    fields.push({key:'broker',label:'Broker',type:'select',value:pos?pos.broker||'':(brokers[0]||''),
      options:[{value:'',label:''},...brokers.map(b=>({value:b,label:b}))]});
    fields.push({key:'classe',label:'Class',type:'select',value:pos?pos.classe||'':(classes[0]||''),
      options:[{value:'',label:''},...classes.map(cl=>({value:cl,label:cl}))]});
  }
  const values=await showForm({
    title:isEdit?'Edit position':'New position',
    fields,
    validate:vals=>{
      const name=(vals.name||'').trim();
      if(!name)
        return 'Name is required.';
      if(name.length>25)
        return 'Name must be 25 characters or fewer.';
      if(!hasLots){
        const t=(vals.ticker||'').trim();
        if(!t)
          return isCto?'Ticker is required.':'Ticker is required (format id:currency, e.g. bitcoin:usd).';
        if(isCto&&!isValidCtoTicker(t))
          return 'Ticker rejected: unrecognized suffix. Accepted: none (USD), .PA .AS .DE .F .MI .BR .LS .MC (EUR), .SW .VX (CHF), .L (GBP), .T (JPY), .HK (HKD), .SS .SZ (CNY).';
        if(!isCto&&!parseCryptoTicker(t))
          return 'Crypto ticker rejected. Expected id:currency (e.g. bitcoin:usd). Currencies: eur, usd, chf, gbp, jpy, hkd, cny.';
      }
      return null;
    }
  });
  if(values==null)return;                       // Annuler → aucune écriture
  const t=hasLots?(pos.ticker||''):(values.ticker||'').trim();
  if(isEdit){
    // Identité (hors ticker) via upPos ; ticker via up*Ticker (invalidation §4.2 si changé) — sauf si verrouillé (hasLots).
    upPos(type,id,isCto?{name:values.name,isin:values.isin,broker:values.broker,classe:values.classe}:{name:values.name});
    if(!hasLots){ if(isCto)upCtoTicker(id,t); else upCryptoTicker(id,t); }
  }else{
    const newId=nextId(DATA[type]);
    DATA[type].push(isCto
      ?{id:newId,name:values.name,isin:values.isin,ticker:'',broker:values.broker,classe:values.classe,
        currency:null,purchases:[],livePrice:null,priceSource:'none',priceDate:null}
      :{id:newId,name:values.name,ticker:'',currency:null,purchases:[],livePrice:null,priceSource:'none',priceDate:null});
    if(isCto)upCtoTicker(newId,t); else upCryptoTicker(newId,t);   // pose ticker + currency (crypto) — t non vide (validé)
  }
}
// [v3.0] lotDialog — popup lot d'achat PARTAGÉE. `date` obligatoire (LOT_DATE_REQUIRED).
// Création si lotIndex omis, édition sinon. L'écriture passe par upPurch à la validation.
async function lotDialog(type,posId,lotIndex){
  const pos=(DATA[type]||[]).find(p=>p.id===posId);
  if(!pos)return;
  const isEdit=lotIndex!=null;
  const lot=isEdit?(pos.purchases||[])[lotIndex]:null;
  if(isEdit&&!lot)return;
  const values=await showForm({
    title:isEdit?'Edit lot':'Add lot',
    fields:[
      {key:'date',label:'Date',type:'date',value:lot?lot.date||'':''},
      {key:'qty',label:'Quantity',type:'number',value:lot&&lot.qty?lot.qty:''},
      {key:'price',label:'Unit price',type:'number',value:lot&&lot.price?lot.price:''},
      {key:'fees',label:'Fees',type:'number',value:lot&&lot.fees?lot.fees:''}
    ],
    validate:vals=>{
      if(!vals.date||!vals.date.trim())return 'A date is required.';                 // LOT_DATE_REQUIRED
      if(vals.date.trim()>isoToday())return 'Date cannot be in the future.';          // LOT_DATE_FUTURE
      const q=parseFloat(vals.qty);
      if(isNaN(q)||q<=0)return 'Quantity must be a number greater than 0.';          // LOT_QTY_INVALID
      if(vals.price!==''&&(isNaN(parseFloat(vals.price))||parseFloat(vals.price)<0))return 'Unit price must be a number ≥ 0.';
      if(vals.fees!==''&&(isNaN(parseFloat(vals.fees))||parseFloat(vals.fees)<0))return 'Fees must be a number ≥ 0.';
      return null;
    }
  });
  if(values==null)return;
  upPurch(type,posId,lotIndex,{date:values.date.trim(),qty:parseFloat(values.qty)||0,
    price:parseFloat(values.price)||0,fees:parseFloat(values.fees)||0});
}
// [v3.0] manualFx — applique un taux de vente manuel saisi dans le champ « FX rate (manual) »
// de saleDialog (plus de showPrompt inline). Rejet si NaN/≤0 ; no-op si égal au taux courant
// arrondi à 4 décimales ; sinon fxRateSell=valeur, fxRateSellSource='manual' (§4.7).
function manualFx(key,id,raw){
  const trade=(DATA[key]||[]).find(x=>x.id===id);if(!trade)return;
  const p=parseFloat(String(raw).replace(',','.'));
  if(isNaN(p)||p<=0)return;
  const current=trade.fxRateSell;
  if(current!=null&&p===parseFloat(current.toFixed(4)))return;
  DATA[key]=DATA[key].map(x=>x.id===id?{...x,fxRateSell:p,fxRateSellSource:'manual'}:x);
  saveData();render();
}
// Saisie manuelle du taux FX d'un lot d'achat — symétrique de manualFx (Sales).
// Débloque wacBase (fxRateSource='manual' équivaut à une sync auto réussie, §4.5).
async function manualLotFx(type,posId,lotIndex){
  const pos=(DATA[type]||[]).find(x=>x.id===posId);if(!pos)return;
  const lot=(pos.purchases||[])[lotIndex];if(!lot)return;
  const cur=pos.currency?pos.currency.toUpperCase():'?';
  const optCur=getCur().code.toUpperCase();
  const current=lot.fxRate;
  const v=await showPrompt(
    'Rate '+cur+'→'+optCur+(current?' (current: '+current.toFixed(4)+')':'')+':',
    current?current.toFixed(4):''
  );
  if(v===null)return;
  const p=parseFloat(v.replace(',','.'));
  if(isNaN(p)||p<=0){toast('Invalid rate','#7f1d1d');return;}
  if(current!=null&&p===parseFloat(current.toFixed(4)))return;
  DATA[type]=DATA[type].map(x=>{
    if(x.id!==posId)return x;
    const ps=[...x.purchases];ps[lotIndex]={...ps[lotIndex],fxRate:p,fxRateSource:'manual'};
    return{...x,purchases:ps};
  });
  saveData();render();
}
async function manualPrice(type,id){
  const pos=(DATA[type]||[]).find(x=>x.id===id);
  const cur=pos&&pos.currency?pos.currency.toUpperCase():'?';
  const current=pos&&pos.livePrice!=null?pos.livePrice:null;
  const v=await showPrompt('Price in '+cur+(current!=null?' (current: '+current.toFixed(2)+')':'')+':',
    current!=null?current.toFixed(2):'');
  if(v===null)return;
  const p=parseFloat(v.replace(',','.'));if(isNaN(p)||p<=0){toast('Invalid price','#7f1d1d');return;}
  if(current!=null&&p===parseFloat(current.toFixed(2)))return;
  const now=isoNow();
  DATA[type]=DATA[type].map(x=>x.id===id?{...x,livePrice:p,priceSource:'manual',priceDate:now}:x);
  saveData();render();
}
// [v3.0] addPos/addPurch ouvrent la popup au lieu d'écrire une ligne vide — écriture à la validation.
function addPos(type){posDialog(type);}
async function delPos(type,id){if(!(await showConfirm('Delete?')))return;DATA[type]=DATA[type].filter(p=>p.id!==id);saveData();render();}
function addPurch(type,pid){lotDialog(type,pid);}
// [v3.0] Point d'écriture lot — appelé par lotDialog. Création si lotIndex null, sinon édition.
// `patch` = {date,qty,price,fees} déjà parsés/validés par lotDialog.
// Édition avec date modifiée ⇒ invalidation fxRateSource → 'ko' (resync requise).
function upPurch(type,pid,lotIndex,patch){
  DATA[type]=DATA[type].map(p=>{
    if(p.id!==pid)return p;
    const ps=[...(p.purchases||[])];
    if(lotIndex==null){
      const fx=resolveFx(p.currency);
      ps.push({date:patch.date,qty:patch.qty,price:patch.price,fees:patch.fees,fxRate:fx.rate,fxRateSource:fx.source});
    }else{
      const old=ps[lotIndex]||{};
      const dateChanged=(old.date||'')!==patch.date;
      const nl={...old,date:patch.date,qty:patch.qty,price:patch.price,fees:patch.fees};
      if(dateChanged){
        const fx=resolveFx(p.currency);
        if(fx.rate!=null){nl.fxRate=fx.rate;nl.fxRateSource=fx.source;}
        else invalidateFxSource(nl,'fxRateSource');   // même règle que buyDate/sellDate en Sales
      }
      ps[lotIndex]=nl;
    }
    return{...p,purchases:ps};
  });saveData();render();
}
// delPurch — retrait par index réel, aucun contrôle croisé sur les cessions ([DÉCISION] soft-signal).
function delPurch(type,pid,i){
  DATA[type]=DATA[type].map(p=>p.id===pid?{...p,purchases:p.purchases.filter((_,j)=>j!==i)}:p);
  saveData();render();
}
// [v3.0] sellFromPos — SEULE voie de création : ouvre saleDialog en mode création.
// Ne fige plus aucun coût de base (wacBaseAt dynamique) ; plus de pré-remplissage qSold=remaining ;
// plus de blocage WACBASE_UNAVAILABLE (coût de base indisponible ⇒ « — », jamais un rejet).
function sellFromPos(type,id){
  const key=type==='cto'?'ctoTrades':'cryptoTrades';
  const pos=DATA[type].find(p=>p.id===id);
  if(!pos)return;
  const c=calcPos(pos,DATA[key]);
  if(!(c.remaining>0)){toast('⚠️ No remaining quantity to sell','#7f1d1d');return;}   // NO_QUANTITY_AVAILABLE
  saleDialog(type,id);
}
// [v3.0] saleDialog — popup de cession PARTAGÉE Securities/Cryptos (via showForm).
// Création si tradeId omis, édition sinon. Identité (name/isin/ticker/currency) en LECTURE SEULE
// (champs statiques). sellDate OBLIGATOIRE ; qSold plafonné temporellement (maxSellableAt) ;
// FX manuel intégré en édition. N'écrit qu'à la validation ; Annuler n'écrit rien.
async function saleDialog(type,posId,tradeId){
  const isCto=type==='cto',key=isCto?'ctoTrades':'cryptoTrades';
  const isEdit=tradeId!=null;
  const trade=isEdit?(DATA[key]||[]).find(t=>t.id===tradeId):null;
  if(isEdit&&!trade)return;
  const pos=posById(type,posId);   // peut être null (orpheline) — coût de base « — », saisie toujours possible
  // Identité : copiée depuis la position en création, figée sur la cession en édition (lecture seule).
  const name=(isEdit?trade.name:(pos&&pos.name))||'(unnamed)';
  const isin=(isEdit?trade.isin:(pos&&pos.isin))||'';
  const ticker=(isEdit?trade.ticker:(pos&&pos.ticker))||'';
  const currency=(isEdit?trade.currency:(pos&&pos.currency))||null;
  const curLabel=currency?currency.toUpperCase():'—';
  const optCur=getCur().code.toUpperCase();

  const fields=[{key:'_name',label:'Name',type:'static',value:name}];
  if(isCto){
    fields.push({key:'_isin',label:'ISIN',type:'static',value:isin});
    fields.push({key:'_ticker',label:'Ticker',type:'static',value:ticker});
  }
  fields.push({key:'_currency',label:'Currency',type:'static',value:curLabel});
  fields.push({key:'sellDate',label:'Sell date',type:'date',value:isEdit?(trade.sellDate||''):''});
  fields.push({key:'qSold',label:'Quantity',type:'number',value:isEdit&&trade.qSold?trade.qSold:''});
  fields.push({key:'priceSell',label:'Unit price',type:'number',value:isEdit&&trade.priceSell?trade.priceSell:''});
  fields.push({key:'feesSell',label:'Fees',type:'number',value:isEdit&&trade.feesSell?trade.feesSell:''});
  // FX manuel : uniquement en édition (§4.7) — une cession en création n'a pas encore de taux.
  if(isEdit)fields.push({key:'fxManual',label:'FX rate ('+curLabel+'→'+optCur+', manual)',type:'number',
    value:trade.fxRateSell!=null?trade.fxRateSell.toFixed(4):''});

  const values=await showForm({
    title:isEdit?'Edit sale':'Sell — '+name,
    fields,
    validate:vals=>{
      if(!vals.sellDate||!vals.sellDate.trim())return 'A sell date is required.';               // SELLDATE_REQUIRED
      if(vals.sellDate.trim()>isoToday())return 'Sell date cannot be in the future.';            // SELLDATE_FUTURE
      const q=parseFloat(vals.qSold);
      if(isNaN(q)||q<=0)return 'Quantity must be a number greater than 0.';
      const cap=maxSellableAt(pos,DATA[key],vals.sellDate.trim(),isEdit?tradeId:undefined);
      if(q>cap)return 'Quantity exceeds available at that date ('+(fmtQ(cap)||'0')+' available).';  // QTY_EXCEEDS_TEMPORAL
      if(vals.priceSell!==''&&isNaN(parseFloat(vals.priceSell)))return 'Unit price must be a number.';
      if(vals.feesSell!==''&&isNaN(parseFloat(vals.feesSell)))return 'Fees must be a number.';
      if(isEdit&&vals.fxManual!==''&&(isNaN(parseFloat(vals.fxManual))||parseFloat(vals.fxManual)<=0))
        return 'FX rate must be a number greater than 0.';                                        // FX_RATE_INVALID
      return null;
    }
  });
  if(values==null)return;   // Annuler → aucune écriture

  const patch={
    sellDate:values.sellDate.trim(),
    qSold:parseFloat(values.qSold)||0,
    priceSell:parseFloat(values.priceSell)||0,
    feesSell:parseFloat(values.feesSell)||0
  };
  if(!isEdit){
    // Création : identité figée depuis la position, aucun coût de base stocké.
    const fxSell=resolveFx(pos?pos.currency:null);
    DATA[key].push({id:nextId(DATA[key]),posId:posId,
      name:(pos&&pos.name)||'',
      ...(isCto?{isin:(pos&&pos.isin)||'',ticker:(pos&&pos.ticker)||''}:{}),
      currency:pos?pos.currency:null,
      ...patch,
      fxRateSell:fxSell.rate,fxRateSellSource:fxSell.source});
    saveData();
    switchTab(isCto?'ctoES':'cryptoES');
  }else{
    upTrade(key,tradeId,patch);   // invalide fxRateSellSource → 'ko' si sellDate a changé
    // FX manuel appliqué APRÈS upTrade : un taux saisi l'emporte sur l'invalidation de sellDate.
    if(values.fxManual!=='')manualFx(key,tradeId,values.fxManual);
  }
}
// [v3.0] upTrade — point d'écriture d'une cession, appelé par la validation de saleDialog
// (plus par onchange inline). patch = {sellDate,qSold,priceSell,feesSell} déjà validés
// (dont plafond temporel). Changement de sellDate ⇒ invalidation fxRateSellSource → 'ko'.
function upTrade(key,id,patch){
  DATA[key]=DATA[key].map(t=>{
    if(t.id!==id)return t;
    const updated={...t,...patch};
    if((t.sellDate||'')!==patch.sellDate){
      const fx=resolveFx(t.currency);
      if(fx.rate!=null){updated.fxRateSell=fx.rate;updated.fxRateSellSource=fx.source;}
      else invalidateFxSource(updated,'fxRateSellSource');
    }
    return updated;
  });
  saveData();render();
}
async function delTrade(key,id){if(!(await showConfirm('Delete?')))return;DATA[key]=DATA[key].filter(t=>t.id!==id);saveData();render();}
// [v2.0] addHisto — ouvre histoDialog en création (plus d'écriture d'une ligne vide directe).
function addHisto(){histoDialog();}
// [v2.0] histoDialog — popup History PARTAGÉE création/édition (via showForm). Création si index
// omis, édition sinon. Champs year, currency, securities, crypto, et FX rate (manual) en édition.
// Contrôles bloquants : année invalide/<1900/future/dupliquée, taux manuel NaN/≤0. Écrit à la validation.
// Indirection tri : `index` reçu = index RÉEL dans DATA.historique (jamais l'index visuel post-tri).
async function histoDialog(index){
  const isEdit=index!=null;
  const h=isEdit?DATA.historique[index]:null;
  if(isEdit&&!h)return;
  const currentYear=new Date().getFullYear();
  const years=DATA.historique.map(e=>e.year).filter(y=>y!=null);
  const defYear=isEdit?h.year:(years.length?Math.max(...years)+1:currentYear);
  const curs=['eur','usd','chf','gbp','jpy','hkd','cny'];
  const fields=[
    {key:'year',label:'Year',type:'number',value:defYear!=null?defYear:''},
    {key:'currency',label:'Currency',type:'select',value:isEdit?(h.currency||'eur'):getCur().code,
      options:curs.map(c=>({value:c,label:c.toUpperCase()}))},
    {key:'securities',label:'Securities',type:'number',value:isEdit&&h.securities?h.securities:''},
    {key:'crypto',label:'Cryptos',type:'number',value:isEdit&&h.crypto?h.crypto:''},
  ];
  // FX manuel : champ 'text' (accepte la virgule décimale — type=number la rejetterait), édition seule.
  if(isEdit)fields.push({key:'fxManual',label:'FX rate (manual)',type:'text',
    value:h.fxRate!=null?h.fxRate.toFixed(4):''});
  const values=await showForm({
    title:isEdit?'Edit year':'Add year',
    fields,
    validate:vals=>{
      const raw=String(vals.year).trim();
      const y=parseInt(raw);
      if(raw===''||isNaN(y))return 'A valid year is required.';
      if(y<1900)return "That year? You definitely weren't born yet.";
      if(y>currentYear)return 'Year '+y+' is in the future.';                                   // YEAR_IN_FUTURE
      if(DATA.historique.some((e,j)=>j!==index&&e.year===y))return 'Year '+y+' already exists.'; // YEAR_DUPLICATE
      if(isEdit&&vals.fxManual!==''){
        const p=parseFloat(String(vals.fxManual).replace(',','.'));
        if(isNaN(p)||p<=0)return 'FX rate must be a number greater than 0.';                     // FX_RATE_INVALID
      }
      return null;
    }
  });
  if(values==null)return;   // Annuler → aucune écriture
  const patch={
    year:parseInt(String(values.year).trim()),
    currency:values.currency,
    securities:parseFloat(values.securities)||0,
    crypto:parseFloat(values.crypto)||0
  };
  if(!isEdit){
    // Création : ligne complète, sans champ 'classes' (§4.1/§4.6).
    const fxH=resolveFx(patch.currency);
    DATA.historique.push({year:patch.year,currency:patch.currency,
      securities:patch.securities,crypto:patch.crypto,total:patch.securities+patch.crypto,
      fxRate:fxH.rate,fxRateSource:fxH.source});
    saveData();render();
  }else{
    upHisto(index,patch);   // invalide fxRateSource → 'ko' si year/currency change
    // FX manuel appliqué APRÈS upHisto : un taux saisi l'emporte sur l'invalidation year/currency.
    if(values.fxManual!=='')manualHistoFx(index,values.fxManual);
  }
}
// [v2.0] upHisto — point d'écriture appelé par la validation de histoDialog (plus par onchange).
// patch = {year,currency,securities,crypto} déjà validés. Recalcule total ; invalide fxRateSource
// → 'ko' si year OU currency change (inconditionnel, y compris depuis 'manual', §4.2).
function upHisto(i,patch){
  const h=DATA.historique[i];
  if(!h)return;
  const changed=(patch.year!==h.year)||(patch.currency!==h.currency);
  const u={...h,year:patch.year,currency:patch.currency,
           securities:patch.securities,crypto:patch.crypto};
  u.total=(u.securities||0)+(u.crypto||0);
  if(changed){
    const fx=resolveFx(u.currency);
    if(fx.rate!=null){u.fxRate=fx.rate;u.fxRateSource=fx.source;}
    else invalidateFxSource(u,'fxRateSource');
  }
  DATA.historique[i]=u;
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

if(!document.getElementById('chart-tooltip'))document.body.insertAdjacentHTML('beforeend','<div id="chart-tooltip"></div>');
loadData();
