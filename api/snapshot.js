/**
 * Vercel Serverless Function — GET /api/snapshot
 * Busca dados do HubSpot em tempo real, aplica transformações e retorna JSON.
 *
 * Cache: s-maxage=300 (5 min CDN Vercel) + stale-while-revalidate=60
 */

// ── Constantes (espelho de engine/config.py) ──────────────────────────────────

const PIPELINE_ID = process.env.PIPELINE_ID || "282308322";
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || "";


const STAGE_MAP = {
  "459596268": "Meeting Scheduled",
  "459596269": "Assessment",
  "471108325": "Product Demo",
  "459596270": "Commercial Proposal",
  "463614440": "POC",
  "459596271": "Verbal Agreement",
  "459596272": "Contract Sent",
  "459596273": "Deal Won",
  "459596274": "Deal Lost",
  "2253279444": "Deal Churned",
};

const STAGE_ORDER = [
  "459596268", "459596269", "471108325",
  "459596270", "463614440", "459596271", "459596272",
];
const WON_STAGE   = "459596273";
const LOST_STAGE  = "459596274";
const CHURN_STAGE = "2253279444";

const STAGE_PROBABILITY = {
  "459596268": 0.10, "459596269": 0.20, "471108325": 0.40,
  "459596270": 0.60, "463614440": 0.70, "459596271": 0.80, "459596272": 0.90,
  "459596273": 1.00, "459596274": 0.00, "2253279444": 0.00,
};

const PRICE_FALLBACK = {
  pro: 2000, standard: 2490, growth: 3225, enterprise: 5000, custom: 10000,
};
const PRICE_FALLBACK_DEFAULT = 3225;
const ENTERPRISE_THRESHOLD = 5000;

const DEAL_PROPERTIES = [
  // Básicos
  "dealname","dealstage","pipeline","amount","closedate","createdate",
  "hs_lastmodifieddate","hubspot_owner_id","hs_deal_stage_probability","hs_forecast_amount",
  // Origem e plano
  "deal_source_moveo","origem","type_of_plan","industry__segmento_","use_case","partner",
  // Perda e métricas
  "lost_reason","lost_type","days_to_close","expected_no_of_sessions","pre_sales_responsible",
  // Datas de estágio CUSTOM (campos Moveo — mais confiáveis que hs_date_entered_*)
  "entry_on_assesment___demo",
  "entry_on_demo_stage",
  "entry_on_proposal",
  "entry_on_verbal_agrement",
  "entry_on_contract_stage",
  "entry_on_win_stage",
  "entry_on_lost_stage",
  // Datas de estágio padrão HubSpot (fallback)
  "hs_date_entered_459596268","hs_date_entered_459596269",
  "hs_date_entered_471108325","hs_date_entered_459596270",
  "hs_date_entered_459596271","hs_date_entered_459596272",
  "hs_date_entered_459596273","hs_date_entered_459596274",
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const HEADERS = () => ({
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
});

async function hsRequest(fn, retries = 2) {
  for (let i = 0; i < retries; i++) {
    const r = await fn();
    if (r.status === 429) {
      const wait = parseInt(r.headers.get("Retry-After") || "3") * 1000;
      await new Promise(res => setTimeout(res, Math.min(wait, 4000))); // max 4s de espera
      continue;
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(`HubSpot ${r.status}: ${body?.message || r.url}`);
    }
    return r.json();
  }
  throw new Error("HubSpot rate limit após retries");
}

async function hsPost(path, body) {
  return hsRequest(() => fetch(`https://api.hubapi.com${path}`, {
    method: "POST", headers: HEADERS(), body: JSON.stringify(body),
  }));
}

async function hsGet(path) {
  return hsRequest(() => fetch(`https://api.hubapi.com${path}`, { headers: HEADERS() }));
}

// ── Fetch all deals (paginado) ────────────────────────────────────────────────

async function fetchAllDeals() {
  const deals = [];
  let after = null;
  while (true) {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: "pipeline", operator: "EQ", value: PIPELINE_ID }
      ]}],
      properties: DEAL_PROPERTIES,
      limit: 200,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      ...(after ? { after } : {}),
    };
    const data = await hsPost("/crm/v3/objects/deals/search", body);
    deals.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return deals;
}

async function fetchOwners() {
  const data = await hsGet("/crm/v3/owners?limit=200");
  const map = {};
  for (const o of data.results || []) {
    map[String(o.id)] = {
      name: `${o.firstName || ""} ${o.lastName || ""}`.trim() || o.email || String(o.id),
      email: o.email || "",
    };
  }
  return map;
}

// ── Transformações ────────────────────────────────────────────────────────────

function resolveAmount(props) {
  const raw = parseFloat(props.amount || "0") || 0;
  if (raw <= 1) {
    const plan = (props.type_of_plan || "").toLowerCase();
    let matched = null;
    for (const key of Object.keys(PRICE_FALLBACK)) {
      if (plan.includes(key) || key.includes(plan)) { matched = key; break; }
    }
    return [PRICE_FALLBACK[matched] ?? PRICE_FALLBACK_DEFAULT, true];
  }
  return [raw, false];
}

function resolveSegment(amount, props) {
  const plan = (props.type_of_plan || "").toLowerCase();
  return (amount >= ENTERPRISE_THRESHOLD || plan.includes("enterprise") || plan.includes("custom"))
    ? "Enterprise" : "Growth";
}

function resolveSource(props) {
  const rawOrigem = (props.origem || "").trim();
  const rawMoveo  = (props.deal_source_moveo || "").trim();

  // `origem` é a fonte certa para Partners / Referrals / Eventos
  // (deal_source_moveo não captura esses canais na maioria dos deals)
  const ORIGEM_PRIORITY = {
    "Parceiro":             "Partners",
    "Indicação - Referral": "Referrals",
    "Evento":               "Eventos",
    "Web Summit":           "Eventos",
  };
  if (rawOrigem && ORIGEM_PRIORITY[rawOrigem]) return ORIGEM_PRIORITY[rawOrigem];

  // `deal_source_moveo` é a fonte certa para Inbound Pago vs Orgânico
  const MOVEO_MAP = {
    "Inbound_Paid":     "Inbound Pago",
    "Inbound_Non_Paid": "Inbound Orgânico",
    "Inbound_paid":     "Inbound Pago",
    "Inbound_non_paid": "Inbound Orgânico",
    "Outbound SDR":     "Outbound",
    "Outbound":         "Outbound",
    "outbound":         "Outbound",
    "Events":           "Eventos",
    "Partners":         "Partners",
    "Referrals":        "Referrals",
    "paid_social":      "Paid Social",
    "paid_search":      "Paid Search",
    "organic_search":   "Inbound Orgânico",
    "direct":           "Direct Traffic",
  };
  if (MOVEO_MAP[rawMoveo]) return MOVEO_MAP[rawMoveo];
  // partial match case-insensitive
  const lower = rawMoveo.toLowerCase();
  for (const [k, v] of Object.entries(MOVEO_MAP)) {
    if (lower.includes(k.toLowerCase())) return v;
  }

  // Último fallback: origem para Inbound/Outbound genérico
  if (rawOrigem === "Inbound")  return "Inbound Pago";
  if (rawOrigem === "Outbound") return "Outbound";

  return rawMoveo || rawOrigem || "Não informado";
}

function isoMs(val) {
  if (!val) return null;
  // HubSpot retorna datas ora como ms timestamp ("1742774400000"), ora como ISO string ("2026-03-20T...")
  const s = String(val).trim();
  const d = /^\d+$/.test(s) ? new Date(parseInt(s)) : new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function transformDeal(raw, owners) {
  const props = raw.properties || {};
  const stageId = props.dealstage || "";
  const [amount, fallback] = resolveAmount(props);
  const prob = parseFloat(props.hs_deal_stage_probability ?? STAGE_PROBABILITY[stageId] ?? 0);
  const ownerId = String(props.hubspot_owner_id || "");
  const owner = owners[ownerId] || { name: "Sem responsável", email: "" };
  let daysToClose = null;
  if (props.days_to_close) {
    const n = parseInt(props.days_to_close);
    if (!isNaN(n)) daysToClose = n;
  }
  // Datas de estágio: prioriza hs_date_entered_* (HubSpot nativo), custom Moveo como fallback
  const stageEntryMap = {
    "459596269": props.entry_on_assesment___demo,
    "471108325": props.entry_on_demo_stage,
    "459596270": props.entry_on_proposal,
    "459596271": props.entry_on_verbal_agrement,
    "459596272": props.entry_on_contract_stage,
    "459596273": props.entry_on_win_stage,
    "459596274": props.entry_on_lost_stage,
  };
  const dateEntered = {};
  for (const sid of Object.keys(STAGE_MAP)) {
    dateEntered[sid] = isoMs(props[`hs_date_entered_${sid}`] || stageEntryMap[sid]);
  }

  // Data de fechamento: usar closedate como fonte primária (igual ao Excel do Claudinho).
  // entry_on_win_stage é o fallback, mas às vezes é preenchido retroativamente com data errada.
  // IMPORTANTE: só settar won_date/lost_date para deals que realmente estão nesses estágios
  // — deals ativos têm closedate futura e não devem ser contados como ganhos/perdidos.
  const wonDate  = (stageId === WON_STAGE)
    ? (isoMs(props.closedate) || isoMs(props.entry_on_win_stage))
    : null;
  const lostDate = (stageId === LOST_STAGE || stageId === CHURN_STAGE)
    ? (isoMs(props.entry_on_lost_stage) || isoMs(props.closedate) || isoMs(props.hs_date_entered_459596274))
    : null;

  return {
    id: raw.id,
    name: props.dealname || "",
    stage_id: stageId,
    stage_name: STAGE_MAP[stageId] || stageId,
    amount, amount_fallback: fallback,
    segment: resolveSegment(amount, props),
    source: resolveSource(props),
    owner_id: ownerId,
    owner_name: owner.name,
    owner_email: owner.email,
    type_of_plan: props.type_of_plan || "",
    industry: props.industry__segmento_ || "",
    use_case: props.use_case || "",
    partner: props.partner || "",
    lost_reason: props.lost_reason || "",
    lost_type: props.lost_type || "",
    probability: prob,
    forecast_amount: parseFloat(props.hs_forecast_amount || 0) || null,
    weighted_mrr: Math.round(amount * prob * 100) / 100,
    days_to_close: daysToClose,
    createdate: isoMs(props.createdate),
    closedate: isoMs(props.closedate),
    won_date: wonDate,
    lost_date: lostDate,
    date_entered: dateEntered,
  };
}

// ── Métricas ──────────────────────────────────────────────────────────────────

// offset: 0 = semana atual, -1 = semana passada, -2 = duas semanas atrás…
function weekBoundaries(offset = 0) {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now);
  mon.setUTCDate(now.getUTCDate() + diffToMon + offset * 7);
  mon.setUTCHours(0,0,0,0);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  sun.setUTCHours(23,59,59,999);
  return [mon, sun];
}

function lastWeekBoundaries() {
  return weekBoundaries(-1);
}

function monthBoundaries(year, month) { // month: 1-12
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return [start, end];
}

function isInPeriod(deal, start, end) {
  if (!deal.createdate) return false;
  const d = new Date(deal.createdate);
  return d >= start && d <= end;
}

function wasClosedInPeriod(deal, start, end, stageId) {
  let iso;
  if (stageId === WON_STAGE) {
    // NUNCA usa date_entered: deals ativos têm entry_on_win_stage preenchido (passaram por Won e voltaram)
    // e seriam contados errado. won_date é null para deals não-Won.
    iso = deal.won_date;
  } else if (stageId === LOST_STAGE) {
    // Mesma lógica: lost_date é null para deals não-Lost
    iso = deal.lost_date;
  } else {
    iso = deal.date_entered?.[stageId];
  }
  if (!iso) return false;
  const d = new Date(iso);
  return d >= start && d <= end;
}

function calcPeriodMetrics(deals, start, end) {
  const newDeals    = deals.filter(d => isInPeriod(d, start, end));
  const won         = deals.filter(d => wasClosedInPeriod(d, start, end, WON_STAGE));
  const lost        = deals.filter(d => wasClosedInPeriod(d, start, end, LOST_STAGE));
  // Rastreia quantos deals entraram em cada estágio no período (igual ao Excel do Claudinho)
  const assessments = deals.filter(d => wasClosedInPeriod(d, start, end, "459596269"));
  const demos       = deals.filter(d => wasClosedInPeriod(d, start, end, "471108325"));
  const proposals   = deals.filter(d => wasClosedInPeriod(d, start, end, "459596270"));
  const verbals     = deals.filter(d => wasClosedInPeriod(d, start, end, "459596271"));
  const contracts   = deals.filter(d => wasClosedInPeriod(d, start, end, "459596272"));
  const closedCount = won.length + lost.length;
  return {
    new_deals:   newDeals.length,
    assessments: assessments.length,
    demos:       demos.length,
    proposals:   proposals.length,
    verbals:     verbals.length,
    contracts:   contracts.length,
    won:         won.length,
    lost:        lost.length,
    win_rate:    closedCount ? Math.round(won.length / closedCount * 1000) / 10 : 0,
    new_mrr:     Math.round(won.reduce((s, d) => s + d.amount, 0) * 100) / 100,
    won_deals:   won.map(d => d.id),
    lost_deals:  lost.map(d => d.id),
  };
}

function computePeriodWeeks(allDeals, start, end) {
  const fmtLabel = d => d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", timeZone: "UTC" });
  const weeks = [];
  let ws = new Date(start);
  while (ws <= end) {
    let we = new Date(ws);
    we.setUTCDate(ws.getUTCDate() + 6);
    we.setUTCHours(23, 59, 59, 999);
    if (we > end) we = new Date(end);
    weeks.push({
      start:       ws.toISOString(),
      end:         we.toISOString(),
      short_label: `${fmtLabel(ws)}–${fmtLabel(we)}`,
      metrics:     calcPeriodMetrics(allDeals, ws, new Date(we)),
    });
    const next = new Date(we);
    next.setUTCDate(we.getUTCDate() + 1);
    next.setUTCHours(0, 0, 0, 0);
    ws = next;
  }
  return weeks;
}

function calcFunnel(deals) {
  const active = deals.filter(d => d.stage_id !== WON_STAGE && d.stage_id !== LOST_STAGE && d.stage_id !== CHURN_STAGE);
  const counts = {};
  for (const d of active) counts[d.stage_id] = (counts[d.stage_id] || 0) + 1;
  const stages = STAGE_ORDER.map(sid => ({
    stage_id: sid, stage_name: STAGE_MAP[sid], count: counts[sid] || 0,
  }));
  const first = stages[0]?.count || 1;
  return stages.map(s => ({
    ...s, conversion_from_top: first ? Math.round(s.count / first * 1000) / 10 : 0,
  }));
}

function calcAvgCycle(deals) {
  const won = deals.filter(d => d.stage_id === WON_STAGE && d.days_to_close != null);
  if (!won.length) return null;
  return Math.round(won.reduce((s, d) => s + d.days_to_close, 0) / won.length * 10) / 10;
}

function calcCohortByOwner(deals, start, end) {
  const cohort = deals.filter(d => isInPeriod(d, start, end));
  const map = {};
  for (const d of cohort) {
    const oid = d.owner_id;
    if (!map[oid]) map[oid] = {
      owner_id: oid,
      cohort_size:        0,
      reached_assessment: 0,
      reached_demo:       0,
      reached_proposal:   0,
      reached_verbal:     0,
      won:  0,
      lost: 0,
    };
    const o = map[oid];
    const created = d.createdate ? new Date(d.createdate).getTime() : 0;
    const afterCreate = sid => { const t = d.date_entered?.[sid]; return t && new Date(t).getTime() >= created; };
    o.cohort_size++;
    if (afterCreate("459596269")) o.reached_assessment++;
    if (afterCreate("471108325")) o.reached_demo++;
    if (afterCreate("459596270")) o.reached_proposal++;
    if (afterCreate("459596271")) o.reached_verbal++;
    if (d.stage_id === WON_STAGE)                                  o.won++;
    if (d.stage_id === LOST_STAGE || d.stage_id === CHURN_STAGE)  o.lost++;
  }
  return Object.values(map);
}

function calcByOwner(deals, wsStart, wsEnd) {
  const map = {};
  for (const d of deals) {
    const oid = d.owner_id;
    if (!map[oid]) {
      map[oid] = {
        owner_id: oid, owner_name: d.owner_name, owner_email: d.owner_email,
        total_deals: 0, active_deals: 0, won_total: 0, lost_total: 0,
        new_this_period: 0, won_this_period: 0, lost_this_period: 0,
        won_mrr_this_period: 0,
        assessments_this_period: 0, demos_this_period: 0, proposals_this_period: 0, verbals_this_period: 0,
        pipeline_value: 0, weighted_pipeline: 0, won_mrr: 0,
        _cyc_sum: 0, _cyc_cnt: 0,
      };
    }
    const o = map[oid];
    o.total_deals++;
    if (d.stage_id === WON_STAGE)       { o.won_total++;  o.won_mrr += d.amount; }
    else if (d.stage_id === LOST_STAGE) { o.lost_total++; }
    else { o.active_deals++; o.pipeline_value += d.amount; o.weighted_pipeline += d.weighted_mrr; }
    if (isInPeriod(d, wsStart, wsEnd))                          o.new_this_period++;
    if (wasClosedInPeriod(d, wsStart, wsEnd, WON_STAGE))      { o.won_this_period++; o.won_mrr_this_period += d.amount; }
    if (wasClosedInPeriod(d, wsStart, wsEnd, LOST_STAGE))       o.lost_this_period++;
    if (wasClosedInPeriod(d, wsStart, wsEnd, "459596269"))      o.assessments_this_period++;
    if (wasClosedInPeriod(d, wsStart, wsEnd, "471108325"))      o.demos_this_period++;
    if (wasClosedInPeriod(d, wsStart, wsEnd, "459596270"))      o.proposals_this_period++;
    if (wasClosedInPeriod(d, wsStart, wsEnd, "459596271"))      o.verbals_this_period++;
    if (d.stage_id === WON_STAGE && d.days_to_close != null) { o._cyc_sum += d.days_to_close; o._cyc_cnt++; }
  }
  return Object.values(map).map(o => {
    const closed = o.won_total + o.lost_total;
    const res = {
      ...o,
      win_rate: closed ? Math.round(o.won_total / closed * 1000) / 10 : 0,
      avg_cycle: o._cyc_cnt ? Math.round(o._cyc_sum / o._cyc_cnt * 10) / 10 : null,
      pipeline_value:    Math.round(o.pipeline_value * 100) / 100,
      weighted_pipeline: Math.round(o.weighted_pipeline * 100) / 100,
      won_mrr:            Math.round(o.won_mrr * 100) / 100,
      won_mrr_this_period: Math.round(o.won_mrr_this_period * 100) / 100,
    };
    delete res._cyc_sum; delete res._cyc_cnt;
    return res;
  }).sort((a, b) => b.won_mrr - a.won_mrr);
}

function calcSources(deals) {
  const counts = {};
  for (const d of deals) {
    if (!counts[d.source]) counts[d.source] = { count: 0, amount: 0 };
    counts[d.source].count++; counts[d.source].amount += d.amount;
  }
  const total = deals.length || 1;
  return Object.entries(counts)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([src, v]) => ({
      source: src, count: v.count,
      amount: Math.round(v.amount * 100) / 100,
      pct: Math.round(v.count / total * 1000) / 10,
    }));
}

// Funil de coorte por origem:
// Coorte = deals CRIADOS no período. Para cada deal da coorte, verifica
// quais estágios ele já atingiu em qualquer momento (não só no período).
// Partners e Referrals são sempre incluídos mesmo sem deals no período.
const SOURCE_FUNNEL_ALWAYS_SHOW = [
  "Inbound Pago",
  "Inbound Orgânico",
  "Outbound",
  "Eventos",
  "Partners",
  "Referrals",
];

function calcSourceFunnel(deals, start, end) {
  // Coorte: deals CRIADOS no período → base para Deals/Assessment/Demo/Proposta
  const cohort = deals.filter(d => isInPeriod(d, start, end));
  // Won/Lost: deals GANHOS/PERDIDOS no período (independente de quando criados)
  // → garante que batem com os números do Overview "Deals Ganhos"
  const wonInPeriod  = deals.filter(d => wasClosedInPeriod(d, start, end, WON_STAGE));
  const lostInPeriod = deals.filter(d => wasClosedInPeriod(d, start, end, LOST_STAGE));

  const map = {};
  // Garante que Partners e Referrals sempre aparecem
  for (const src of SOURCE_FUNNEL_ALWAYS_SHOW) {
    map[src] = { source: src, new_deals: 0, assessments: 0, demos: 0, proposals: 0, won: 0, lost: 0 };
  }

  const ensure = src => {
    if (!map[src]) map[src] = { source: src, new_deals: 0, assessments: 0, demos: 0, proposals: 0, won: 0, lost: 0 };
    return map[src];
  };

  for (const d of cohort) {
    const s = ensure(d.source || "Não informado");
    s.new_deals++;
    if (d.date_entered?.["459596269"]) s.assessments++;
    if (d.date_entered?.["471108325"]) s.demos++;
    if (d.date_entered?.["459596270"]) s.proposals++;
  }

  for (const d of wonInPeriod)  ensure(d.source || "Não informado").won++;
  for (const d of lostInPeriod) ensure(d.source || "Não informado").lost++;


  // Sources com deals vêm primeiro (por volume), depois os always-show sem deals
  return Object.values(map)
    .sort((a, b) => {
      if (a.new_deals !== b.new_deals) return b.new_deals - a.new_deals;
      return a.source.localeCompare(b.source);
    })
    .map(s => ({
      ...s,
      win_rate: (s.won + s.lost) > 0
        ? Math.round(s.won / (s.won + s.lost) * 1000) / 10
        : null,
    }));
}

function calcLostReasons(deals) {
  const lost = deals.filter(d => d.stage_id === LOST_STAGE && d.lost_reason);
  const counts = {};
  for (const d of lost) counts[d.lost_reason] = (counts[d.lost_reason] || 0) + 1;
  const total = lost.length || 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      reason, count, pct: Math.round(count / total * 1000) / 10,
    }));
}

function calcSegments(deals) {
  const active = deals.filter(d => d.stage_id !== WON_STAGE && d.stage_id !== LOST_STAGE && d.stage_id !== CHURN_STAGE);
  const ent = active.filter(d => d.segment === "Enterprise");
  const gro = active.filter(d => d.segment === "Growth");
  const avg = list => list.length ? Math.round(list.reduce((s, d) => s + d.amount, 0) / list.length * 100) / 100 : 0;
  const total = list => Math.round(list.reduce((s, d) => s + d.amount, 0) * 100) / 100;
  return {
    enterprise: { count: ent.length, avg_amount: avg(ent), total_pipeline: total(ent) },
    growth:     { count: gro.length, avg_amount: avg(gro), total_pipeline: total(gro) },
  };
}

function calcPeriodSegments(deals, start, end) {
  // Segmentação dos deals NOVOS no período (Enterprise vs Growth)
  const newInPeriod = deals.filter(d => isInPeriod(d, start, end));
  const ent = newInPeriod.filter(d => d.segment === "Enterprise");
  const gro = newInPeriod.filter(d => d.segment === "Growth");
  const avg = list => list.length ? Math.round(list.reduce((s, d) => s + d.amount, 0) / list.length * 100) / 100 : 0;
  return {
    enterprise: { count: ent.length, avg_amount: avg(ent) },
    growth:     { count: gro.length, avg_amount: avg(gro) },
  };
}

function calcForecast(deals) {
  const active = deals.filter(d => d.stage_id !== WON_STAGE && d.stage_id !== LOST_STAGE && d.stage_id !== CHURN_STAGE);
  const byStage = {};
  for (const sid of STAGE_ORDER) {
    const sd = active.filter(d => d.stage_id === sid);
    byStage[STAGE_MAP[sid]] = {
      count: sd.length,
      pipeline: Math.round(sd.reduce((s, d) => s + d.amount, 0) * 100) / 100,
      weighted: Math.round(sd.reduce((s, d) => s + d.weighted_mrr, 0) * 100) / 100,
      probability: STAGE_PROBABILITY[sid] || 0,
    };
  }
  return {
    total_pipeline: Math.round(active.reduce((s, d) => s + d.amount, 0) * 100) / 100,
    total_weighted: Math.round(active.reduce((s, d) => s + d.weighted_mrr, 0) * 100) / 100,
    by_stage: byStage,
    fallback_deals_count: active.filter(d => d.amount_fallback).length,
  };
}

// ── Fetch MQL data via form submissions (lógica do Ricardo) ──────────────────
// MQL = preencheu "Book demo - Framer (PT-BR)" no período
//       + lifecyclestage ≠ lead
//       + hs_analytics_source ≠ OFFLINE
//       + email não contém "moveo"
// SQL = MQL + num_associated_deals > 0

const BOOK_DEMO_FORM_NAME = "Book demo - Framer (PT-BR)";
let _formGuidCache = null;

async function findBookDemoFormGuid() {
  if (_formGuidCache) return _formGuidCache;
  let after = null;
  while (true) {
    const qs = after ? `?limit=100&after=${encodeURIComponent(after)}` : "?limit=100";
    const data = await hsGet(`/marketing/v3/forms${qs}`);
    for (const form of (data.results || [])) {
      if (form.name === BOOK_DEMO_FORM_NAME) {
        _formGuidCache = form.id;
        return form.id;
      }
    }
    after = data.paging?.next?.after;
    if (!after) break;
  }
  console.warn(`[mql] Form "${BOOK_DEMO_FORM_NAME}" not found`);
  return null;
}

// Mapeia hs_analytics_source (contatos) para labels de exibição
function resolveContactSource(hsAnalyticsSource) {
  const MAP = {
    "PAID_SOCIAL":     "Inbound Pago",
    "PAID_SEARCH":     "Inbound Pago",
    "OTHER_CAMPAIGNS": "Inbound Pago",
    "ORGANIC_SEARCH":  "Inbound Orgânico",
    "REFERRALS":       "Inbound Orgânico",
    "ORGANIC_SOCIAL":  "Inbound Orgânico",
    "DIRECT_TRAFFIC":  "Direct Traffic",
    "EMAIL_MARKETING": "Email",
  };
  const raw = (hsAnalyticsSource || "").toUpperCase();
  return MAP[raw] || (hsAnalyticsSource ? hsAnalyticsSource : "Não informado");
}

async function fetchMqlData(startMs, endMs) {
  const formGuid = await findBookDemoFormGuid();
  if (!formGuid) return [];

  // idToData: contactObjectId -> { timestamps, email }
  // Guardamos o email junto ao ID para, se o ID não resolver no batch read,
  // fazer fallback por email (IDs que apontam para contatos excluídos/mesclados).
  const idToData          = new Map(); // contactObjectId -> { timestamps: [], email: string|null }
  const emailToTimestamps = new Map(); // email -> [submittedAt ms, ...] (submissões sem ID)
  let after = null;

  while (true) {
    const qs = after ? `?limit=50&after=${encodeURIComponent(after)}` : "?limit=50";
    const data = await hsGet(`/form-integrations/v1/submissions/forms/${formGuid}${qs}`);
    const results = data.results || [];

    let hitOld = false;
    for (const sub of results) {
      const ts = sub.submittedAt;
      if (endMs && ts > endMs) continue;
      if (ts < startMs) { hitOld = true; break; }

      const rawEmail = (sub.values || []).find(v => v.name === "email")?.value;
      const email    = rawEmail ? rawEmail.toLowerCase() : null;

      if (sub.contactObjectId) {
        const cid = String(sub.contactObjectId);
        if (!idToData.has(cid)) idToData.set(cid, { timestamps: [], email });
        idToData.get(cid).timestamps.push(ts);
      } else if (email) {
        if (!emailToTimestamps.has(email)) emailToTimestamps.set(email, []);
        emailToTimestamps.get(email).push(ts);
      }
    }

    if (hitOld || !results.length) break;
    after = data.paging?.next?.after;
    if (!after) break;
  }

  if (!idToData.size && !emailToTimestamps.size) return [];

  const props = ["email", "hs_analytics_source", "lifecyclestage", "num_associated_deals"];
  const contacts = [];

  // 1. Batch read por contactObjectId (caminho primário)
  if (idToData.size) {
    const idList     = Array.from(idToData.keys());
    const resolvedIds = new Set();
    for (let i = 0; i < idList.length; i += 100) {
      const batch = idList.slice(i, i + 100).map(id => ({ id }));
      const res = await hsPost("/crm/v3/objects/contacts/batch/read", { inputs: batch, properties: props });
      for (const c of (res.results || [])) {
        const cid = String(c.id);
        resolvedIds.add(cid);
        contacts.push({ ...c, _submittedAts: idToData.get(cid)?.timestamps || [] });
      }
    }
    // IDs que não resolveram: promove para o lookup por email (contatos excluídos/mesclados)
    for (const [cid, entry] of idToData) {
      if (!resolvedIds.has(cid) && entry.email) {
        if (!emailToTimestamps.has(entry.email)) emailToTimestamps.set(entry.email, []);
        for (const ts of entry.timestamps) {
          if (!emailToTimestamps.get(entry.email).includes(ts))
            emailToTimestamps.get(entry.email).push(ts);
        }
      }
    }
  }

  // 2. Batch read por email (submissões sem ID + fallback de IDs não resolvidos)
  if (emailToTimestamps.size) {
    const coveredEmails = new Set(contacts.map(c => (c.properties?.email || "").toLowerCase()));
    const uncovered = Array.from(emailToTimestamps.keys()).filter(e => !coveredEmails.has(e));
    for (let i = 0; i < uncovered.length; i += 100) {
      const batch = uncovered.slice(i, i + 100).map(e => ({ id: e }));
      const res = await hsPost("/crm/v3/objects/contacts/batch/read", {
        inputs: batch, properties: props, idProperty: "email",
      });
      for (const c of (res.results || [])) {
        const email = (c.properties?.email || "").toLowerCase();
        contacts.push({ ...c, _submittedAts: emailToTimestamps.get(email) || [] });
      }
    }
  }

  return contacts;
}

async function fetchMqlDataForCache() {
  const { start } = currentQuarterBounds();
  return fetchMqlData(start.getTime(), null).catch(() => []);
}

function currentQuarterBounds() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(y, q * 3, 1));
  const end   = new Date(Date.UTC(y, q * 3 + 3, 0, 23, 59, 59, 999));
  return { start, end, label: `Q${q + 1} ${y}` };
}

function quarterWeeks(qStart, qEnd) {
  const dow = qStart.getUTCDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  let mon = new Date(qStart);
  mon.setUTCDate(mon.getUTCDate() + daysToMon);
  const weeks = [];
  let idx = 1;
  while (mon <= qEnd) {
    const sun = new Date(mon);
    sun.setUTCDate(sun.getUTCDate() + 6);
    sun.setUTCHours(23, 59, 59, 999);
    const s = mon < qStart ? new Date(qStart) : new Date(mon);
    const e = sun > qEnd   ? new Date(qEnd)   : new Date(sun);
    weeks.push({ idx, start: s, end: e });
    idx++;
    mon = new Date(mon);
    mon.setUTCDate(mon.getUTCDate() + 7);
  }
  return weeks;
}

function fmtWeekDates(s, e) {
  const d = dt => dt.getUTCDate();
  const m = dt => dt.toLocaleDateString("pt-BR", { month: "short", timeZone: "UTC" });
  return m(s) === m(e) ? `${d(s)}–${d(e)} ${m(s)}` : `${d(s)} ${m(s)}–${d(e)} ${m(e)}`;
}

function calcMktWeeklyQuarter(mqlData, allDeals, brazilContactIds) {
  const { start: qStart, end: qEnd, label: quarter } = currentQuarterBounds();
  const now = new Date();
  const weeks = quarterWeeks(qStart, qEnd).map(w => {
    if (w.start > now) {
      return { idx: w.idx, label: `W${w.idx}`, dates: fmtWeekDates(w.start, w.end),
               start: w.start.toISOString(), end: w.end.toISOString(),
               mql: null, sql: null, rate: null, is_current: false, is_future: true };
    }
    const periodDeals = allDeals.filter(d => isInPeriod(d, w.start, w.end));
    const f = calcMktFunnel(mqlData, w.start, w.end, periodDeals, brazilContactIds);
    return {
      idx: w.idx, label: `W${w.idx}`, dates: fmtWeekDates(w.start, w.end),
      start: w.start.toISOString(), end: w.end.toISOString(),
      mql: f.mql, sql: f.sql,
      rate: f.mql > 0 ? Math.round(f.sql / f.mql * 1000) / 10 : 0,
      is_current: w.start <= now && w.end >= now,
      is_future: false,
    };
  });
  const past = weeks.filter(w => !w.is_future);
  const totalMql = past.reduce((s, w) => s + (w.mql || 0), 0);
  const totalSql = past.reduce((s, w) => s + (w.sql || 0), 0);
  const best = [...past].sort((a, b) => (b.mql || 0) - (a.mql || 0))[0];
  return {
    quarter,
    total_mql: totalMql,
    total_sql: totalSql,
    avg_rate: totalMql > 0 ? Math.round(totalSql / totalMql * 1000) / 10 : 0,
    best_week: best?.label ?? null,
    weeks,
  };
}

// Busca IDs de contatos associados a deals do Brazil Pipeline
// Usado para SQL: só conta como SQL quem tem deal no pipeline correto
async function fetchBrazilDealContactIds(dealIds) {
  const contactIds = new Set();
  for (let i = 0; i < dealIds.length; i += 100) {
    const batch = dealIds.slice(i, i + 100).map(id => ({ id }));
    try {
      const data = await hsPost("/crm/v4/associations/deals/contacts/batch/read", {
        inputs: batch,
      });
      for (const result of (data.results || [])) {
        for (const assoc of (result.to || [])) {
          const cid = assoc.toObjectId ?? assoc.id;
          if (cid) contactIds.add(String(cid));
        }
      }
    } catch (e) {
      console.warn("[sql] associations batch error:", e.message);
    }
  }
  return contactIds;
}

function calcMktFunnel(mqlContacts, start, end, periodDeals = [], brazilContactIds = new Set()) {
  let mql = 0, sql = 0;
  const bySource    = {};
  const sqlBySource = {};

  // HubSpot UI usa fuso BRT (UTC-3): desloca os limites +3h para corresponder ao filtro do Ricardo
  const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
  const startMs = (start instanceof Date ? start.getTime() : (start || 0))           + BRT_OFFSET_MS;
  const endMs   = (end   instanceof Date ? end.getTime()   : (end   || Infinity))     + BRT_OFFSET_MS;

  for (const c of mqlContacts) {
    const props     = c.properties || {};
    const email     = (props.email || "").toLowerCase();
    const source    = (props.hs_analytics_source || "").toUpperCase();
    const lifecycle = props.lifecyclestage || "";

    // Filtro de data: contato deve ter submetido o form no período selecionado
    const submittedInPeriod = (c._submittedAts || []).some(ts => ts >= startMs && ts <= endMs);
    if (!submittedInPeriod) continue;

    // Filtros do Ricardo (include_empty = false em todos):
    // lifecyclestage não é "lead" E não está vazio
    if (!lifecycle || lifecycle === "lead") continue;
    // hs_analytics_source não é OFFLINE E não está vazio
    if (!source || source === "OFFLINE") continue;
    // email não está vazio e não contém "moveo"
    if (!email || email.includes("moveo")) continue;

    mql++;
    const srcLabel = resolveContactSource(props.hs_analytics_source);
    bySource[srcLabel] = (bySource[srcLabel] || 0) + 1;

    // SQL = MQL + "Negócios associados é conhecido" (verificado em tempo real via associations API)
    const hasBrazilDeal = brazilContactIds.has(String(c.id));
    if (hasBrazilDeal) {
      sql++;
      sqlBySource[srcLabel] = (sqlBySource[srcLabel] || 0) + 1;
    }
  }

  return {
    total_contacts: mql, mql, sql,
    sql_by_source: Object.entries(sqlBySource).sort((a,b) => b[1]-a[1]).map(([src,cnt]) => ({
      source: src, count: cnt, pct: Math.round(cnt / Math.max(sql, 1) * 1000) / 10,
    })),
    by_source: Object.entries(bySource).sort((a,b) => b[1]-a[1]).map(([src,cnt]) => ({
      source: src, count: cnt, pct: Math.round(cnt / Math.max(mql, 1) * 1000) / 10,
    })),
  };
}

// ── Build snapshot ────────────────────────────────────────────────────────────

async function buildSnapshot() {
  const [owners, rawDeals, mqlData] = await Promise.all([
    fetchOwners().catch(() => ({})),
    fetchAllDeals().catch(() => []),
    fetchMqlDataForCache().catch(() => []),
  ]);
  const deals = rawDeals.map(d => transformDeal(d, owners));

  const dealIds = rawDeals.map(d => d.id);
  // SQL = MQL + tem deal no pipeline Brazil (busca real-time deals→contacts)
  const brazilContactIds = await fetchBrazilDealContactIds(dealIds).catch(() => new Set());

  const [ws, we] = weekBoundaries();
  const [lws, lwe] = lastWeekBoundaries();

  const nowMs = Date.now();
  const activeDeals = deals
    .filter(d => d.stage_id !== WON_STAGE && d.stage_id !== LOST_STAGE && d.stage_id !== CHURN_STAGE)
    .map(d => {
      const stageEntry = d.date_entered?.[d.stage_id];
      return { ...d, days_stalled: stageEntry ? Math.floor((nowMs - new Date(stageEntry).getTime()) / 86400000) : null };
    })
    .sort((a, b) => b.amount - a.amount);

  const totalWon  = deals.filter(d => d.stage_id === WON_STAGE).length;
  const totalLost = deals.filter(d => d.stage_id === LOST_STAGE).length;

  const fmtLabel = d => d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", timeZone: "UTC" });
  const weekLabel = (s, e) => `${fmtLabel(s)}–${fmtLabel(e)} ${e.getUTCFullYear()}`;

  // Pré-calcula últimas 5 semanas para filtro no dashboard (sem novas chamadas ao HubSpot)
  const weeks = [-4, -3, -2, -1, 0].map(offset => {
    const [s, e] = weekBoundaries(offset);
    return {
      offset,
      label: offset === 0 ? `Semana atual (${weekLabel(s, e)})` : weekLabel(s, e),
      short_label: offset === 0 ? "Semana atual" : weekLabel(s, e),
      start: s.toISOString(),
      end:   e.toISOString(),
      metrics:        calcPeriodMetrics(deals, s, e),
      by_owner:       calcByOwner(deals, s, e),
      sources:        calcSources(deals.filter(d => isInPeriod(d, s, e))),
      mkt_funnel:     calcMktFunnel(mqlData, s, e, deals.filter(d => isInPeriod(d, s, e)), brazilContactIds),
      lost_reasons:   calcLostReasons(deals.filter(d => wasClosedInPeriod(d, s, e, LOST_STAGE))),
      segments_period: calcPeriodSegments(deals, s, e),
      source_funnel:   calcSourceFunnel(deals, s, e),
      period_won_deals: deals.filter(d => wasClosedInPeriod(d, s, e, WON_STAGE))
        .map(d => ({ id: d.id, name: d.name, owner_name: d.owner_name, amount: d.amount, amount_fallback: d.amount_fallback, source: d.source, segment: d.segment, won_date: d.won_date })),
    };
  });

  // Last 3 full months + current month (4 total)
  const nowDate = new Date();
  const nowMonth = nowDate.getUTCMonth() + 1;
  const nowYear  = nowDate.getUTCFullYear();
  const months = [];
  for (let i = 3; i >= 0; i--) {
    let mo = nowMonth - i, yr = nowYear;
    if (mo <= 0) { mo += 12; yr--; }
    const [ms, me] = monthBoundaries(yr, mo);
    months.push({
      key:       `${yr}-${String(mo).padStart(2,'0')}`,
      label:     ms.toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' }),
      year: yr, month: mo, isCurrent: i === 0,
      start: ms.toISOString(), end: me.toISOString(),
      metrics:          calcPeriodMetrics(deals, ms, me),
      by_owner:         calcByOwner(deals, ms, me),
      cohort_by_owner:  calcCohortByOwner(deals, ms, me),
      period_won_deals: deals.filter(d => wasClosedInPeriod(d, ms, me, WON_STAGE))
        .map(d => ({ id: d.id, name: d.name, owner_name: d.owner_name, amount: d.amount, won_date: d.won_date })),
    });
  }

  return {
    generated_at: new Date().toISOString(),
    pipeline_id: PIPELINE_ID,
    period: {
      current_week_start: ws.toISOString(),
      current_week_end:   we.toISOString(),
      label: weekLabel(ws, we),
    },
    summary: {
      total_deals:    deals.length,
      active_deals:   activeDeals.length,
      total_won:      totalWon,
      total_lost:     totalLost,
      total_won_mrr:  Math.round(deals.filter(d => d.stage_id === WON_STAGE).reduce((s, d) => s + d.amount, 0) * 100) / 100,
      avg_cycle_days: calcAvgCycle(deals),
      overall_win_rate: (totalWon + totalLost) > 0
        ? Math.round(totalWon / (totalWon + totalLost) * 1000) / 10 : 0,
    },
    current_week: calcPeriodMetrics(deals, ws, we),
    last_week:    calcPeriodMetrics(deals, lws, lwe),
    weeks, months,
    funnel:       calcFunnel(deals),
    segments:     calcSegments(deals),
    forecast:     calcForecast(deals),
    by_owner:     calcByOwner(deals, ws, we),
    sources:      calcSources(deals),
    lost_reasons: calcLostReasons(deals),
    active_deals: activeDeals,
    mkt_funnel:         calcMktFunnel(mqlData, ws, we, deals.filter(d => isInPeriod(d, ws, we)), brazilContactIds),
    mkt_weekly_quarter: calcMktWeeklyQuarter(mqlData, deals, brazilContactIds),
    source_funnel:   calcSourceFunnel(deals, ws, we),
    period_won_deals: deals.filter(d => wasClosedInPeriod(d, ws, we, WON_STAGE))
      .map(d => ({ id: d.id, name: d.name, owner_name: d.owner_name, amount: d.amount, amount_fallback: d.amount_fallback, source: d.source, segment: d.segment, won_date: d.won_date })),
    total_contacts_90d: mqlData.length,
    goals: {}, session_mrr: null, potential_mrr: null, ps_value: null,
    _debug: { deals_fetched: deals.length, mql_submissions_fetched: mqlData.length, owners_fetched: Object.keys(owners).length, brazil_contact_ids: brazilContactIds.size },
    _all_deals:          deals,            // interno: filtro custom de data
    _mql_data:           mqlData,          // interno: filtro custom de data
    _brazil_contact_ids: brazilContactIds, // interno: Set (não serializa)
  };
}

// ── Cache em memória (instâncias quentes da Vercel) ───────────────────────────

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 300_000; // 5 min em ms

// ── Handler Vercel ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (!TOKEN) {
    return res.status(500).json({ error: "HUBSPOT_ACCESS_TOKEN não configurado" });
  }

  try {
    const now = Date.now();
    const url = new URL(req.url, `http://localhost`);
    const force = url.searchParams.get("force") === "1";

    if (!_cache || (now - _cacheAt) > CACHE_TTL || force) {
      _cache = await buildSnapshot();
      _cacheAt = now;
    }

    // Suporte a filtro custom via query params: ?from=2026-03-01&to=2026-03-31
    const from = url.searchParams.get("from");
    const to   = url.searchParams.get("to");

    if (from && to) {
      // HubSpot armazena timestamps de form submissions em UTC
      const start = new Date(from + "T00:00:00.000Z");
      const end   = new Date(to   + "T23:59:59.999Z");
      if (!isNaN(start) && !isNaN(end)) {
        const allDeals = _cache._all_deals || [];
        const brazilContactIds = _cache._brazil_contact_ids || new Set();
        // Busca submissions com fronteiras em BRT (HubSpot UI usa UTC-3)
        const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
        const periodMqlData = await fetchMqlData(start.getTime() + BRT_OFFSET_MS, end.getTime() + BRT_OFFSET_MS).catch(() => []);
        const periodMetrics = calcPeriodMetrics(allDeals, start, end);
        const lostInPeriod  = allDeals.filter(d => wasClosedInPeriod(d, start, end, LOST_STAGE));
        const filtered = {
          ..._cache,
          current_week:    periodMetrics,
          by_owner:        calcByOwner(allDeals, start, end),
          months:          _cache.months, // months always use absolute dates, not affected by filter
          sources:         calcSources(allDeals.filter(d => isInPeriod(d, start, end))),
          mkt_funnel:      calcMktFunnel(periodMqlData, start, end, allDeals.filter(d => isInPeriod(d, start, end)), brazilContactIds),
          lost_reasons:    calcLostReasons(lostInPeriod),
          segments_period: calcPeriodSegments(allDeals, start, end),
          source_funnel:   calcSourceFunnel(allDeals, start, end),
          period_won_deals: allDeals.filter(d => wasClosedInPeriod(d, start, end, WON_STAGE))
            .map(d => ({ id: d.id, name: d.name, owner_name: d.owner_name, amount: d.amount, amount_fallback: d.amount_fallback, source: d.source, segment: d.segment, won_date: d.won_date })),
          period_weeks:     computePeriodWeeks(allDeals, start, end),
          period: {
            current_week_start: start.toISOString(),
            current_week_end:   end.toISOString(),
            label: `${start.toLocaleDateString("pt-BR", { day: "numeric", month: "short", timeZone: "America/Sao_Paulo" })}–${end.toLocaleDateString("pt-BR", { day: "numeric", month: "short", timeZone: "America/Sao_Paulo" })} ${end.getUTCFullYear()}`,
          },
          _debug: { deals_fetched: allDeals.length, mql_submissions_fetched: periodMqlData.length, brazil_contact_ids: brazilContactIds.size },
          _all_deals: undefined,
          _mql_data: undefined,
          _brazil_contact_ids: undefined,
        };
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json");
        return res.status(200).json(filtered);
      }
    }

    // Remove campos internos do response público
    const { _all_deals, _mql_data, _brazil_contact_ids, ...publicData } = _cache;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    res.status(200).json(publicData);
  } catch (err) {
    console.error("[snapshot]", err.message);
    res.status(500).json({ error: err.message });
  }
}
