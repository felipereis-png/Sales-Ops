/**
 * Vercel Serverless Function — GET /api/campaigns
 * Busca deals inbound-paid e retorna funil de atribuição por campanha.
 *
 * Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: mês atual)
 * Cache: no-store (dados em tempo real)
 */

// ── Constantes ────────────────────────────────────────────────────────────────

const PIPELINE_ID = process.env.PIPELINE_ID || "282308322";
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || "";

const STAGE_MAP = {
  "459596268": "meeting",
  "459596269": "assessment",
  "471108325": "demo",
  "459596270": "proposal",
  "459596271": "verbal",
  "459596272": "verbal",  // Contract Sent merged into verbal
  "459596273": "won",
  "459596274": "lost",
};

const FUNNEL = ["meeting", "assessment", "demo", "proposal", "verbal"];

const DEAL_PROPERTIES = [
  "dealname", "dealstage", "pipeline", "createdate", "amount",
  "hubspot_owner_id", "hs_analytics_source", "hs_analytics_source_data_1",
  "hs_analytics_source_data_2", "paid_ad_channel",
];

// ── HTTP helpers (mirrors snapshot.js) ───────────────────────────────────────

const HEADERS = () => ({
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
});

async function hsRequest(fn, retries = 2) {
  for (let i = 0; i < retries; i++) {
    const r = await fn();
    if (r.status === 429) {
      const wait = parseInt(r.headers.get("Retry-After") || "3") * 1000;
      await new Promise(res => setTimeout(res, Math.min(wait, 4000)));
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

// ── Fetch all pipeline deals (paginated, 200 per page) ───────────────────────

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

// ── Fetch owners ──────────────────────────────────────────────────────────────

async function fetchOwners() {
  const data = await hsGet("/crm/v3/owners?limit=250");
  const map = {};
  for (const o of data.results || []) {
    map[String(o.id)] = `${o.firstName || ""} ${o.lastName || ""}`.trim() || o.email || String(o.id);
  }
  return map;
}

// ── Fetch contact associations for deal IDs (100 at a time) ──────────────────

async function fetchContactAssociations(dealIds) {
  const assoc = {};
  for (let i = 0; i < dealIds.length; i += 100) {
    const batch = dealIds.slice(i, i + 100);
    const data = await hsPost("/crm/v4/associations/deals/contacts/batch/read", {
      inputs: batch.map(id => ({ id: String(id) })),
    });
    for (const item of data.results || []) {
      const did = String(item?.from?.id || "");
      const tos = (item.to || []).map(t => String(t.toObjectId));
      if (tos.length) assoc[did] = tos[0];
    }
  }
  return assoc;
}

// ── Batch-read contact properties (100 at a time) ────────────────────────────

async function fetchContactProps(contactIds) {
  const cdata = {};
  const props = [
    "hs_analytics_source", "hs_analytics_source_data_1",
    "hs_analytics_source_data_2", "paid_ad_channel",
  ];
  for (let i = 0; i < contactIds.length; i += 100) {
    const batch = contactIds.slice(i, i + 100);
    const data = await hsPost("/crm/v3/objects/contacts/batch/read", {
      inputs: batch.map(id => ({ id })),
      properties: props,
    });
    for (const item of data.results || []) {
      cdata[String(item.id)] = item.properties || {};
    }
  }
  return cdata;
}

// ── Channel / campaign resolution ────────────────────────────────────────────

function resolve(props) {
  const ch_raw = props.paid_ad_channel || '';
  const src    = props.hs_analytics_source || '';
  const d1     = props.hs_analytics_source_data_1 || '';
  const d2     = props.hs_analytics_source_data_2 || '';

  let channel = null, campaign = null;

  if (/google/i.test(ch_raw) || /PAID_SEARCH/i.test(src)) {
    channel = 'Google Ads';
    campaign = d1 || d2 || 'Sem UTM';
  } else if (/meta|facebook/i.test(ch_raw) || /PAID_SOCIAL/i.test(src)) {
    channel = 'Meta';
    campaign = d2 || d1 || 'Sem UTM';
  }
  return { channel, campaign };
}

// ── Campaign name cleaning (ported from campaign_test.py JS) ─────────────────

function cleanName(raw) {
  if (!raw || raw === 'Sem UTM') return raw || 'Sem UTM';
  let s = raw;
  if (/\.ai\/|\.com\/|^https?:\/\//i.test(s) || /^userId:/i.test(s)) return 'Sem UTM';
  s = s.replace(/_/g, ' ');
  let outside = s.replace(/\[[^\]]*\]/g, ' ')
                  .replace(/\s*[–—-]\s*/g, ' · ')
                  .replace(/(\s*·\s*)+/g, ' · ')
                  .replace(/\s+/g, ' ').trim()
                  .replace(/^[\s·]+|[\s·]+$/g, '');
  if (outside && !/^[\d\/\-\s]+$/.test(outside)) {
    return outside[0].toUpperCase() + outside.slice(1);
  }
  const tags = [...s.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
  const good = tags.filter(t => t.length > 3 && !/^[a-z]{1,3}\d{0,4}$/i.test(t) && !/^\d{4,}/.test(t));
  if (good.length) {
    const r = good[good.length - 1];
    return r[0].toUpperCase() + r.slice(1);
  }
  const r = s.replace(/\[[^\]]*\]/g, '').replace(/[-·]/g, ' ').replace(/\s+/g, ' ').trim();
  return r ? r[0].toUpperCase() + r.slice(1) : 'Sem UTM';
}

// ── Build campaign funnel ─────────────────────────────────────────────────────

function buildCampaignFunnel(records) {
  const FUNNEL_IDX = {};
  FUNNEL.forEach((s, i) => { FUNNEL_IDX[s] = i; });

  const map = {};

  for (const rec of records) {
    const k = rec.channel + '||' + rec.campaign;
    if (!map[k]) {
      map[k] = {
        channel: rec.channel,
        campaign: rec.campaign,
        name: cleanName(rec.campaign),
        stages: { all: [], meeting: [], assessment: [], demo: [], proposal: [], verbal: [], won: [], lost: [] },
      };
    }
    const entry = map[k];
    const dealItem = {
      id: rec.id,
      name: rec.name,
      owner: rec.owner,
      amount: rec.amount,
      created: rec.created,
    };

    // Always add to "all"
    entry.stages.all.push(dealItem);

    const stage = rec.stage;

    if (stage === 'lost') {
      entry.stages.lost.push(dealItem);
    } else if (stage === 'won') {
      // Cumulative: add to all funnel stages + won
      for (const s of FUNNEL) {
        entry.stages[s].push(dealItem);
      }
      entry.stages.won.push(dealItem);
    } else {
      const si = FUNNEL_IDX[stage];
      if (si !== undefined) {
        // Cumulative: add to all stages up to current stage
        for (let i = 0; i <= si; i++) {
          entry.stages[FUNNEL[i]].push(dealItem);
        }
      }
    }
  }

  return Object.values(map)
    .map(c => ({ ...c, total: c.stages.all.length }))
    .sort((a, b) => b.total - a.total);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (!TOKEN) {
    return res.status(500).json({ error: "HUBSPOT_ACCESS_TOKEN não configurado" });
  }

  try {
    const url = new URL(req.url, "http://localhost");

    // Date range: default = current month
    const now = new Date();
    const defaultFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const defaultTo   = now.toISOString().slice(0, 10);

    const fromStr = url.searchParams.get("from") || defaultFrom;
    const toStr   = url.searchParams.get("to")   || defaultTo;

    const start = new Date(fromStr + "T00:00:00.000Z");
    const end   = new Date(toStr   + "T23:59:59.999Z");

    if (isNaN(start) || isNaN(end)) {
      return res.status(400).json({ error: "Parâmetros from/to inválidos. Use YYYY-MM-DD." });
    }

    // 1. Fetch owners and all deals in parallel
    const [owners, allDeals] = await Promise.all([
      fetchOwners().catch(() => ({})),
      fetchAllDeals(),
    ]);

    // 2. Filter deals by createdate range
    const deals = allDeals.filter(d => {
      const raw = d.properties?.createdate;
      if (!raw) return false;
      const ts = /^\d+$/.test(String(raw).trim()) ? parseInt(raw) : new Date(raw).getTime();
      return ts >= start.getTime() && ts <= end.getTime();
    });

    // 3. Fetch contact associations for filtered deals
    const dealIds = deals.map(d => d.id);
    const assoc = dealIds.length ? await fetchContactAssociations(dealIds) : {};

    // 4. Batch-read contact properties
    const contactIds = [...new Set(Object.values(assoc))];
    const cdata = contactIds.length ? await fetchContactProps(contactIds) : {};

    // 5. Build contact-props map keyed by deal ID
    const dealContactProps = {};
    for (const [did, cid] of Object.entries(assoc)) {
      if (cdata[cid]) dealContactProps[did] = cdata[cid];
    }

    // 6. Resolve channel + campaign for each deal
    const records = [];
    for (const d of deals) {
      const dp = d.properties || {};
      const cp = dealContactProps[d.id] || dp;

      const { channel, campaign } = resolve(cp);
      if (!channel) continue;

      // Filter template strings
      if (campaign && campaign.includes('{{')) continue;

      const stage = STAGE_MAP[dp.dealstage || ""] || "unknown";
      const created = (dp.createdate || "").toString().slice(0, 10);
      const ownerId = String(dp.hubspot_owner_id || "");
      let amount = 0;
      try { amount = parseFloat(dp.amount || "0") || 0; } catch (_) {}

      records.push({
        id: d.id,
        name: dp.dealname || "",
        owner: owners[ownerId] || "",
        amount,
        channel,
        campaign,
        stage,
        created,
      });
    }

    // 7. Build funnel per campaign
    const campaigns = buildCampaignFunnel(records);

    return res.status(200).json({ campaigns });
  } catch (err) {
    console.error("[campaigns]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
