"""
Main script: Pull all properties from RealNex CRM, look up foreclosure dates
from PropertyRadar, update the CRM, and flag upcoming sale dates.

Usage:
    1. Copy config.example.env to config.env and fill in your credentials
    2. Run: python update_foreclosure_dates.py

Requirements:
    - RealNex API token (JWT from User Management)
    - PropertyRadar API token (from Account Settings -> Integration Name)
"""
import os
import json
import sys
from datetime import datetime, timedelta
from realnex_client import RealNexClient
from propertyradar_client import PropertyRadarClient
from field_mapping import DATE_FIELDS, TEXT_FIELDS, build_date_update


def load_env(path: str = "config.env"):
    """Load environment variables from a config file."""
    if not os.path.exists(path):
        print(f"ERROR: {path} not found. Copy config.example.env to config.env and fill in credentials.")
        sys.exit(1)
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ[key.strip()] = val.strip()


def main():
    load_env()

    realnex_token = os.environ.get("REALNEX_API_TOKEN")
    pr_token = os.environ.get("PROPERTYRADAR_API_TOKEN")

    if not realnex_token:
        print("ERROR: REALNEX_API_TOKEN not set in config.env")
        sys.exit(1)
    if not pr_token:
        print("ERROR: PROPERTYRADAR_API_TOKEN not set in config.env")
        print("Get it from PropertyRadar -> Account Settings -> Integration Name")
        sys.exit(1)

    crm = RealNexClient(realnex_token)
    pr = PropertyRadarClient(api_token=pr_token)

    # Step 1: Count and pull all properties
    total = crm.count_properties()
    print(f"Found {total} properties in RealNex CRM")

    upcoming_sales = []
    updated = 0
    errors = 0
    today = datetime.now()
    alert_window = today + timedelta(days=30)  # Flag sales within 30 days

    # Step 2: Iterate all properties
    for i, prop in enumerate(crm.iter_all_properties(page_size=100)):
        key = prop["Key"]
        address = prop.get("Address", {})
        addr_str = f"{address.get('Address1', '?')}, {address.get('City', '?')} {address.get('State', '?')}"

        # Get full details to read APN
        full = crm.get_property_full(key)
        user_fields = full.get("userFields", {})
        apn = user_fields.get("user2", "")

        if not apn:
            print(f"  [{i+1}/{total}] {addr_str} — no APN, skipping")
            continue

        print(f"  [{i+1}/{total}] {addr_str} (APN: {apn})")

        # Step 3: Look up foreclosure dates on PropertyRadar
        try:
            pr_result = pr.lookup_by_apn(apn)
            pr_properties = pr_result.get("results", [])
            if not pr_properties:
                print(f"    -> Not found on PropertyRadar")
                continue

            pr_data = pr_properties[0]
            nod_date = pr_data.get("NODDate")
            nos_date = pr_data.get("NOSDate")
            sale_date = pr_data.get("AuctionDate") or pr_data.get("TrusteeSaleDate")
            recording_date = pr_data.get("ForeclosureRecordingDate")

            print(f"    -> NOD: {nod_date}, NOS: {nos_date}, Sale: {sale_date}")

        except Exception as e:
            print(f"    -> PropertyRadar error: {e}")
            errors += 1
            continue

        # Step 4: Update RealNex CRM with the dates
        try:
            date_update = build_date_update(
                nod=nod_date,
                nos=nos_date,
                sale_date=sale_date,
                recording_date=recording_date,
            )
            if date_update:
                crm.update_property_details(key, date_update)
                updated += 1
                print(f"    -> CRM updated")
        except Exception as e:
            print(f"    -> CRM update error: {e}")
            errors += 1

        # Step 5: Flag upcoming sales
        if sale_date:
            try:
                sale_dt = datetime.fromisoformat(sale_date.replace("Z", ""))
                if today <= sale_dt <= alert_window:
                    upcoming_sales.append({
                        "address": addr_str,
                        "apn": apn,
                        "sale_date": sale_date,
                        "key": key,
                    })
            except (ValueError, TypeError):
                pass

    # Summary
    print(f"\n{'='*60}")
    print(f"Done! Updated {updated}/{total} properties. Errors: {errors}")

    if upcoming_sales:
        print(f"\n🔥 UPCOMING SALES (next 30 days):")
        for s in sorted(upcoming_sales, key=lambda x: x["sale_date"]):
            print(f"  {s['sale_date'][:10]} — {s['address']} (APN: {s['apn']})")

        # Save to file for calendar integration
        with open("upcoming_sales.json", "w") as f:
            json.dump(upcoming_sales, f, indent=2)
        print(f"\nSaved {len(upcoming_sales)} upcoming sales to upcoming_sales.json")
        print("Run send_calendar_reminders.py to email Outlook calendar invites.")
    else:
        print("\nNo trustee sales in the next 30 days.")


if __name__ == "__main__":
    main()
