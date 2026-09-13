/**
 * Apex rollouts v2 — live Discord guild % + recent filter
 * Secret: DISCORD_USER_TOKEN (user token, not bot) for 2024+ rollouts
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'apex_rollouts.json');
const LOCAL_EXP = path.join(DATA_DIR, 'experiments.json');
const DISCORD_TOKEN = (process.env.DISCORD_USER_TOKEN || process.env.DISCORD_TOKEN || '').trim();
const WORKERS = process.env.APEX_API_URL || 'https://experiments.dscrd.workers.dev/experiments';
const FALLBACK = process.env.APEX_FALLBACK_URL || 'https://raw.githubusercontent.com/discordexperimenthub/experimentAPI/master/experiments.json';
const WEBHOOK = process.env.APEX_WEBHOOK_URL || process.env.ROLLOUT_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR = process.env.ORBIT_AVATAR_URL || 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f4ca.png';
const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || '0.5');
const YEAR_MIN = Number(process.env.APEX_RECENT_YEAR || '2024');
const SCALE = 10000;

function murmur3(key, seed = 0) {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  const bytes = Buffer.from(String(key), 'utf8');
  const len = bytes.length, nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    let k1 = bytes[i*4] | (bytes[i*4+1]<<8) | (bytes[i*4+2]<<16) | (bytes[i*4+3]<<24);
    k1 = Math.imul(k1, c1); k1 = (k1<<15)|(k1>>>17); k1 = Math.imul(k1, c2);
    h1 ^= k1; h1 = (h1<<13)|(h1>>>19); h1 = (Math.imul(h1,5)+0xe6546b64)>>>0;
  }
  let k1 = 0, off = nblocks*4, tail = len & 3;
  if (tail===3) k1 ^= bytes[off+2]<<16;
  if (tail>=2) k1 ^= bytes[off+1]<<8;
  if (tail>=1) { k1 ^= bytes[off]; k1=Math.imul(k1,c1); k1=(k1<<15)|(k1>>>17); k1=Math.imul(k1,c2); h1^=k1; }
  h1 ^= len; h1 ^= h1>>>16; h1 = Math.imul(h1,0x85ebca6b); h1 ^= h1>>>13;
  h1 = Math.imul(h1,0xc2b2ae35); h1 ^= h1>>>16;
  return h1 >>> 0;
}

function mergeIntervals(iv) {
  const s = iv.map(([a,b])=>[Number(a),Number(b)]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if (!s.length) return [];
  const out = [s[0].slice()];
  for (let i=1;i<s.length;i++){ const [a,b]=s[i]; const L=out[out.length-1]; if(a<=L[1]) L[1]=Math.max(L[1],b); else out.push([a,b]); }
  return out;
}
function intervalsToPct(iv) {
  let c=0; for (const [a,b] of mergeIntervals(iv)) c+=b-a;
  return Math.min(100, Math.round((c/SCALE)*10000)/100);
}
function toIntervals(rollouts) {
  const out=[]; if(!Array.isArray(rollouts)) return out;
  for (const r of rollouts) {
    if (Array.isArray(r) && r.length>=2) { out.push([r[0],r[1]]); continue; }
    const a=r.start??r.s, b=r.end??r.e; if(a!=null&&b!=null) out.push([a,b]);
  }
  return out;
}
function isRecent(id){ const m=String(id).match(/^(20\d{2})/); return m ? Number(m[1])>=YEAR_MIN : false; }
function tLabel(b){ if(b===-1) return 'None'; if(b===0) return 'Control'; return 'Treatment '+b; }

function fromWire(tuple, hashMap) {
  if (!Array.isArray(tuple)||tuple.length<4) return null;
  const hash=tuple[0], key=tuple[1], rev=tuple[2], pops=tuple[3]||[], ovs=tuple[4]||[];
  let id = (typeof key==='string'&&key) || hashMap.get(Number(hash)) || hashMap.get(String(hash)) || ('hash:'+hash);
  const byB=new Map(), details=[];
  for (const pop of pops) {
    if (!Array.isArray(pop)) continue;
    const positions=pop[0]||[], filters=pop[1]||[];
    const dt=[];
    for (const pos of positions) {
      if (!Array.isArray(pos)) continue;
      const bucket=pos[0], ranges=pos[1]||[];
      const iv=toIntervals(ranges), pct=intervalsToPct(iv);
      const label=tLabel(bucket);
      dt.push({bucket,label,pct});
      if (!byB.has(bucket)) byB.set(bucket,{bucket,label,intervals:[]});
      byB.get(bucket).intervals.push(...iv);
    }
    details.push({filters: filters.length? String(filters.length)+' filter(s)':null, treatments:dt});
  }
  const treatments=[...byB.values()].map(t=>({bucket:t.bucket,label:t.label,pct:intervalsToPct(t.intervals)}))
    .sort((a,b)=>(a.bucket??9999)-(b.bucket??9999));
  let ov=0;
  for (const o of ovs) {
    if (Array.isArray(o)) ov+=(o[1]||[]).length||0;
    else if (o&&typeof o==='object') ov+=(o.ids||o.k||[]).length||0;
  }
  const fingerprint=treatments.map(t=>t.bucket+':'+t.pct.toFixed(2)).join(',')+'|ov:'+ov+'|pops:'+pops.length+'|rev:'+rev;
  return {id:String(id),type:'guild',title:String(id),treatments,populations:details,overrideIdCount:ov,populationCount:pops.length,fingerprint,revision:rev,hash:Number(hash),recent:isRecent(id)};
}

function fromObject(raw) {
  if (!raw||!raw.id) return null;
  const id=String(raw.id), type=String(raw.type||'unknown').toLowerCase();
  const title=String(raw.title||raw.name||id).slice(0,200);
  const rollout=raw.rollout||{};
  let pops=Array.isArray(rollout.populations)?rollout.populations:[];
  const byB=new Map(), details=[];
  for (const pop of pops) {
    if (pop && !Array.isArray(pop)) {
      const buckets=pop.buckets||pop.positions||[];
      const dt=[];
      for (const pos of buckets) {
        const bucket=pos.bucket, iv=toIntervals(pos.rollouts||pos.ranges||[]), pct=intervalsToPct(iv);
        const label=pos.treatment||tLabel(bucket);
        dt.push({bucket,label,pct});
        if (!byB.has(bucket)) byB.set(bucket,{bucket,label,intervals:[]});
        byB.get(bucket).intervals.push(...iv);
      }
      details.push({filters:null,treatments:dt});
      continue;
    }
    if (Array.isArray(pop)) {
      const positions=pop[0]||[]; const dt=[];
      for (const pos of positions) {
        if (!Array.isArray(pos)) continue;
        const bucket=pos[0], iv=toIntervals(pos[1]||[]), pct=intervalsToPct(iv);
        const label=tLabel(bucket);
        dt.push({bucket,label,pct});
        if (!byB.has(bucket)) byB.set(bucket,{bucket,label,intervals:[]});
        byB.get(bucket).intervals.push(...iv);
      }
      details.push({filters:null,treatments:dt});
    }
  }
  const treatments=[...byB.values()].map(t=>({bucket:t.bucket,label:t.label,pct:intervalsToPct(t.intervals)}));
  const ovs=rollout.overrides||[];
  const ov=Array.isArray(ovs)?ovs.reduce((n,o)=>n+((o.ids||o.k||[]).length||0),0):0;
  const fingerprint=treatments.map(t=>(t.bucket!=null?t.bucket:t.label)+':'+t.pct.toFixed(2)).join(',')+'|ov:'+ov+'|pops:'+pops.length;
  return {id,type,title,treatments,populations:details,overrideIdCount:ov,populationCount:pops.length,fingerprint,revision:rollout.revision??null,hash:raw.hash??null,recent:isRecent(id)};
}

async function buildHashMap() {
  const map=new Map();
  try {
    if (await fs.pathExists(LOCAL_EXP)) {
      const data=await fs.readJson(LOCAL_EXP);
      const list=Array.isArray(data)?data:(data.experiments||[]);
      for (const e of list) {
        if (!e||!e.id) continue;
        const h=murmur3(String(e.id));
        map.set(h,String(e.id)); map.set(String(h),String(e.id));
      }
      console.log('Hash map:', map.size/2, 'ids');
    }
  } catch(e) { console.warn('Hash map:', e.message); }
  return map;
}

async function fetchDiscord(hashMap) {
  const headers={'User-Agent':UA, Accept:'application/json'};
  if (DISCORD_TOKEN) headers.Authorization = DISCORD_TOKEN;
  for (const url of [
    'https://discord.com/api/v9/experiments?with_guild_experiments=true',
    'https://canary.discord.com/api/v9/experiments?with_guild_experiments=true',
  ]) {
    try {
      const res=await fetch(url,{headers,timeout:30000});
      if (!res.ok) { console.warn('Discord', res.status, url); continue; }
      const data=await res.json();
      const ge=data.guild_experiments||[];
      console.log('Discord guild_experiments:', ge.length, DISCORD_TOKEN?'(token)':'(anon limited)');
      return ge.map(t=>fromWire(t,hashMap)).filter(Boolean);
    } catch(e) { console.warn('Discord fail', e.message); }
  }
  return [];
}

async function fetchJson(url) {
  const res=await fetch(url,{headers:{'User-Agent':UA,Accept:'application/json'},timeout:45000});
  if (!res.ok) throw new Error(url+' → '+res.status);
  return res.json();
}
function asArr(d){ if(Array.isArray(d))return d; if(d&&Array.isArray(d.experiments))return d.experiments; return []; }

async function loadExperiments() {
  const hashMap=await buildHashMap();
  const sources={discord:0,workers:0,fallback:0,merged:0,recent:0,hasToken:!!DISCORD_TOKEN};
  const byId=new Map();
  try {
    const live=await fetchDiscord(hashMap);
    sources.discord=live.length;
    for (const e of live) byId.set(e.id,e);
  } catch(e){ console.warn(e.message); }
  for (const [label,url] of [['workers',WORKERS],['fallback',FALLBACK]]) {
    try {
      const arr=asArr(await fetchJson(url));
      sources[label]=arr.length;
      let added=0;
      for (const raw of arr) {
        const n=fromObject(raw); if(!n) continue;
        if (byId.has(n.id) && !String(byId.get(n.id).id).startsWith('hash:')) continue;
        if (!byId.has(n.id)) { byId.set(n.id,n); added++; }
      }
      console.log(label+':', arr.length, 'new', added);
    } catch(e){ console.warn(label, e.message); }
  }
  let experiments=[...byId.values()];
  experiments.sort((a,b)=> (a.recent===b.recent?0:a.recent?-1:1) || String(b.id).localeCompare(String(a.id)));
  sources.merged=experiments.length;
  sources.recent=experiments.filter(e=>e.recent).length;
  if (!DISCORD_TOKEN) console.warn('⚠️ DISCORD_USER_TOKEN manquant — % live incomplets pour 2025/2026');
  if (sources.recent===0 && sources.merged>0) console.warn('⚠️ Aucun experiment ≥'+YEAR_MIN+' — sources périmées');
  return {experiments, sources};
}

function diffExperiments(prev, next) {
  const pMap=new Map(prev.map(e=>[e.id,e])), nMap=new Map(next.map(e=>[e.id,e]));
  const added=[], removed=[], changed=[];
  for (const [id,n] of nMap) {
    const p=pMap.get(id);
    if (!p) { if (n.recent || (n.treatments||[]).some(t=>t.pct>0)) added.push(n); continue; }
    if (p.fingerprint===n.fingerprint) continue;
    const deltas=[];
    const pt=new Map((p.treatments||[]).map(t=>[String(t.bucket??t.label),t]));
    for (const t of n.treatments||[]) {
      const k=String(t.bucket??t.label); const old=pt.get(k); const from=old?old.pct:0;
      const d=Math.round((t.pct-from)*100)/100;
      if (Math.abs(d)>=MIN_DELTA) deltas.push({label:t.label,bucket:t.bucket,from,to:t.pct,delta:d});
    }
    for (const t of p.treatments||[]) {
      const k=String(t.bucket??t.label);
      if (!(n.treatments||[]).some(x=>String(x.bucket??x.label)===k) && Math.abs(t.pct)>=MIN_DELTA)
        deltas.push({label:t.label,bucket:t.bucket,from:t.pct,to:0,delta:-t.pct});
    }
    const ovDelta=(n.overrideIdCount||0)!==(p.overrideIdCount||0)?{from:p.overrideIdCount||0,to:n.overrideIdCount||0}:null;
    if (deltas.length||ovDelta) {
      const maxAbs=deltas.reduce((m,x)=>Math.max(m,Math.abs(x.delta)),0);
      if (!n.recent && !p.recent && maxAbs<5) continue;
      changed.push({before:p,after:n,deltas,ovDelta,maxAbs});
    }
  }
  for (const [id,p] of pMap) if (!nMap.has(id) && (p.recent||isRecent(p.id))) removed.push(p);
  changed.sort((a,b)=>b.maxAbs-a.maxAbs);
  added.sort((a,b)=>a.recent===b.recent?0:a.recent?-1:1);
  return {added,removed,changed};
}

function fmtTreat(ts,max=10){
  const lines=(ts||[]).slice(0,max).map(t=>'• **'+(t.label||('Bucket '+t.bucket))+'** · `'+t.pct+'%`');
  if ((ts||[]).length>max) lines.push('_+'+(ts.length-max)+' autres_');
  return lines.join('\n')||'_—_';
}

function buildEmbeds(diff, stats) {
  const embeds=[{
    author:{name:'Apex Rollouts',icon_url:AVATAR},
    title:'Mise à jour des pourcentages',
    description:[
      '**Live Discord** · `'+stats.sources.discord+'` · workers `'+stats.sources.workers+'` · merged `'+stats.sources.merged+'` · récents ≥'+YEAR_MIN+' `'+stats.sources.recent+'`',
      '**Token** · `'+(stats.sources.hasToken?'oui':'non')+'`',
      '**Δ** · +`'+diff.added.length+'` · ~`'+diff.changed.length+'` · -`'+diff.removed.length+'`',
    ].join('\n'),
    color:0x5865f2, footer:{text:'Datamining · Apex %'}, timestamp:new Date().toISOString(),
  }];
  for (const e of diff.added.slice(0,8)) {
    embeds.push({title:'+ '+e.id, description:['**'+e.title+'**','Type · `'+e.type+'`'+(e.recent?' · récent':''),'',fmtTreat(e.treatments)].join('\n').slice(0,4000), color:0x57f287, footer:{text:'Nouveau rollout'}});
  }
  for (const c of diff.changed.slice(0,10)) {
    const e=c.after;
    const lines=c.deltas.slice(0,12).map(d=>'• **'+(d.label||'bucket')+'** · `'+d.from+'%` → `'+d.to+'%` (`'+(d.delta>0?'+':'')+d.delta+'`)');
    if (c.ovDelta) lines.push('• Overrides · `'+c.ovDelta.from+'` → `'+c.ovDelta.to+'`');
    embeds.push({title:'~ '+e.id, description:['**'+e.title+'**','Type · `'+e.type+'`'+(e.recent?' · récent':''),'',lines.join('\n')].join('\n').slice(0,4000), color:0xe67e22, footer:{text:'Δ max '+c.maxAbs+'%'}});
  }
  for (const e of diff.removed.slice(0,4)) {
    embeds.push({title:'- '+e.id, description:'**'+e.title+'** · `'+e.type+'`', color:0xed4245, footer:{text:'Retiré'}});
  }
  return embeds.slice(0,10);
}

async function postWebhook(embeds) {
  if (!WEBHOOK) return {ok:false,status:0,text:'no webhook'};
  let last={ok:true,status:204,text:''};
  for (let i=0;i<embeds.length;i+=10) {
    const res=await fetch(WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:BOT,avatar_url:AVATAR,embeds:embeds.slice(i,i+10)})});
    const text=await res.text().catch(()=>'');
    last={ok:res.ok,status:res.status,text:text.slice(0,300)};
    if (!res.ok) return last;
    await new Promise(r=>setTimeout(r,450));
  }
  return last;
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('📊 Apex rollouts v2…');
  console.log('Webhook:', WEBHOOK?'set':'MISSING');
  console.log('Token:', DISCORD_TOKEN?'set':'MISSING');
  const {experiments,sources}=await loadExperiments();
  console.log('Merged:', experiments.length, sources);
  let previous={experiments:[]};
  if (await fs.pathExists(STATE_FILE)) { try{previous=await fs.readJson(STATE_FILE);}catch(e){} }
  const prev=previous.experiments||[];
  const isFirst=!prev.length;
  const diff=isFirst?{added:[],removed:[],changed:[]}:diffExperiments(prev,experiments);
  console.log('Diff',{added:diff.added.length,changed:diff.changed.length,removed:diff.removed.length,first:isFirst});
  const compact=experiments.map(e=>({id:e.id,type:e.type,title:e.title,fingerprint:e.fingerprint,treatments:e.treatments,overrideIdCount:e.overrideIdCount,populationCount:e.populationCount,populations:(e.populations||[]).map(p=>({filters:p.filters,treatments:p.treatments})),revision:e.revision,recent:e.recent,hash:e.hash}));
  await fs.writeJson(STATE_FILE,{scrapedAt:new Date().toISOString(),sources,count:compact.length,experiments:compact},{spaces:2});
  if (isFirst) { console.log('Seed', compact.length); return; }
  if (!(diff.added.length||diff.changed.length||diff.removed.length)) { console.log('No significant % change'); return; }
  if (!WEBHOOK) { console.warn('No webhook'); return; }
  const sent=await postWebhook(buildEmbeds(diff,{sources}));
  console.log('Webhook', sent.status, sent.ok?'OK':sent.text);
  console.log('✅ Done');
}

if (require.main===module) main().catch(e=>{console.error(e);process.exit(1);});
module.exports={main,murmur3,intervalsToPct,diffExperiments};
