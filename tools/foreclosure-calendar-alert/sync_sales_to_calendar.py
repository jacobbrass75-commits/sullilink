"""
Create RealNex calendar events for upcoming trustee sales, with Matthew as a
participant so the CRM sends him the reminder natively (no SMTP needed).

Two modes:
    --csv <path>   Read rows from CSV/XLSX import file (before CRM import).
                   No property link (property doesn't exist in CRM yet).
    --crm          Pull all properties from RealNex, find ones with Sale Date
                   in the next N days (--days, default 30), and create events
                   linked to the property. Idempotent — skips a property if
                   an event for that sale date already exists.

The event carries Lender / Bene / Client Contact info in the notes so Matthew
knows who to call before the sale.
"""
import argparse
import csv
import os
import sys
from datetime import datetime, timedelta

from realnex_client import RealNexClient


MATTHEW_USER_KEY = "7eca10a1-f270-4529-9d4a-9e6ba78e98f1"
MATTHEW_EMAIL = "matthew.sullivan@lee-associates.com"
JOE_USER_KEY = "dcb9522b-a9ce-4d1e-8222-07243dd7d3db"

EVENT_TYPE_PHONE_CALL = 1
EVENT_TYPE_TODO = 4
PRIORITY_HIGH = 1


def load_env(path: str = "config.env"):
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()


def _row_from_xlsx(path: str) -> dict:
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    data = next(rows)
    return {h: (str(v) if v is not None else "") for h, v in zip(header, data)}


def _row_from_csv(path: str) -> dict:
    with open(path) as f:
        return next(csv.DictReader(f))


def build_subject_and_notes(row: dict) -> tuple[str, str]:
    address_line = f"{row.get('Address', '?')}, {row.get('City', '?')}, {row.get('State', '?')} {row.get('Zip', '')}".strip(", ")
    sale_date = row.get("Sale Date", "?")
    subject = f"FORECLOSURE UPDATE! Trustee Sale {sale_date} — {row.get('Address', '?')}"

    notes = (
        f"<b>Upcoming Trustee Sale</b><br/>"
        f"<b>Property:</b> {address_line}<br/>"
        f"<b>APN:</b> {row.get('APN', '?')}<br/>"
        f"<b>Sale Date:</b> {sale_date}<br/>"
        f"<b>Stage:</b> {row.get('Foreclosure Stage', '?')}<br/>"
        f"<b>TS #:</b> {row.get('TS #', '?')}<br/>"
        f"<b>Opening Bid:</b> ${row.get('Opening Bid/Sale Amount', 'TBD')}<br/><br/>"
        f"<b>LENDER / BENEFICIARY CONTACT</b><br/>"
        f"<b>Lender:</b> {row.get('Bene/Client Name', '?')}<br/>"
        f"<b>Contact:</b> {row.get('Bene/Client Contact', '?')}<br/>"
        f"<b>Phone:</b> {row.get('Bene/Client Phone #', '?')}<br/>"
        f"<b>Email:</b> {row.get('Bene/Client Email', '?')}<br/><br/>"
        f"Call the contact before the sale to discuss reinstatement or buy-at-sale posture."
    )
    return subject, notes


def sale_date_to_iso(sale_date_str: str) -> tuple[str, str]:
    for fmt in ("%m/%d/%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(sale_date_str, fmt)
            start = dt.replace(hour=9, minute=0, second=0)
            end = dt.replace(hour=10, minute=0, second=0)
            return start.strftime("%Y-%m-%dT%H:%M:%S"), end.strftime("%Y-%m-%dT%H:%M:%S")
        except ValueError:
            continue
    raise ValueError(f"Unrecognized sale date format: {sale_date_str!r}")


def create_sale_event(client: RealNexClient, row: dict, property_key: str | None,
                      owner_user_key: str = MATTHEW_USER_KEY,
                      participants: list[tuple[str, str, str]] | None = None) -> str:
    """Create the event + attach participants + optional property link. Returns event key."""
    subject, notes = build_subject_and_notes(row)
    start_iso, end_iso = sale_date_to_iso(row["Sale Date"])

    event_body = {
        "userKey": owner_user_key,
        "subject": subject,
        "startDate": start_iso,
        "endDate": end_iso,
        "eventTypeKey": EVENT_TYPE_PHONE_CALL,
        "priorityKey": PRIORITY_HIGH,
        "alarmMinutes": 10080,
        "allDay": False,
        "timeless": False,
        "finished": False,
        "notes": notes,
    }
    ev = client.create_event(event_body)
    event_key = ev.get("key")
    if not event_key:
        raise RuntimeError(f"create_event returned no key: {ev}")

    parts = participants or [(MATTHEW_USER_KEY, "Matthew Sullivan", MATTHEW_EMAIL)]
    part_bodies = [{"key": k} for k, _, _ in parts]
    try:
        client._request("POST", f"/api/v1/Crm/event/{event_key}/participant", part_bodies)
    except Exception:
        pass
    got = client._request("GET", f"/api/v1/Crm/event/{event_key}/participant")
    existing = {p.get("key", "").lower() for p in (got or [])}
    missing = [k for k, _, _ in parts if k.lower() not in existing]
    if missing:
        raise RuntimeError(f"participant add failed for {missing}; event={event_key}")

    if property_key:
        obj_body = [{"key": property_key, "type": "Property",
                     "description": row.get("Property Name") or row.get("Address", "")}]
        client._request("POST", f"/api/v1/Crm/event/{event_key}/object", obj_body)

    return event_key


def run_csv_mode(client: RealNexClient, path: str, dry_run: bool):
    if path.endswith(".xlsx"):
        row = _row_from_xlsx(path)
    else:
        row = _row_from_csv(path)

    subject, notes = build_subject_and_notes(row)
    print(f"SUBJECT: {subject}")
    print(f"SALE DATE: {row.get('Sale Date')}")
    print(f"Participant: Matthew Sullivan <{MATTHEW_EMAIL}>")
    print()
    print("NOTES (HTML):")
    print(notes.replace("<br/>", "\n").replace("<b>", "").replace("</b>", ""))

    if dry_run:
        print("\n[DRY RUN — no event created]")
        return

    key = create_sale_event(client, row, property_key=None)
    print(f"\nCreated RealNex event: {key}")
    print(f"Matthew should see it on his RealNex calendar shortly.")


def run_crm_mode(client: RealNexClient, days: int, dry_run: bool):
    print(f"Scanning RealNex properties for sales in next {days} days...")
    today = datetime.now()
    cutoff = today + timedelta(days=days)
    found = 0
    for prop in client.iter_all_properties(page_size=50):
        key = prop["Key"]
        full = client.get_property_details(key)
        uf = full.get("userFields", {}) or {}
        udf = full.get("userDataFields", {}) or {}
        sale_raw = udf.get("userDate2") or uf.get("userDate2")
        if not sale_raw:
            continue
        try:
            sale_dt = datetime.fromisoformat(sale_raw.replace("Z", ""))
        except Exception:
            continue
        if not (today <= sale_dt <= cutoff):
            continue
        found += 1
        addr = prop.get("Address", {}) or {}
        row = {
            "Property Name": prop.get("PropertyName") or "",
            "Address": addr.get("Address1", ""),
            "City": addr.get("City", ""),
            "State": addr.get("State", ""),
            "Zip": addr.get("ZipCode", ""),
            "Sale Date": sale_dt.strftime("%m/%d/%Y"),
            "APN": uf.get("user2", ""),
            "Foreclosure Stage": prop.get("BuildingClass") or "",
            "TS #": uf.get("user8", ""),
            "Opening Bid/Sale Amount": udf.get("userNumber3", ""),
            "Bene/Client Name": uf.get("user14", ""),
            "Bene/Client Contact": uf.get("user29", ""),
            "Bene/Client Phone #": uf.get("user18", ""),
            "Bene/Client Email": uf.get("user28", ""),
        }
        subject, _ = build_subject_and_notes(row)
        print(f"  {row['Sale Date']} — {row['Address']} (key {key[:8]})")
        existing = client._request("GET", f"/api/v1/Crm/object/{key}/event") or []
        if any("FORECLOSURE UPDATE" in (e.get("subject") or "") for e in existing):
            print(f"    event already exists for this property — skip")
            continue
        if dry_run:
            continue
        ev_key = create_sale_event(client, row, property_key=key)
        print(f"    created event {ev_key}")
    print(f"\n{found} upcoming sale(s) in window.")
    if dry_run:
        print("[DRY RUN — no events created]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="Path to CSV or XLSX import file (one row)")
    ap.add_argument("--crm", action="store_true", help="Scan CRM for upcoming sales")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    load_env()
    token = os.environ.get("REALNEX_API_TOKEN")
    if not token:
        print("ERROR: REALNEX_API_TOKEN not set")
        sys.exit(1)
    client = RealNexClient(token=token)

    if args.csv:
        run_csv_mode(client, args.csv, args.dry_run)
    elif args.crm:
        run_crm_mode(client, args.days, args.dry_run)
    else:
        print("Specify --csv <path> or --crm")
        sys.exit(1)


if __name__ == "__main__":
    main()
