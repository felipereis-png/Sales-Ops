#!/usr/bin/env python3
"""Inbound Paid Attribution — horizontal flow, caixas com hachura, 2 filtros de canal."""

import json, os, requests

TOKEN = os.environ.get("HUBSPOT_TOKEN", "")
HDRS  = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
PIPE  = "282308322"

STAGE_MAP = {
    "459596268": "meeting",
    "459596269": "assessment",
    "471108325": "demo",
    "459596270": "proposal",
    "459596271": "verbal",
    "459596272": "verbal",   # contract → verbal
    "459596273": "won",
    "459596274": "lost",
}
STAGES    = ["meeting", "assessment", "demo", "proposal", "verbal", "won", "lost"]
STAGE_LBL = {"meeting":"Meet","assessment":"Assess","demo":"Demo",
              "proposal":"Proposal","verbal":"Verbal","won":"Won","lost":"Lost"}


def clean(s):
    if not s: return ""
    s = s.strip()
    return "" if "{{" in s else s

def resolve(cp):
    src = (cp.get("hs_analytics_source") or "").upper()
    s1  = (cp.get("hs_analytics_source_data_1") or "").strip()
    s2  = (cp.get("hs_analytics_source_data_2") or "").strip()
    ch  = (cp.get("paid_ad_channel") or "").lower()
    if ch == "google_ads" or src == "PAID_SEARCH":
        camp = clean(s1) if s1.lower() != "facebook" else clean(s2)
        return "Google Ads", camp or "Sem UTM"
    if ch == "meta" or src == "PAID_SOCIAL":
        camp = clean(s2)
        if camp and camp.lower() in ("facebook", "instagram"): camp = None
        return "Meta", camp or "Sem UTM"
    return None, None

def fetch_owners():
    r = requests.get("https://api.hubapi.com/crm/v3/owners?limit=250", headers=HDRS)
    out = {}
    for o in r.json().get("results", []):
        fn = (o.get("firstName") or "").strip()
        ln = (o.get("lastName") or "").strip()
        out[str(o["id"])] = (fn + " " + ln).strip() or o.get("email", "")
    return out

def fetch_deals():
    print("▸ Buscando deals…")
    url   = "https://api.hubapi.com/crm/v3/objects/deals/search"
    props = ["dealname","dealstage","pipeline","createdate","amount","hubspot_owner_id",
             "hs_analytics_source","hs_analytics_source_data_1",
             "hs_analytics_source_data_2","paid_ad_channel"]
    all_deals, after = [], None
    while True:
        body = {"filterGroups":[{"filters":[{"propertyName":"pipeline","operator":"EQ","value":PIPE}]}],
                "properties":props,"limit":100}
        if after: body["after"] = after
        r    = requests.post(url, headers=HDRS, json=body)
        data = r.json()
        all_deals.extend(data.get("results", []))
        after = data.get("paging",{}).get("next",{}).get("after")
        if not after: break
    print(f"  {len(all_deals)} deals")
    return all_deals

def fetch_contacts(deal_ids):
    if not deal_ids: return {}
    print("▸ Contatos…")
    assoc = {}
    for i in range(0, len(deal_ids), 100):
        r = requests.post(
            "https://api.hubapi.com/crm/v4/associations/deals/contacts/batch/read",
            headers=HDRS, json={"inputs":[{"id":str(x)} for x in deal_ids[i:i+100]]})
        for item in r.json().get("results", []):
            did = str(item.get("from",{}).get("id",""))
            tos = [str(t["toObjectId"]) for t in item.get("to",[])]
            if tos: assoc[did] = tos[0]
    cids = list(set(assoc.values()))
    if not cids: return {}
    print(f"  {len(cids)} contatos")
    cdata = {}
    props = ["firstname","lastname","company","hs_analytics_source",
             "hs_analytics_source_data_1","hs_analytics_source_data_2","paid_ad_channel"]
    for i in range(0, len(cids), 100):
        r = requests.post("https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
                          headers=HDRS,
                          json={"inputs":[{"id":c} for c in cids[i:i+100]],"properties":props})
        for item in r.json().get("results",[]):
            cdata[str(item["id"])] = item.get("properties",{})
    return {did: cdata[cid] for did,cid in assoc.items() if cid in cdata}

def main():
    owners   = fetch_owners()
    deals    = fetch_deals()
    contacts = fetch_contacts([d["id"] for d in deals])
    records  = []
    for d in deals:
        dp = d.get("properties", {})
        cp = contacts.get(d["id"], dp)
        ch, camp = resolve(cp)
        if not ch: continue
        stage   = STAGE_MAP.get(dp.get("dealstage",""), "unknown")
        created = (dp.get("createdate") or "")[:10]
        fn = (cp.get("firstname") or "").strip()
        ln = (cp.get("lastname") or "").strip()
        contact = (fn+" "+ln).strip() or (cp.get("company") or "")
        try:    amount = float(dp.get("amount") or 0)
        except: amount = 0.0
        records.append({"id":d["id"],"name":dp.get("dealname") or "","amount":amount,
                        "owner":owners.get(dp.get("hubspot_owner_id") or "",""),
                        "contact":contact,"channel":ch,"campaign":camp,
                        "stage":stage,"created":created})
    print(f"  {len(records)} inbound paid deals")
    out = "/Users/felipereiscosta/moveo-sales-ops/campaign_report.html"
    with open(out,"w",encoding="utf-8") as f:
        f.write(HTML.replace("__DATA__", json.dumps(records, ensure_ascii=False)))
    print(f"✅ {out}")


HTML = r"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inbound Paid — Attribution</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root {
  --bg:   #07090f;
  --s0:   #0d1117;
  --s1:   #131a26;
  --s2:   #1a2438;
  --bdr:  rgba(255,255,255,.07);
  --text: #cdd9e5;
  --t2:   #768390;
  --t3:   #3d4f63;
  --won:  #00c896;
  --lost: #ff5370;
}
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'Inter',-apple-system,sans-serif; background:var(--bg); color:var(--text);
       font-size:13px; min-height:100vh; -webkit-font-smoothing:antialiased; }

/* ── TOPBAR ── */
.topbar {
  position:sticky; top:0; z-index:100;
  background:var(--s0); border-bottom:1px solid var(--bdr);
  padding:0 24px; height:52px;
  display:flex; align-items:center; gap:14px;
}
.logo { font-size:13px; font-weight:700; letter-spacing:-.2px; white-space:nowrap; flex-shrink:0; }
.logo span { color:var(--t3); font-weight:400; }
.sep { width:1px; height:18px; background:var(--bdr); flex-shrink:0; }
.filters { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--t2); }
.filters label { font-weight:500; }
input[type=date] {
  background:var(--s1); border:1px solid var(--bdr); border-radius:7px;
  padding:5px 9px; font-size:12px; font-family:inherit; color:var(--text); color-scheme:dark;
}
input[type=date]:focus { outline:none; border-color:#388bff; }
.apply-btn {
  background:linear-gradient(135deg,#388bff,#6c63ff); color:#fff; border:none;
  border-radius:7px; padding:5px 14px; font-size:12px; font-family:inherit;
  font-weight:600; cursor:pointer; box-shadow:0 2px 10px rgba(56,139,255,.3);
  transition:all .15s; white-space:nowrap;
}
.apply-btn:hover { box-shadow:0 4px 20px rgba(56,139,255,.5); transform:translateY(-1px); }

/* channel tabs */
.tabs { display:flex; gap:2px; margin-left:auto; background:var(--s1); border-radius:9px; padding:3px; }
.tab {
  padding:5px 14px; border-radius:7px; font-size:12px; font-weight:500;
  cursor:pointer; color:var(--t2); transition:all .15s; white-space:nowrap; user-select:none;
}
.tab:hover { color:var(--text); }
.tab.active { background:var(--s2); color:var(--text); box-shadow:0 1px 4px rgba(0,0,0,.4); }
.tab.t-google.active { color:#388bff; }
.tab.t-meta.active   { color:#f472b6; }

/* ── KPI BAR ── */
.kpi-bar { background:var(--s0); border-bottom:1px solid var(--bdr); display:flex; padding:0 24px; }
.kpi { padding:11px 20px 9px; border-right:1px solid var(--bdr); }
.kpi:first-child { padding-left:0; }
.kpi:last-child  { border-right:none; }
.kv { font-size:21px; font-weight:800; letter-spacing:-.5px; line-height:1; }
.kl { font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.6px; color:var(--t3); margin-top:3px; }

/* ── VIZ ── */
.viz-wrap { padding:20px 24px; overflow-x:auto; }

/* column header row */
.col-headers { display:flex; align-items:center; padding-bottom:8px; }
.ch-sp   { flex-shrink:0; }
.ch-cell { flex-shrink:0; font-size:9.5px; font-weight:700; text-transform:uppercase;
           letter-spacing:.55px; color:var(--t3); text-align:center; }
.ch-cell.h-won  { color:rgba(0,200,150,.55); }
.ch-cell.h-lost { color:rgba(255,83,112,.45); }

/* pipeline */
.pipeline { display:flex; align-items:stretch; }

/* source node */
.src-wrap { display:flex; align-items:center; flex-shrink:0; }
.src-box {
  width:106px; background:var(--s1); border:1.5px solid rgba(255,255,255,.14);
  border-radius:10px; padding:10px 10px;
  display:flex; flex-direction:column; align-items:center; gap:2px; text-align:center;
}
.src-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px;
             color:var(--t2); line-height:1.35; }
.src-n     { font-size:28px; font-weight:800; letter-spacing:-1px; color:var(--text); line-height:1; }
.src-sub   { font-size:9px; text-transform:uppercase; letter-spacing:.5px; color:var(--t3); }
.h-conn { width:16px; height:1px; background:var(--bdr); flex-shrink:0; }
.v-bar  { width:1px; background:var(--bdr); align-self:stretch; flex-shrink:0; }

/* campaign rows */
.rows-area { display:flex; flex-direction:column; }
.camp-row  { display:flex; align-items:center; padding:5px 0; }
.stub { width:16px; height:1px; flex-shrink:0; }

/* campaign name box */
.camp-box {
  flex-shrink:0; height:48px; border:1.5px solid; border-radius:9px;
  display:flex; align-items:center; justify-content:center;
  padding:0 11px; gap:7px; cursor:default;
}
.camp-badge { font-size:9px; font-weight:700; padding:2px 5px; border-radius:4px; flex-shrink:0; letter-spacing:.3px; }
.camp-name-txt { font-size:11px; font-weight:600; overflow:hidden;
                 white-space:nowrap; text-overflow:ellipsis; max-width:105px; }

/* arrow */
.arr { flex-shrink:0; font-size:14px; width:18px; text-align:center; opacity:.4; }

/* stage box */
.sbox {
  flex-shrink:0; height:48px; border:1.5px solid; border-radius:9px;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:1px; cursor:default; position:relative; overflow:hidden;
  transition:transform .1s;
}
.sbox:hover { transform:translateY(-2px); z-index:5; }
.sbox .sn { font-size:18px; font-weight:700; line-height:1; position:relative; z-index:1; }
.sbox .sl { font-size:8.5px; font-weight:600; text-transform:uppercase; letter-spacing:.4px;
            opacity:.5; position:relative; z-index:1; }

/* won/lost always fixed colors */
.sbox.won-box          { border-color:rgba(0,200,150,.25); background:var(--s1); }
.sbox.lost-box         { border-color:rgba(255,83,112,.2);  background:var(--s1); }
.sbox.won-box  .sn     { color:var(--t3); }
.sbox.lost-box .sn     { color:var(--t3); }
.sbox.won-box  .sl     { color:var(--t3); }
.sbox.lost-box .sl     { color:var(--t3); }
.sbox.won-box.active   { border-color:rgba(0,200,150,.55);  background:rgba(0,200,150,.07); }
.sbox.lost-box.active  { border-color:rgba(255,83,112,.5);  background:rgba(255,83,112,.07); }
.sbox.won-box.active  .sn  { color:var(--won); }
.sbox.lost-box.active .sn  { color:var(--lost); }
.sbox.won-box.active  .sl  { color:var(--won); }
.sbox.lost-box.active .sl  { color:var(--lost); }

/* empty (zero) boxes */
.sbox.empty { border-color:rgba(255,255,255,.06); background:var(--s1); }
.sbox.empty .sn { color:var(--t3); font-size:14px; }
.sbox.empty .sl { color:var(--t3); }

/* ── TOOLTIP ── */
#tt {
  position:fixed; z-index:9999;
  background:var(--s2); border:1px solid rgba(255,255,255,.13);
  border-radius:12px; padding:14px 16px;
  width:272px; max-height:330px; overflow:hidden;
  box-shadow:0 12px 40px rgba(0,0,0,.75);
  pointer-events:none; opacity:0; transition:opacity .1s;
}
#tt.vis { opacity:1; }
.tt-hd   { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:var(--t2); margin-bottom:10px; }
.tt-list { display:flex; flex-direction:column; gap:6px; overflow-y:auto; max-height:300px; }
.tt-item { border-bottom:1px solid var(--bdr); padding-bottom:6px; }
.tt-item:last-child { border-bottom:none; padding-bottom:0; }
.tt-dn   { font-size:12px; font-weight:600; color:var(--text); margin-bottom:4px; line-height:1.3; }
.tt-row  { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--t2); }
.tt-own  { color:#cdd9e5; }
.tt-amt  { color:var(--won); font-weight:600; margin-left:auto; }
.tt-date { color:var(--t2); }
.tt-sep  { color:var(--t3); }
.tt-more { font-size:11px; color:var(--t3); margin-top:5px; }
.empty-v { padding:48px; text-align:center; color:var(--t3); font-size:14px; }
</style>
</head>
<body>

<div class="topbar">
  <span class="logo">Inbound Paid <span>/ Attribution</span></span>
  <div class="sep"></div>
  <div class="filters">
    <label>De</label><input type="date" id="fd">
    <label>Até</label><input type="date" id="td">
    <button class="apply-btn" onclick="render()">Aplicar</button>
  </div>
  <div class="tabs">
    <div class="tab t-google active" data-ch="Google Ads" onclick="setCh(this,'Google Ads')">Google Ads</div>
    <div class="tab t-meta"          data-ch="Meta"       onclick="setCh(this,'Meta')">Meta Ads</div>
  </div>
</div>

<div class="kpi-bar" id="kpis"></div>

<div class="viz-wrap" id="viz">
  <div class="empty-v">Carregando…</div>
</div>

<div id="tt"></div>

<script>
const ALL    = __DATA__;
const STAGES = ["meeting","assessment","demo","proposal","verbal","won","lost"];
const SL     = {meeting:"Meet",assessment:"Assess",demo:"Demo",
                proposal:"Proposal",verbal:"Verbal",won:"Won",lost:"Lost"};

const PALETTE = ['#388bff','#a78bfa','#38d9f5','#ffb347','#f472b6','#fb923c','#34d399','#f87171','#60a5fa','#c084fc'];

function rowColor(name) {
  let h = 0;
  for (const c of name) h = ((h << 5) - h + c.charCodeAt(0)) & 0xffffffff;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
function hexRgba(hex, a) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}
function fmtAmt(n) { return (n&&n>0)?'R$ '+Number(n).toLocaleString('pt-BR',{maximumFractionDigits:0}):null; }
function esc(s)    { return s.replace(/'/g,"\\x27"); }

function cleanName(raw) {
  if (!raw || raw === 'Sem UTM') return raw || 'Sem UTM';
  let s = raw;

  // URLs e userId viram "Sem UTM"
  if (/\.ai\/|\.com\/|^https?:\/\//i.test(s) || /^userId:/i.test(s)) return 'Sem UTM';

  s = s.replace(/_/g, ' ');

  // Extrai conteúdo FORA dos colchetes
  let outside = s.replace(/\[[^\]]*\]/g, ' ')
                  .replace(/\s*[–—-]\s*/g, ' · ')
                  .replace(/(\s*·\s*)+/g, ' · ')
                  .replace(/\s+/g, ' ').trim()
                  .replace(/^[\s·]+|[\s·]+$/g, '');

  // Se sobrou conteúdo real (não só data/número), usa
  if (outside && !/^[\d\/\-\s]+$/.test(outside)) {
    return outside[0].toUpperCase() + outside.slice(1);
  }

  // Fallback: conteúdo dentro de colchetes, descartando códigos curtos e datas
  const tags = [...s.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
  const good = tags.filter(t =>
    t.length > 3 &&
    !/^[a-z]{1,3}\d{0,4}$/i.test(t) &&   // br, cx, cvs, jul25
    !/^\d{4,}/.test(t)                      // 0825, 092025
  );
  if (good.length) {
    const r = good[good.length - 1];
    return r[0].toUpperCase() + r.slice(1);
  }

  // Último recurso: remove colchetes e limpa
  const r = s.replace(/\[[^\]]*\]/g, '').replace(/[-·]/g, ' ').replace(/\s+/g, ' ').trim();
  return r ? r[0].toUpperCase() + r.slice(1) : raw;
}

// funil de corte: ordem cumulativa das etapas (exceto lost)
const FUNNEL  = ["meeting","assessment","demo","proposal","verbal","won"];
const FUNNELI = {};
FUNNEL.forEach((s,i) => FUNNELI[s] = i);

// tabs: default = Google Ads
let CH = 'Google Ads';
const DMAP = {};
for (const d of ALL) DMAP[d.id] = d;

// box sizing constants
const CAMP_W = 156, BOX_W = 66, ARR_W = 18, SRC_W = 106, HCONN = 16, VBAR = 1, STUB = 16;
const HDR_PAD = SRC_W + HCONN + VBAR + STUB + CAMP_W + ARR_W;

function setCh(el, c) {
  // toggle: click active tab → deselect (show all)
  if (CH === c) {
    CH = 'all';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  } else {
    CH = c;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.ch === c));
  }
  render();
}

function render() {
  const from = document.getElementById('fd').value;
  const to   = document.getElementById('td').value;

  const deals = ALL.filter(d => {
    if (from && d.created < from) return false;
    if (to   && d.created > to  ) return false;
    if (CH !== 'all' && d.channel !== CH) return false;
    return true;
  });

  // agregação cumulativa — funil de corte
  const map = {};
  for (const d of deals) {
    const k = d.channel + '||' + d.campaign;
    if (!map[k]) map[k] = { ch:d.channel, name:d.campaign, ids:[], s:{} };
    map[k].ids.push(d.id);  // Deals = todos

    if (d.stage === 'lost') {
      // lost não cascateia para trás
      if (!map[k].s.lost) map[k].s.lost = [];
      map[k].s.lost.push(d.id);
    } else {
      const si = FUNNELI[d.stage] ?? -1;
      if (si >= 0) {
        // conta o deal em TODAS as etapas até a atual
        for (let i = 0; i <= si; i++) {
          const s = FUNNEL[i];
          if (!map[k].s[s]) map[k].s[s] = [];
          map[k].s[s].push(d.id);
        }
      }
    }
  }
  const rows = Object.values(map).sort((a,b) => b.ids.length - a.ids.length);

  // KPIs
  const won = deals.filter(d => d.stage==='won').length;
  const wr  = deals.length ? Math.round(won/deals.length*100) : 0;
  document.getElementById('kpis').innerHTML = `
    <div class="kpi"><div class="kv">${deals.length}</div><div class="kl">Inbound Paid</div></div>
    <div class="kpi"><div class="kv" style="color:#388bff">${deals.filter(d=>d.channel==='Google Ads').length}</div><div class="kl">Google Ads</div></div>
    <div class="kpi"><div class="kv" style="color:#f472b6">${deals.filter(d=>d.channel==='Meta').length}</div><div class="kl">Meta</div></div>
    <div class="kpi"><div class="kv">${rows.length}</div><div class="kl">Campanhas</div></div>
    <div class="kpi"><div class="kv" style="color:var(--won)">${won}</div><div class="kl">Won</div></div>
    <div class="kpi"><div class="kv">${wr}%</div><div class="kl">Win Rate</div></div>
  `;

  if (!rows.length) {
    document.getElementById('viz').innerHTML = '<div class="empty-v">Nenhum deal no período.</div>';
    return;
  }

  // column headers
  let hdr = `<div class="col-headers">
    <div class="ch-sp" style="width:${HDR_PAD}px"></div>
    <div class="ch-cell" style="width:${BOX_W}px">Deals</div>`;
  STAGES.forEach(s => {
    const cls = s==='won' ? ' h-won' : s==='lost' ? ' h-lost' : '';
    hdr += `<div class="ch-sp" style="width:${ARR_W}px"></div>
            <div class="ch-cell${cls}" style="width:${BOX_W}px">${SL[s]}</div>`;
  });
  hdr += `</div>`;

  // rows
  let rowsHtml = '';
  for (const r of rows) {
    const color   = rowColor(r.name);
    const colorBg = hexRgba(color, .08);
    const colorBd = hexRgba(color, .5);
    const clsCh   = r.ch === 'Google Ads' ? 'ch-g' : 'ch-m';
    const chTag   = r.ch === 'Google Ads' ? 'G' : 'M';
    const chBg    = r.ch === 'Google Ads' ? 'rgba(56,139,255,.12)' : 'rgba(244,114,182,.12)';
    const chColor = r.ch === 'Google Ads' ? '#388bff' : '#f472b6';

    // total (deals) box
    const totHtml = makeBox(r.ids.length, color, colorBg, colorBd, 'Deals', r.ids, 'Deals');

    // camp box
    rowsHtml += `<div class="camp-row">
      <div class="stub" style="background:${color}"></div>
      <div class="camp-box" style="width:${CAMP_W}px; border-color:${colorBd}; background:${colorBg}; color:${color}">
        <span class="camp-badge" style="background:${chBg}; color:${chColor}">${chTag}</span>
        <span class="camp-name-txt" title="${r.name}">${cleanName(r.name)}</span>
      </div>
      <div class="arr" style="color:${color}">›</div>
      ${totHtml}`;

    for (const s of STAGES) {
      const ids    = r.s[s] || [];
      const n      = ids.length;
      const isWon  = s === 'won';
      const isLost = s === 'lost';
      const html   = (isWon || isLost)
        ? makeFixedBox(n, isWon ? 'won-box' : 'lost-box', SL[s], ids)
        : makeBox(n, color, colorBg, colorBd, SL[s], ids, SL[s]);
      rowsHtml += `<div class="arr" style="color:${color}">›</div>${html}`;
    }
    rowsHtml += `</div>`;
  }

  document.getElementById('viz').innerHTML = hdr + `
    <div class="pipeline">
      <div class="src-wrap">
        <div class="src-box">
          <div class="src-label">Inbound<br>Paid</div>
          <div class="src-n">${deals.length}</div>
          <div class="src-sub">deals</div>
        </div>
        <div class="h-conn"></div>
      </div>
      <div class="v-bar"></div>
      <div class="rows-area">${rowsHtml}</div>
    </div>`;
}

function makeBox(n, color, colorBg, colorBd, label, ids, ttStage) {
  const has  = n > 0;
  const cls  = has ? '' : ' empty';
  const styl = has ? `border-color:${colorBd}; background:${colorBg};` : '';
  const nc   = has ? `color:${color};` : '';
  return `<div class="sbox${cls}" style="width:${BOX_W}px; ${styl}"
    onmouseenter="showTt(event,'${esc(ttStage)} — ${n} deal${n!==1?'s':''}',${JSON.stringify(ids).replace(/"/g,"'")})"
    onmouseleave="hideTt()">
    <span class="sn" style="${nc}">${n}</span>
    <span class="sl" style="${nc}">${label}</span>
  </div>`;
}

function makeFixedBox(n, cls, label, ids) {
  const ac = n > 0 ? ' active' : ' empty';
  return `<div class="sbox ${cls}${ac}" style="width:${BOX_W}px"
    onmouseenter="showTt(event,'${esc(label)} — ${n} deal${n!==1?'s':''}',${JSON.stringify(ids).replace(/"/g,"'")})"
    onmouseleave="hideTt()">
    <span class="sn">${n}</span>
    <span class="sl">${label}</span>
  </div>`;
}

// ── tooltip ──────────────────────────────────────────────────────────────────
const TT = document.getElementById('tt');
let ttT  = null;

function showTt(e, title, ids) {
  clearTimeout(ttT);
  if (!ids || !ids.length) return;
  const shown = ids.slice(0,8), more = ids.length-8;
  const items = shown.map(id => {
    const d = DMAP[id]; if (!d) return '';
    const a   = fmtAmt(d.amount);
    const dt  = d.created ? d.created.slice(0,10).split('-').reverse().join('/') : '';
    return `<div class="tt-item">
      <div class="tt-dn">${d.name||'Deal #'+id}</div>
      <div class="tt-row">
        ${d.owner ? `<span class="tt-own">👤 ${d.owner}</span>` : ''}
        ${dt      ? `<span class="tt-sep">·</span><span class="tt-date">📅 ${dt}</span>` : ''}
        ${a       ? `<span class="tt-amt">${a}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  TT.innerHTML = `<div class="tt-hd">${title}</div>
    <div class="tt-list">${items}${more>0?`<div class="tt-more">+${more} mais…</div>`:''}</div>`;
  posTt(e); TT.classList.add('vis');
}
function hideTt() { ttT = setTimeout(() => TT.classList.remove('vis'), 80); }
function posTt(e) {
  const W=window.innerWidth, H=window.innerHeight;
  let x=e.clientX+14, y=e.clientY+14;
  if (x+272>W-8) x=e.clientX-272-14;
  if (y+330>H-8) y=e.clientY-330-14;
  TT.style.left=x+'px'; TT.style.top=y+'px';
}
document.addEventListener('mousemove', e => { if(TT.classList.contains('vis')) posTt(e); });

// init defaults
const now=new Date(), y=now.getFullYear(), mo=String(now.getMonth()+1).padStart(2,'0');
document.getElementById('fd').value=`${y}-${mo}-01`;
document.getElementById('td').value=now.toISOString().slice(0,10);
render();
</script>
</body>
</html>"""

if __name__ == '__main__':
    main()
