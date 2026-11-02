// Yhteiset apufunktiot alasivuille (Kaksoispäivä, Mitä jos, Verkon ääni)
"use strict";
const $ = id => document.getElementById(id);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmt = (v,d=0) => v==null||isNaN(v) ? "–" : v.toLocaleString("fi-FI",{minimumFractionDigits:d,maximumFractionDigits:d});
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pad = n => String(n).padStart(2,"0");
const fiDate = (iso, opt={day:"numeric",month:"numeric",year:"numeric"}) => { const [y,m,d]=iso.split("-").map(Number); return new Date(y,m-1,d).toLocaleDateString("fi-FI",opt); };
const sum = a => a.reduce((x,y)=>x+y,0);
const mean = a => a.length ? sum(a)/a.length : null;

function niceTicks(a,b,n){
  const span=b-a; if(!(span>0)) return [a];
  const raw=span/n, mag=10**Math.floor(Math.log10(raw)), st=[1,2,2.5,5,10].map(m=>m*mag).find(s=>s>=raw);
  const out=[]; for(let v=Math.ceil(a/st)*st; v<=b+1e-9; v+=st) out.push(+v.toFixed(6)); return out;
}
// Yleinen kehys: x on mikä tahansa luku. xticks: [{x, label}]
function frame(el, h, x0, x1, y0, y1, {left=46, xticks=[], yd=0}={}){
  const W=Math.max(320, Math.round(el.clientWidth||600)), H=h, L=left, R=10, T=10, B=24;
  const sx=x=>L+(x-x0)/(x1-x0)*(W-L-R), sy=v=>T+(1-(v-y0)/(y1-y0))*(H-T-B);
  let g="";
  for(const v of niceTicks(y0,y1,4)) g+=`<line x1="${L}" x2="${W-R}" y1="${sy(v)}" y2="${sy(v)}" stroke="${css("--grid")}"/><text x="${L-6}" y="${sy(v)+4}" text-anchor="end">${fmt(v,yd)}</text>`;
  for(const t of xticks) g+=`<line x1="${sx(t.x)}" x2="${sx(t.x)}" y1="${T}" y2="${H-B}" stroke="${css("--grid")}" stroke-dasharray="2 3"/><text x="${sx(t.x)}" y="${H-6}" text-anchor="middle">${t.label}</text>`;
  return {W,H,L,R,T,B,sx,sy,g};
}
const pathOf = (f, pts) => pts.map((p,i)=>`${i?"L":"M"}${f.sx(p.x).toFixed(1)},${f.sy(p.y).toFixed(1)}`).join("");

const _cache = new Map();
function getJSON(url){
  if(!_cache.has(url)) _cache.set(url, fetch(url+(url.includes("?")?"&":"?")+"t="+Math.floor(Date.now()/36e5)).then(r=>r.ok?r.json():null).catch(()=>null));
  return _cache.get(url);
}
async function loadDaily(){
  const j = await getJSON("archive/daily.json"); if(!j) return [];
  return j.rows.map(r => Object.fromEntries(j.cols.map((c,i)=>[c,r[i]])));
}
// Kuukauden tuntirivit {t, cons, prod, wind, nuc, hyd, chp, ind, net, price}
async function loadMonthRows(key){
  const m = await getJSON(`archive/${key}.json`); if(!m) return [];
  return Array.from({length:m.hours},(_,i)=>{ const r={t:m.start+i*3600e3}; for(const k in m.s) r[k]=m.s[k][i]; return r; });
}
