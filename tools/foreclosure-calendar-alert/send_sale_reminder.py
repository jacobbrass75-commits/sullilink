"""
Send an upcoming-sale reminder email to Matthew for a single property.
Pulls Bene/Client Contact info so he knows who to call.

Data can come from the import CSV/XLSX (before CRM import) OR from RealNex
via APN/PropertyName once the property is in the CRM.

Usage:
    python send_sale_reminder.py --csv sesame_street_import.csv
    python send_sale_reminder.py --property-name "123 Sesame Street (TEST)"
"""
import argparse
import csv
import os
import smtplib
import sys
from datetime import datetime
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders

from send_calendar_reminders import create_ics_event


def load_env(path: str = "config.env"):
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()


def _row_from_csv(path: str) -> dict:
    with open(path) as f:
        return next(csv.DictReader(f))


def _row_from_crm(property_name: str) -> dict:
    # Placeholder for when custom fields are writable through the CRM.
    # For now we rely on the CSV since the API can't round-trip foreclosure fields.
    raise NotImplementedError(
        "CRM read path not wired — foreclosure fields can't be written via API yet. "
        "Use --csv for now."
    )


def build_email(row: dict) -> tuple[str, str, str]:
    address = f"{row['Address']}, {row['City']}, {row['State']} {row['Zip']}"
    apn = row.get("APN", "?")
    sale_date = row["Sale Date"]

    bene_contact = row.get("Bene/Client Contact") or "Unknown"
    bene_phone = row.get("Bene/Client Phone #") or "Not provided"
    bene_email = row.get("Bene/Client Email") or "Not provided"
    bene_name = row.get("Bene/Client Name") or "Unknown"
    opening_bid = row.get("Opening Bid/Sale Amount") or "TBD"
    ts_num = row.get("TS #") or "?"
    stage = row.get("Foreclosure Stage") or "?"

    subject = f"FORECLOSURE UPDATE! Trustee Sale {sale_date} - {row['Address']}"
    body = (
        f"Upcoming Trustee Sale — ACTION REQUIRED\n"
        f"{'='*50}\n\n"
        f"Property: {address}\n"
        f"APN: {apn}\n"
        f"Sale Date: {sale_date}\n"
        f"Stage: {stage}\n"
        f"TS #: {ts_num}\n"
        f"Opening Bid: ${opening_bid}\n\n"
        f"LENDER / BENEFICIARY CONTACT\n"
        f"{'-'*50}\n"
        f"Lender: {bene_name}\n"
        f"Contact: {bene_contact}\n"
        f"Phone:   {bene_phone}\n"
        f"Email:   {bene_email}\n\n"
        f"Call this contact before the sale to discuss reinstatement,\n"
        f"buy-at-sale posture, or any open questions.\n"
    )
    return subject, body, address, apn, sale_date


def send(to_email: str, subject: str, body: str, ics: str):
    user = os.environ.get("SMTP_USER")
    pw = os.environ.get("SMTP_PASSWORD")
    host = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
    port = int(os.environ.get("SMTP_PORT", "587"))
    if not user or not pw:
        return False, "SMTP_USER and SMTP_PASSWORD not set"

    msg = MIMEMultipart()
    msg["From"] = user
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))

    ics_part = MIMEBase("text", "calendar", method="REQUEST")
    ics_part.set_payload(ics.encode())
    encoders.encode_base64(ics_part)
    ics_part.add_header("Content-Disposition", "attachment", filename="sale.ics")
    msg.attach(ics_part)

    with smtplib.SMTP(host, port) as server:
        server.starttls()
        server.login(user, pw)
        server.sendmail(user, to_email, msg.as_string())
    return True, "sent"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="Read property row from this CSV")
    ap.add_argument("--property-name", help="Look up in RealNex by property name (NYI)")
    ap.add_argument("--to", default=os.environ.get("NOTIFY_EMAIL", "matthew.sullivan@lee-associates.com"))
    ap.add_argument("--dry-run", action="store_true", help="Print the email, don't send")
    args = ap.parse_args()

    load_env()

    if args.csv:
        row = _row_from_csv(args.csv)
    elif args.property_name:
        row = _row_from_crm(args.property_name)
    else:
        print("ERROR: provide --csv or --property-name")
        sys.exit(1)

    subject, body, address, apn, sale_date = build_email(row)
    sale_iso = datetime.strptime(sale_date, "%m/%d/%Y").strftime("%Y-%m-%dT09:00:00")
    ics = create_ics_event(address, apn, sale_iso)

    if args.dry_run:
        print(f"TO: {args.to}")
        print(f"SUBJECT: {subject}\n")
        print(body)
        return

    ok, info = send(args.to, subject, body, ics)
    if ok:
        print(f"Sent reminder to {args.to}")
    else:
        preview = f"preview_{sale_iso[:10]}_sesame_reminder.txt"
        with open(preview, "w") as f:
            f.write(f"TO: {args.to}\nSUBJECT: {subject}\n\n{body}")
        print(f"Could not send ({info}) — preview saved to {preview}")


if __name__ == "__main__":
    main()
