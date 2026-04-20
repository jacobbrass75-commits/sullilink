"""
RealNex CRM Custom Field Mapping for Sullivan Foreclosure Business

These mappings were reverse-engineered from the CRM's /api/v1/Crm/definitions/property_info endpoint.
Matthew Sullivan's RealNex account at Lee Associates uses custom fields for foreclosure tracking.
"""

# ── Foreclosure Date Fields (userdate_*) ─────────────────────────────
# API field name -> CRM UI label
DATE_FIELDS = {
    "userDate1": "NOD",                          # Notice of Default date
    "userDate2": "Sale Date",                     # Trustee Sale date
    "userDate3": "Back to Beneficiary On",
    "userDate4": "NOS",                           # Notice of Sale date
    "userdate13": "Foreclosure Document Type",
    "userdate17": "Foreclosure Recording Date",
    "userdate26": "LIS",                          # Lis Pendens date
    "userdate27": "1st Loan Recording Date",
}

# ── Foreclosure Text Fields (user_*) ────────────────────────────────
TEXT_FIELDS = {
    "user1": "Use",
    "user2": "APN",
    "user3": "Costar Link",
    "user4": "Estimated Value",
    "user5": "Assessed Value",
    "user6": "Purchase Date",
    "user7": "Purchase Amount",
    "user8": "TS #",                              # Trustee Sale number
    "user9": "Trustee Website or Phone #",
    "user10": "NOD Document # (Title)",
    "user11": "Loan Number",
    "user12": "Case #",
    "user13": "Court Case Website",
    "user14": "Bene/Client Name",                 # Beneficiary / Lender
    "user15": "Bene/Client Street Address",
    "user16": "Bene/Client Suite #",
    "user17": "Bene/Client City",
    "user18": "Bene/Client Phone #",
    "user19": "Trustee Name",
    "user20": "Trustee Street Address",
    "user21": "Trustee Suite #",
    "user22": "Trustee City",
    "user23": "Trustee Phone #",
    "user24": "Borrower/Owner",
    "user25": "Owner Phone Number",
    "user26": "Owner Email",
    "user27": "Owner Address",
    "user28": "Bene/Client Email",
    "user29": "Bene/Client Contact",
    "user30": "Deal Status",
}

# ── Number Fields (usernumber_*) ─────────────────────────────────────
NUMBER_FIELDS = {
    "userNumber1": "Parking SQFT",
    "userNumber2": "% Complete",
    "userNumber3": "Opening Bid/Sale Amount",
}

# ── Standard Fields Repurposed ───────────────────────────────────────
STANDARD_OVERRIDES = {
    "buildingClass": "Foreclosure Stage",         # e.g. "NOD", "NOS", "REO"
    "assessed": "1st Original Lender",
    "description": "Prop Sub-Type",
    "mapCoord": "Tenancy",
    "acres": "Owner Type",
    "webSite": "SHAREPOINT",
    "lastTransDate": "Last Updated",
}

# ── Logical/Boolean Fields ───────────────────────────────────────────
LOGICAL_FIELDS = {
    "logical21": "BPO or Strategic Analysis Done",
}


# ── Helper: Build update payload for foreclosure dates ───────────────
def build_date_update(nod: str = None, nos: str = None, sale_date: str = None,
                      recording_date: str = None, lis: str = None) -> dict:
    """Build a userDataFields dict for updating foreclosure dates.

    Dates should be ISO format: '2026-04-15T00:00:00'
    """
    update = {}
    if nod:
        update["userDate1"] = nod
    if sale_date:
        update["userDate2"] = sale_date
    if nos:
        update["userDate4"] = nos
    if recording_date:
        update["userdate17"] = recording_date
    if lis:
        update["userdate26"] = lis
    return {"userDataFields": update} if update else {}
