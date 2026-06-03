"""
Moveo Sales Ops — HubSpot Sync Engine
Pulls all deals from the Brazil Pipeline, transforms data,
applies price fallback logic, and saves data/snapshot.json
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from collections import defaultdict

import requests
from dotenv import load_dotenv

# Allow running from any working directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import (
    HUBSPOT_ACCESS_TOKEN, PIPELINE_ID, STAGE_MAP, STAGE_ORDER,
    WON_STAGE_ID, LOST_STAGE_ID, STAGE_PROBABILITY,
    PRICE_FALLBACK, PRICE_FALLBACK_DEFAULT, ENTERPRISE_THRESHOLD,
    DEAL_PROPERTIES, DEAL_SOURCE_LABELS,
)

OUTPUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "snapshot.json"
)

HUBSPOT_API = "https://api.hubapi.com"


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _headers():
    return {
        "Authorization": f"Bearer {HUBSPOT_ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }


def _get(url, params=None):
    r = requests.get(url, headers=_headers(), params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def _post(url, body):
    r = requests.post(url, headers=_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json()


# ── Fetch all deals (paginated) ───────────────────────────────────────────────

def fetch_all_deals():
    """Fetch every deal in the Brazil Pipeline using HubSpot Search API."""
    url = f"{HUBSPOT_API}/crm/v3/objects/deals/search"
    all_deals = []
    after = None

    while True:
        body = {
            "filterGroups": [
                {
                    "filters": [
                        {"propertyName": "pipeline", "operator": "EQ", "value": PIPELINE_ID}
                    ]
                }
            ],
            "properties": DEAL_PROPERTIES,
            "limit": 200,
            "sorts": [{"propertyName": "createdate", "direction": "DESCENDING"}],
        }
        if after:
            body["after"] = after

        data = _post(url, body)
        results = data.get("results", [])
        all_deals.extend(results)

        paging = data.get("paging", {})
        after = paging.get("next", {}).get("after")
        if not after:
            break

    print(f"[sync] Fetched {len(all_deals)} deals from pipeline {PIPELINE_ID}")
    return all_deals


# ── Fetch owners ──────────────────────────────────────────────────────────────

def fetch_owners():
    """Return a dict {owner_id: {name, email}}."""
    url = f"{HUBSPOT_API}/crm/v3/owners"
    data = _get(url, params={"limit": 200})
    owners = {}
    for o in data.get("results", []):
        oid = str(o.get("id", ""))
        first = o.get("firstName", "")
        last = o.get("lastName", "")
        owners[oid] = {
            "name": f"{first} {last}".strip() or o.get("email", oid),
            "email": o.get("email", ""),
        }
    return owners


# ── Price fallback ────────────────────────────────────────────────────────────

def resolve_amount(props):
    """Return (amount_float, amount_fallback_bool)."""
    raw = props.get("amount", "0") or "0"
    try:
        amount = float(raw)
    except (ValueError, TypeError):
        amount = 0.0

    if amount <= 1:
        return 0.0, False

    return amount, False


# ── Segment ───────────────────────────────────────────────────────────────────

def resolve_segment(amount, props):
    plan_raw = (props.get("type_of_plan") or "").lower()
    if amount >= ENTERPRISE_THRESHOLD or "enterprise" in plan_raw or "custom" in plan_raw:
        return "Enterprise"
    return "Growth"


# ── Date helpers ──────────────────────────────────────────────────────────────

def _ts_to_dt(ts_ms):
    """Convert HubSpot ms timestamp or ISO string → datetime (UTC)."""
    if not ts_ms:
        return None
    s = str(ts_ms).strip()
    try:
        if s.isdigit():
            return datetime.fromtimestamp(int(s) / 1000, tz=timezone.utc)
        # ISO string e.g. "2026-03-20T14:30:00.000Z"
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _iso(ts_ms):
    dt = _ts_to_dt(ts_ms)
    return dt.isoformat() if dt else None


def week_boundaries():
    """Return (week_start, week_end) as UTC datetimes for the current ISO week (Mon–Sun)."""
    today = datetime.now(tz=timezone.utc)
    monday = today - timedelta(days=today.weekday())
    week_start = monday.replace(hour=0, minute=0, second=0, microsecond=0)
    week_end = week_start + timedelta(days=6, hours=23, minutes=59, seconds=59)
    return week_start, week_end


def last_week_boundaries():
    ws, _ = week_boundaries()
    lw_end = ws - timedelta(seconds=1)
    lw_start = lw_end - timedelta(days=6, hours=23, minutes=59, seconds=59)
    return lw_start, lw_end


# ── Source label ──────────────────────────────────────────────────────────────

def resolve_source(props):
    raw = (props.get("deal_source_moveo") or "").lower().strip()
    for key, label in DEAL_SOURCE_LABELS.items():
        if key and key in raw:
            return label
    return DEAL_SOURCE_LABELS.get(raw) or ("Não informado" if not raw else raw.title())


# ── Transform single deal ─────────────────────────────────────────────────────

def transform_deal(raw, owners):
    props = raw.get("properties", {})
    deal_id = raw.get("id", "")
    stage_id = props.get("dealstage", "")

    amount, fallback = resolve_amount(props)
    segment = resolve_segment(amount, props)
    source = resolve_source(props)
    owner_id = str(props.get("hubspot_owner_id") or "")
    owner = owners.get(owner_id, {"name": "Sem responsável", "email": ""})

    # Probability
    raw_prob = props.get("hs_deal_stage_probability")
    if raw_prob is not None:
        try:
            prob = float(raw_prob)
        except (ValueError, TypeError):
            prob = STAGE_PROBABILITY.get(stage_id, 0.0)
    else:
        prob = STAGE_PROBABILITY.get(stage_id, 0.0)

    weighted_mrr = round(amount * prob, 2)

    # Days to close
    days_to_close = None
    if props.get("days_to_close"):
        try:
            days_to_close = int(float(props["days_to_close"]))
        except (ValueError, TypeError):
            pass

    return {
        "id": deal_id,
        "name": props.get("dealname", ""),
        "stage_id": stage_id,
        "stage_name": STAGE_MAP.get(stage_id, stage_id),
        "amount": amount,
        "amount_fallback": fallback,
        "segment": segment,
        "source": source,
        "owner_id": owner_id,
        "owner_name": owner["name"],
        "owner_email": owner["email"],
        "type_of_plan": props.get("type_of_plan") or "",
        "industry": props.get("industry__segmento_") or "",
        "use_case": props.get("use_case") or "",
        "lost_reason": props.get("lost_reason") or "",
        "lost_type": props.get("lost_type") or "",
        "pre_sales": props.get("pre_sales_responsible") or "",
        "probability": prob,
        "weighted_mrr": weighted_mrr,
        "days_to_close": days_to_close,
        "createdate": _iso(props.get("createdate")),
        "closedate": _iso(props.get("closedate")),
        "hs_lastmodifieddate": _iso(props.get("hs_lastmodifieddate")),
        # Stage entry timestamps
        "date_entered": {
            sid: _iso(props.get(f"hs_date_entered_{sid}")) for sid in list(STAGE_MAP.keys())
        },
    }


# ── Metrics calculation ───────────────────────────────────────────────────────

def is_in_period(deal, start_dt, end_dt):
    """True if the deal was created within [start_dt, end_dt]."""
    if not deal["createdate"]:
        return False
    try:
        dt = datetime.fromisoformat(deal["createdate"])
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return start_dt <= dt <= end_dt
    except (ValueError, TypeError):
        return False


def was_closed_in_period(deal, start_dt, end_dt, stage_id):
    """True if deal entered won/lost stage within period."""
    entry_iso = deal["date_entered"].get(stage_id)
    if not entry_iso:
        return False
    try:
        dt = datetime.fromisoformat(entry_iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return start_dt <= dt <= end_dt
    except (ValueError, TypeError):
        return False


def calc_period_metrics(deals, start_dt, end_dt):
    new_deals = [d for d in deals if is_in_period(d, start_dt, end_dt)]
    won_this = [d for d in deals if was_closed_in_period(d, start_dt, end_dt, WON_STAGE_ID)]
    lost_this = [d for d in deals if was_closed_in_period(d, start_dt, end_dt, LOST_STAGE_ID)]
    closed_count = len(won_this) + len(lost_this)
    win_rate = round(len(won_this) / closed_count * 100, 1) if closed_count else 0.0

    new_mrr = sum(d["amount"] for d in won_this)
    return {
        "new_deals": len(new_deals),
        "won": len(won_this),
        "lost": len(lost_this),
        "win_rate": win_rate,
        "new_mrr": round(new_mrr, 2),
        "won_deals": [d["id"] for d in won_this],
        "lost_deals": [d["id"] for d in lost_this],
    }


def calc_funnel_stages(deals):
    """Count active (non-won, non-lost) deals per stage."""
    active = [d for d in deals if d["stage_id"] not in (WON_STAGE_ID, LOST_STAGE_ID)]
    counts = defaultdict(int)
    for d in active:
        counts[d["stage_id"]] += 1
    return [
        {
            "stage_id": sid,
            "stage_name": STAGE_MAP[sid],
            "count": counts[sid],
        }
        for sid in STAGE_ORDER
    ]


def calc_conversion_rates(funnel_stages):
    """Conversion from first stage to each subsequent stage."""
    result = []
    first_count = funnel_stages[0]["count"] if funnel_stages else 1
    for s in funnel_stages:
        conv = round(s["count"] / first_count * 100, 1) if first_count else 0.0
        result.append({**s, "conversion_from_top": conv})
    return result


def calc_avg_cycle(deals):
    """Average sales cycle in days for won deals (use days_to_close if available)."""
    won = [d for d in deals if d["stage_id"] == WON_STAGE_ID and d["days_to_close"]]
    if not won:
        return None
    return round(sum(d["days_to_close"] for d in won) / len(won), 1)


def calc_by_owner(deals, start_dt, end_dt):
    """Per-owner stats."""
    owners_map = {}
    for d in deals:
        oid = d["owner_id"]
        if oid not in owners_map:
            owners_map[oid] = {
                "owner_id": oid,
                "owner_name": d["owner_name"],
                "owner_email": d["owner_email"],
                "total_deals": 0,
                "active_deals": 0,
                "won_total": 0,
                "lost_total": 0,
                "new_this_period": 0,
                "won_this_period": 0,
                "lost_this_period": 0,
                "pipeline_value": 0.0,
                "weighted_pipeline": 0.0,
                "won_mrr": 0.0,
                "cycle_days_sum": 0,
                "cycle_days_count": 0,
            }
        o = owners_map[oid]
        o["total_deals"] += 1

        if d["stage_id"] == WON_STAGE_ID:
            o["won_total"] += 1
            o["won_mrr"] += d["amount"]
        elif d["stage_id"] == LOST_STAGE_ID:
            o["lost_total"] += 1
        else:
            o["active_deals"] += 1
            o["pipeline_value"] += d["amount"]
            o["weighted_pipeline"] += d["weighted_mrr"]

        if is_in_period(d, start_dt, end_dt):
            o["new_this_period"] += 1
        if was_closed_in_period(d, start_dt, end_dt, WON_STAGE_ID):
            o["won_this_period"] += 1
        if was_closed_in_period(d, start_dt, end_dt, LOST_STAGE_ID):
            o["lost_this_period"] += 1

        if d["days_to_close"]:
            o["cycle_days_sum"] += d["days_to_close"]
            o["cycle_days_count"] += 1

    result = []
    for o in owners_map.values():
        closed = o["won_total"] + o["lost_total"]
        o["win_rate"] = round(o["won_total"] / closed * 100, 1) if closed else 0.0
        o["avg_cycle"] = (
            round(o["cycle_days_sum"] / o["cycle_days_count"], 1)
            if o["cycle_days_count"] else None
        )
        o["pipeline_value"] = round(o["pipeline_value"], 2)
        o["weighted_pipeline"] = round(o["weighted_pipeline"], 2)
        o["won_mrr"] = round(o["won_mrr"], 2)
        del o["cycle_days_sum"], o["cycle_days_count"]
        result.append(o)

    result.sort(key=lambda x: x["won_mrr"], reverse=True)
    return result


def calc_sources(deals):
    counts = defaultdict(lambda: {"count": 0, "amount": 0.0})
    for d in deals:
        s = d["source"]
        counts[s]["count"] += 1
        counts[s]["amount"] += d["amount"]
    total = sum(v["count"] for v in counts.values()) or 1
    result = []
    for src, v in sorted(counts.items(), key=lambda x: -x[1]["count"]):
        result.append({
            "source": src,
            "count": v["count"],
            "amount": round(v["amount"], 2),
            "pct": round(v["count"] / total * 100, 1),
        })
    return result


def calc_lost_reasons(deals):
    lost = [d for d in deals if d["stage_id"] == LOST_STAGE_ID and d["lost_reason"]]
    counts = defaultdict(int)
    for d in lost:
        counts[d["lost_reason"]] += 1
    total = len(lost) or 1
    result = []
    for reason, cnt in sorted(counts.items(), key=lambda x: -x[1]):
        result.append({
            "reason": reason,
            "count": cnt,
            "pct": round(cnt / total * 100, 1),
        })
    return result


def calc_segments(deals):
    active = [d for d in deals if d["stage_id"] not in (WON_STAGE_ID, LOST_STAGE_ID)]
    ent = [d for d in active if d["segment"] == "Enterprise"]
    gro = [d for d in active if d["segment"] == "Growth"]

    def avg_amt(lst):
        return round(sum(d["amount"] for d in lst) / len(lst), 2) if lst else 0.0

    return {
        "enterprise": {
            "count": len(ent),
            "avg_amount": avg_amt(ent),
            "total_pipeline": round(sum(d["amount"] for d in ent), 2),
        },
        "growth": {
            "count": len(gro),
            "avg_amount": avg_amt(gro),
            "total_pipeline": round(sum(d["amount"] for d in gro), 2),
        },
    }


def calc_forecast(deals):
    """Total weighted MRR for all active pipeline deals."""
    active = [d for d in deals if d["stage_id"] not in (WON_STAGE_ID, LOST_STAGE_ID)]
    by_stage = {}
    for sid in STAGE_ORDER:
        stage_deals = [d for d in active if d["stage_id"] == sid]
        by_stage[STAGE_MAP[sid]] = {
            "count": len(stage_deals),
            "pipeline": round(sum(d["amount"] for d in stage_deals), 2),
            "weighted": round(sum(d["weighted_mrr"] for d in stage_deals), 2),
            "probability": STAGE_PROBABILITY.get(sid, 0.0),
        }

    total_pipeline = round(sum(d["amount"] for d in active), 2)
    total_weighted = round(sum(d["weighted_mrr"] for d in active), 2)

    return {
        "total_pipeline": total_pipeline,
        "total_weighted": total_weighted,
        "by_stage": by_stage,
        "fallback_deals_count": sum(1 for d in active if d["amount_fallback"]),
    }


# ── Core builder (used by both CLI and serverless API) ────────────────────────

def build_snapshot():
    """Fetch HubSpot data, compute all metrics, return snapshot dict."""
    owners = fetch_owners()
    raw_deals = fetch_all_deals()
    deals = [transform_deal(d, owners) for d in raw_deals]

    ws, we = week_boundaries()
    lws, lwe = last_week_boundaries()

    current_week = calc_period_metrics(deals, ws, we)
    last_week = calc_period_metrics(deals, lws, lwe)
    funnel_stages = calc_funnel_stages(deals)
    funnel_with_conv = calc_conversion_rates(funnel_stages)
    avg_cycle = calc_avg_cycle(deals)
    by_owner = calc_by_owner(deals, ws, we)
    sources = calc_sources(deals)
    lost_reasons = calc_lost_reasons(deals)
    segments = calc_segments(deals)
    forecast = calc_forecast(deals)

    active_deals = sorted(
        [d for d in deals if d["stage_id"] not in (WON_STAGE_ID, LOST_STAGE_ID)],
        key=lambda x: x["amount"],
        reverse=True,
    )

    snapshot = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "pipeline_id": PIPELINE_ID,
        "period": {
            "current_week_start": ws.isoformat(),
            "current_week_end": we.isoformat(),
            "label": f"{ws.strftime('%-d %b')}–{we.strftime('%-d %b %Y')}",
        },
        "summary": {
            "total_deals": len(deals),
            "active_deals": len(active_deals),
            "total_won": sum(1 for d in deals if d["stage_id"] == WON_STAGE_ID),
            "total_lost": sum(1 for d in deals if d["stage_id"] == LOST_STAGE_ID),
            "total_won_mrr": round(sum(d["amount"] for d in deals if d["stage_id"] == WON_STAGE_ID), 2),
            "avg_cycle_days": avg_cycle,
            "overall_win_rate": round(
                sum(1 for d in deals if d["stage_id"] == WON_STAGE_ID) /
                max(1, sum(1 for d in deals if d["stage_id"] in (WON_STAGE_ID, LOST_STAGE_ID))) * 100, 1
            ),
        },
        "current_week": current_week,
        "last_week": last_week,
        "funnel": funnel_with_conv,
        "segments": segments,
        "forecast": forecast,
        "by_owner": by_owner,
        "sources": sources,
        "lost_reasons": lost_reasons,
        "active_deals": active_deals,
        # Placeholders for manual/external data
        "goals": {},
        "session_mrr": None,
        "potential_mrr": None,
        "ps_value": None,
    }
    return snapshot


# ── CLI entry point ───────────────────────────────────────────────────────────

def main():
    if not HUBSPOT_ACCESS_TOKEN:
        print("[ERROR] HUBSPOT_ACCESS_TOKEN not set. Copy .env.example → .env and fill it in.")
        sys.exit(1)

    print("[sync] Starting HubSpot sync…")
    snapshot = build_snapshot()

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2, default=str)

    s = snapshot["summary"]
    fc = snapshot["forecast"]
    cw = snapshot["current_week"]
    print(f"[sync] Snapshot saved → {OUTPUT_PATH}")
    print(f"[sync] Active: {s['active_deals']} | Won all-time: {s['total_won']} | Win rate: {s['overall_win_rate']}%")
    print(f"[sync] Week: {cw['new_deals']} new, {cw['won']} won, {cw['lost']} lost")
    print(f"[sync] Forecast weighted MRR: R${fc['total_weighted']:,.2f}")


if __name__ == "__main__":
    main()
