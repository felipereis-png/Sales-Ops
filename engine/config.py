"""
Moveo Sales Ops — Configuration Constants
Brazil Pipeline: 282308322
"""

import os
from dotenv import load_dotenv

load_dotenv()

# ── HubSpot Auth ────────────────────────────────────────────────────────────
HUBSPOT_ACCESS_TOKEN = os.getenv("HUBSPOT_ACCESS_TOKEN", "")
PIPELINE_ID = os.getenv("PIPELINE_ID", "282308322")

# ── Stage Mapping ────────────────────────────────────────────────────────────
STAGE_MAP = {
    "459596268": "Meeting Scheduled",
    "459596269": "Assessment",
    "471108325": "Product Demo",
    "459596270": "Commercial Proposal",
    "459596271": "Verbal Agreement",
    "459596272": "Contract Sent",
    "459596273": "Deal Won",
    "459596274": "Deal Lost",
}

# Ordered funnel stages (excluding won/lost for conversion calc)
STAGE_ORDER = [
    "459596268",  # Meeting Scheduled
    "459596269",  # Assessment
    "471108325",  # Product Demo
    "459596270",  # Commercial Proposal
    "459596271",  # Verbal Agreement
    "459596272",  # Contract Sent
]

WON_STAGE_ID = "459596273"
LOST_STAGE_ID = "459596274"

# HubSpot deal stage probability (0–1)
STAGE_PROBABILITY = {
    "459596268": 0.10,  # Meeting Scheduled
    "459596269": 0.20,  # Assessment
    "471108325": 0.40,  # Product Demo
    "459596270": 0.60,  # Commercial Proposal
    "459596271": 0.80,  # Verbal Agreement
    "459596272": 0.90,  # Contract Sent
    "459596273": 1.00,  # Deal Won
    "459596274": 0.00,  # Deal Lost
}

# ── Price Fallback (when amount <= 1) ────────────────────────────────────────
PRICE_FALLBACK = {
    "pro":        2000.0,
    "standard":   2490.0,
    "growth":     3225.0,
    "enterprise": 5000.0,
    "custom":    10000.0,
}
PRICE_FALLBACK_DEFAULT = 3225.0  # Growth as generic default

# ── Segment thresholds ────────────────────────────────────────────────────────
ENTERPRISE_THRESHOLD = 5000.0  # amount >= threshold → Enterprise

# ── HubSpot properties to fetch ───────────────────────────────────────────────
DEAL_PROPERTIES = [
    "dealname",
    "dealstage",
    "pipeline",
    "amount",
    "closedate",
    "createdate",
    "hs_lastmodifieddate",
    "hubspot_owner_id",
    "hs_deal_stage_probability",
    # Moveo custom fields
    "deal_source_moveo",
    "type_of_plan",
    "lost_reason",
    "lost_type",
    "industry__segmento_",
    "use_case",
    "expected_no_of_sessions",
    "pre_sales_responsible",
    "days_to_close",
    "entry_on_assesment___demo",
    # Stage entry dates
    "hs_date_entered_459596268",  # Meeting Scheduled
    "hs_date_entered_459596269",  # Assessment
    "hs_date_entered_471108325",  # Product Demo
    "hs_date_entered_459596270",  # Commercial Proposal
    "hs_date_entered_459596271",  # Verbal Agreement
    "hs_date_entered_459596272",  # Contract Sent
    "hs_date_entered_459596273",  # Deal Won
    "hs_date_entered_459596274",  # Deal Lost
]

# ── Source ────────────────────────────────────────────────────────────────────
DEAL_SOURCE_LABELS = {
    "paid_social":     "Paid Social",
    "paid_search":     "Paid Search",
    "organic_search":  "Organic Search",
    "offline":         "Offline / Eventos",
    "direct":          "Direct Traffic",
    "direct_traffic":  "Direct Traffic",
    "referrals":       "Referrals",
    "referral":        "Referrals",
    "outbound":        "Outbound SDR",
    "partner":         "Partners",
    "":                "Não informado",
}
