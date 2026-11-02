// Hakee Sähkötilanne-dashboardin datan ja kirjoittaa sen tiedostoon site/data.json.
// Ajetaan GitHub Actionsissa. Vaatii ympäristömuuttujan FINGRID_API_KEY.
// Node 20+ (sisäänrakennettu fetch).
import { readFile, writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.FINGRID_API_KEY;
const OUT_DIR = process.env.OUT_DIR || "site";
const HIST_FILE = process.env.HIST_FILE || "cache/history.json";
const FG = "https://data.fingrid.fi/api";
const TZ = "Europe/Helsinki";

// Fingridin aineistot
const RT = [192,193,194,181,188,191,201,202,177,209,265,266,87,89,180,187]; // reaaliaikaiset, 3 min
const FC = [245,248,166,268,267];                                           // ennusteet + tuulikapasiteetti
const RES = [317,318,52,51,244,106,319];                                  // reservit ja säätö
const HIST = [124,74,75];                                                 // kulutus, tuotanto, tuuli (15 min / 1 h)
const HIST_YEARS = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function fg(ids, start, end){
  if(!KEY) throw new Error("FINGRID_API_KEY puuttuu");
  let rows = [], page = 1;
  for(;;){
    const q = new URLSearchParams({ datasets: ids.join(","), startTime: start.toISOString(), endTime: end.toISOString(),
      format: "json", pageSize: "20000", page: String(page), sortBy: "startTime", sortOrder: "asc" });
    let r;
    for(let attempt = 0; attempt < 4; attempt++){
      const wait = 3000 - (Date.now() - lastCall); if(wait > 0) await sleep(wait);   // raja 1 pyyntö / 2 s, pidetään väljyyttä
      lastCall = Date.now();
      r = await fetch(`${FG}/data?${q}`, { headers: { "x-api-key": KEY } });
      if(r.status !== 429) break;
      const retry = +(r.headers.get("retry-after") || 0);
      console.warn(`Fingrid 429, yritetään uudelleen (${attempt + 1})`);
      await sleep(Math.max(retry * 1000, 3000) * (attempt + 1));
    }
    if(!r.ok) throw new Error(`Fingrid ${r.status}: ${(await r.text()).slice(0,200)}`);
    const j = await r.json();
    rows = rows.concat(Array.isArray(j) ? j : (j.data || []));
    const got = (Array.isArray(j) ? j : (j.data || [])).length;
    const p = j.pagination || {};
    if(page === 1 && got >= 20000) console.log("Fingrid-sivutus:", JSON.stringify(p));
    // Seuraava sivu, jos API kertoo sellaisen olevan tai sivu tuli täyteen
    if((p.nextPage || got >= 20000) && page < 20) page = p.nextPage || page + 1; else break;
  }
  const by = {};
  for(const x of rows){
    const id = x.datasetId; const t = Date.parse(x.startTime);
    if(id == null || isNaN(t) || x.value == null) continue;
    (by[id] ||= []).push([t, Math.round(+x.value * 1000) / 1000]);
  }
  for(const id in by) by[id].sort((a,b) => a[0]-b[0]);
  return by;
}

async function prices(){
  const r = await fetch("https://api.porssisahko.net/v2/latest-prices.json");
  if(!r.ok) throw new Error(`porssisahko ${r.status}`);
  const j = await r.json();
  return (j.prices || []).map(p => [Date.parse(p.startDate), Date.parse(p.endDate) + 1, p.price]).sort((a,b)=>a[0]-b[0]);
}

// Nord Poolin REMIT UMM -ilmoitukset: tuotannon ja siirron rajoitukset Suomessa
async function umm(){
  const base = "https://ummapi.nordpoolgroup.com/messages";
  const urls = [`${base}?limit=100&areas=10YFI-1--------U&fuelTypes=14`, `${base}?limit=300&areas=10YFI-1--------U`];
  const seen = new Map();
  for(const u of urls){
    const r = await fetch(u); if(!r.ok) throw new Error(`UMM ${r.status}`);
    for(const m of (await r.json()).items || []) seen.set(m.messageId, m);
  }
  const now = Date.now(), from = now - 24*3600e3, to = now + 21*24*3600e3, out = [];
  for(const m of seen.values()){
    if(m.isOutdated || ![1,3].includes(m.messageType)) continue;
    const units = [...(m.generationUnits||[]), ...(m.productionUnits||[]), ...(m.transmissionUnits||[])];
    for(const u of units){
      if(u.areaName && u.areaName !== "FI" && m.messageType === 1) continue;
      if(m.messageType === 3 && !/\bFI\b/.test(u.name || "")) continue;   // vain Suomen rajayhteydet
      for(const p of u.timePeriods || []){
        const s = Date.parse(p.eventStart), e = Date.parse(p.eventStop);
        if(isNaN(s) || (e && e < from) || s > to) continue;
        const nuclear = u.fuelType === 14;
        if(!nuclear && (p.unavailableCapacity ?? 0) < 100) continue;
        out.push({
          id: m.messageId, kind: m.messageType === 3 ? "siirto" : (nuclear ? "ydin" : "tuotanto"),
          unit: u.productionUnitName && u.name && u.productionUnitName !== u.name ? `${u.productionUnitName} (${u.name})` : (u.productionUnitName || u.name || "–"),
          installed: u.installedCapacity ?? u.productionUnitInstalledCapacity ?? null,
          unavailable: p.unavailableCapacity ?? null, available: p.availableCapacity ?? null,
          start: s, stop: e || null, reason: m.unavailabilityReason || "", planned: m.unavailabilityType === 2,
          publisher: m.publisherName || "", published: Date.parse(m.publicationDate)
        });
      }
    }
  }
  return out.sort((a,b) => a.start - b.start);
}

// Helsingin vuorokauden alku UTC-millisekunteina
function tzParts(ms){
  const f = new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  const o = {}; for(const p of f.formatToParts(new Date(ms))) o[p.type] = +p.value || p.value; return o;
}
function helsinkiMidnight(y, m, d){
  let guess = Date.UTC(y, m-1, d, 0, 0, 0);
  for(let i=0;i<2;i++){ const p = tzParts(guess); const asUtc = Date.UTC(p.year, p.month-1, p.day, p.hour, p.minute, p.second); guess -= asUtc - Date.UTC(y, m-1, d); }
  return guess;
}

async function history(){
  const p = tzParts(Date.now());
  const today = `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`;
  try { const c = JSON.parse(await readFile(HIST_FILE, "utf8")); if(c.date === today) return c; } catch {}
  const years = {};
  for(let k=1;k<=HIST_YEARS;k++){
    const y = p.year - k; const s = helsinkiMidnight(y, p.month, p.day), e = helsinkiMidnight(y, p.month, p.day + 1);
    try { years[y] = await fg(HIST, new Date(s), new Date(e)); } catch(err){ console.warn("historia", y, err.message); }
  }
  const h = { date: today, years };
  if(Object.keys(years).length === HIST_YEARS){   // välimuistiin vain täydellinen haku
    await mkdir(HIST_FILE.split("/").slice(0,-1).join("/") || ".", { recursive: true });
    await writeFile(HIST_FILE, JSON.stringify(h));
  }
  return h;
}

const out = { generated: Date.now(), errors: [] };
const step = async (name, fn) => { try { out[name] = await fn(); } catch(e){ out.errors.push(`${name}: ${e.message}`); console.error(name, e); } };
const now = new Date();
await step("prices", prices);
await step("umm", umm);
await step("rt", () => fg(RT, new Date(+now - 24*3600e3), now));
await step("fc", () => fg(FC, new Date(+now - 6*3600e3), new Date(+now + 48*3600e3)));
await step("res", () => fg(RES, new Date(+now - 12*3600e3), now));
await step("hist", history);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/data.json`, JSON.stringify(out));
console.log("data.json kirjoitettu", out.errors.length ? out.errors : "ilman virheitä");
