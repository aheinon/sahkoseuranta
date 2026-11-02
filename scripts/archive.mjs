// Rakentaa historia-arkiston: yksi tiedosto kuukautta kohden, tuntikeskiarvot.
// site/archive/YYYY-MM.json ja site/archive/index.json
//
// Käyttö:
//   node scripts/archive.mjs                 → kuluva ja edellinen kuukausi (päivittäinen ajo)
//   node scripts/archive.mjs 2015-01         → kaikki puuttuvat kuukaudet 2015-01 alkaen + 2 viimeisintä
//   node scripts/archive.mjs 2015-01 force   → kaikki kuukaudet uudelleen
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const KEY = process.env.FINGRID_API_KEY;
const DIR = process.env.ARCHIVE_DIR || "site/archive";
const TZ = "Europe/Helsinki";
const FG = "https://data.fingrid.fi/api";

// sarja → Fingridin aineisto. net: aineisto 194 on vienti positiivisena, tallennetaan tuontina.
const SERIES = { cons:124, prod:74, wind:75, nuc:188, hyd:191, chp:201, ind:202, net:194 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0, calls = 0;

async function fg(ids, start, end){
  if(!KEY) throw new Error("FINGRID_API_KEY puuttuu");
  let rows = [], page = 1;
  for(;;){
    const q = new URLSearchParams({ datasets: ids.join(","), startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(),
      format: "json", pageSize: "20000", page: String(page), sortBy: "startTime", sortOrder: "asc" });
    let r;
    for(let a = 0; a < 5; a++){
      const wait = 3000 - (Date.now() - lastCall); if(wait > 0) await sleep(wait);
      lastCall = Date.now(); calls++;
      r = await fetch(`${FG}/data?${q}`, { headers: { "x-api-key": KEY } });
      if(r.status !== 429 && r.status < 500) break;
      await sleep(5000 * (a + 1));
    }
    if(!r.ok) throw new Error(`Fingrid ${r.status}: ${(await r.text()).slice(0,200)}`);
    const j = await r.json();
    rows = rows.concat(Array.isArray(j) ? j : (j.data || []));
    const got = (Array.isArray(j) ? j : (j.data || [])).length;
    const p = j.pagination || {};
    if(page === 1 && got >= 20000) console.log("Fingrid-sivutus:", JSON.stringify(p));
    // Seuraava sivu, jos API kertoo sellaisen olevan tai sivu tuli täyteen
    if((p.nextPage || got >= 20000) && page < 40) page = p.nextPage || page + 1; else break;
  }
  return rows;
}

async function prices(start, end){
  const q = new URLSearchParams({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  const r = await fetch(`https://sahkotin.fi/prices?${q}`);
  if(!r.ok) throw new Error(`sahkotin ${r.status}`);
  return ((await r.json()).prices || []).map(p => [Date.parse(p.date), p.value]);
}

const TZF = new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
function tzParts(ms){
  const o = {}; for(const p of TZF.formatToParts(new Date(ms))) o[p.type] = +p.value; return o;
}
function helsinkiMidnight(y, m, d){
  let g = Date.UTC(y, m-1, d);
  for(let i=0;i<2;i++){ const p = tzParts(g); g -= Date.UTC(p.year, p.month-1, p.day, p.hour, p.minute, p.second) - Date.UTC(y, m-1, d); }
  return g;
}
const ym = (y, m) => `${y}-${String(m).padStart(2,"0")}`;

function hourly(points, start, n){
  const sum = new Float64Array(n), cnt = new Uint16Array(n);
  for(const [t, v] of points){ const h = Math.floor((t - start) / 3600e3); if(h >= 0 && h < n && v != null && !isNaN(v)){ sum[h] += v; cnt[h]++; } }
  return Array.from(sum, (s, i) => cnt[i] ? s / cnt[i] : null);
}

async function buildMonth(y, m){
  const start = helsinkiMidnight(y, m, 1), end = helsinkiMidnight(m === 12 ? y+1 : y, m === 12 ? 1 : m+1, 1);
  const n = Math.round((end - start) / 3600e3);
  const ids = Object.values(SERIES);
  const by = {};
  for(const x of await fg(ids, start, end)) (by[x.datasetId] ||= []).push([Date.parse(x.startTime), +x.value]);
  const s = {};
  for(const [k, id] of Object.entries(SERIES)){
    let h = hourly(by[id] || [], start, n);
    if(k === "net") h = h.map(v => v == null ? null : -v);
    s[k] = h.map(v => v == null ? null : Math.round(v));
  }
  try { s.price = hourly(await prices(start, end), start, n).map(v => v == null ? null : Math.round(v * 100) / 100); }
  catch(e){ console.warn(ym(y,m), "hinnat:", e.message); s.price = Array(n).fill(null); }
  const filled = Object.fromEntries(Object.entries(s).map(([k, a]) => [k, a.filter(v => v != null).length]));
  return { month: ym(y, m), start, hours: n, built: Date.now(), filled, s };
}

// --- ajo ---
const [fromArg, mode] = process.argv.slice(2);
await mkdir(DIR, { recursive: true });
const existing = new Set((await readdir(DIR)).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)));

const now = tzParts(Date.now());
const months = [];
const [fy, fm] = fromArg ? fromArg.split("-").map(Number) : (now.month === 1 ? [now.year-1, 12] : [now.year, now.month-1]);
for(let y = fy, m = fm; y < now.year || (y === now.year && m <= now.month); m === 12 ? (y++, m = 1) : m++) months.push([y, m]);

const recent = new Set(months.slice(-2).map(([y, m]) => ym(y, m)));
const todo = process.env.ARCHIVE_DAILY_ONLY ? [] : months.filter(([y, m]) => mode === "force" || recent.has(ym(y, m)) || !existing.has(ym(y, m)));
console.log(`Kuukausia ${months.length}, haetaan ${todo.length}`);

let fails = 0;
for(const [y, m] of todo){
  try {
    const d = await buildMonth(y, m);
    await writeFile(`${DIR}/${d.month}.json`, JSON.stringify(d));
    existing.add(d.month);
    console.log(d.month, JSON.stringify(d.filled), `pyyntöjä yht. ${calls}`);
  } catch(e){ fails++; console.error(ym(y, m), e.message); if(fails > 5) break; }
}

const list = [...existing].sort();
await writeFile(`${DIR}/index.json`, JSON.stringify({ updated: Date.now(), months: list }));
console.log(`index.json: ${list.length} kuukautta, ${list[0]} – ${list[list.length-1]}`);

// Päivätason tiivistelmä koko arkistosta (Kaksoispäivä, Verkon ääni)
// Kentät: d päivä, c kulutus, w tuuli, n ydin, h vesi, x CHP (kaukolämpö+teollisuus), i nettotuonti (MW, ka),
//         p hinta ka, pmax, pmin (€/MWh alv 0), k kattavuus (tunteja kulutusdatalla)
const days = new Map();
for(const key of list){
  let m; try { m = JSON.parse(await readFile(`${DIR}/${key}.json`, "utf8")); } catch { continue; }
  for(let i = 0; i < m.hours; i++){
    const p = tzParts(m.start + i * 3600e3);
    const d = `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`;
    if(!days.has(d)) days.set(d, { d, acc: {}, k: 0, pmax: -Infinity, pmin: Infinity });
    const o = days.get(d), s = m.s;
    const x = s.chp[i] != null || s.ind[i] != null ? (s.chp[i] || 0) + (s.ind[i] || 0) : null;
    const vals = { c: s.cons[i], w: s.wind[i], n: s.nuc[i], h: s.hyd[i], x, i: s.net[i], p: s.price[i] };
    for(const [f, v] of Object.entries(vals)) if(v != null){ (o.acc[f] ||= [0, 0]); o.acc[f][0] += v; o.acc[f][1]++; }
    if(s.cons[i] != null) o.k++;
    if(s.price[i] != null){ o.pmax = Math.max(o.pmax, s.price[i]); o.pmin = Math.min(o.pmin, s.price[i]); }
  }
}
const daily = [...days.values()].filter(o => o.k >= 12).sort((a, b) => a.d < b.d ? -1 : 1).map(o => {
  const r = { d: o.d, k: o.k };
  for(const f of ["c","w","n","h","x","i"]) r[f] = o.acc[f] ? Math.round(o.acc[f][0] / o.acc[f][1]) : null;
  r.p = o.acc.p ? Math.round(o.acc.p[0] / o.acc.p[1] * 10) / 10 : null;
  r.pmax = isFinite(o.pmax) ? Math.round(o.pmax) : null; r.pmin = isFinite(o.pmin) ? Math.round(o.pmin) : null;
  return r;
});
// sarakemuoto pienentää tiedostoa
const cols = ["d","c","w","n","h","x","i","p","pmax","pmin","k"];
await writeFile(`${DIR}/daily.json`, JSON.stringify({ updated: Date.now(), cols, rows: daily.map(r => cols.map(c => r[c])) }));
console.log(`daily.json: ${daily.length} päivää`);
if(fails) process.exitCode = 1;
