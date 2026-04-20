"""
Microsoft Graph calendar client — auto-adds trustee-sale events to Matthew's
Outlook calendar. No email, no tap-to-accept, events just appear.

One-time setup (login):   python graph_calendar.py --login
Create test event:        python graph_calendar.py --test
Dump upcoming events:     python graph_calendar.py --list

Token cache (refresh token) persists at MS_TOKEN_CACHE so subsequent runs are
headless. Refresh tokens last 90 days of inactivity, so regular use refreshes.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta

import msal
import urllib.request
import urllib.error


GRAPH_BASE = "https://graph.microsoft.com/v1.0"
SCOPES = ["Calendars.ReadWrite"]


def load_env(path: str = "config.env"):
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()


def _app() -> tuple[msal.PublicClientApplication, msal.SerializableTokenCache]:
    client_id = os.environ["MS_CLIENT_ID"]
    tenant_id = os.environ["MS_TENANT_ID"]
    authority = f"https://login.microsoftonline.com/{tenant_id}"
    cache_path = os.environ.get("MS_TOKEN_CACHE", ".graph_token_cache.json")

    cache = msal.SerializableTokenCache()
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            cache.deserialize(f.read())

    app = msal.PublicClientApplication(client_id, authority=authority, token_cache=cache)
    return app, cache


def _persist_cache(cache: msal.SerializableTokenCache):
    if cache.has_state_changed:
        path = os.environ.get("MS_TOKEN_CACHE", ".graph_token_cache.json")
        with open(path, "w") as f:
            f.write(cache.serialize())
        os.chmod(path, 0o600)


def get_access_token() -> str:
    app, cache = _app()
    accounts = app.get_accounts(username=os.environ.get("MS_USER_EMAIL"))
    result = None
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
    if not result:
        raise RuntimeError("No cached token — run `python graph_calendar.py --login` first.")
    _persist_cache(cache)
    if "access_token" not in result:
        raise RuntimeError(f"Token acquisition failed: {result.get('error_description', result)}")
    return result["access_token"]


def device_login():
    app, cache = _app()
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Failed to start device flow: {flow}")
    print()
    print("=" * 60)
    print(flow["message"])
    print("=" * 60)
    print()
    print("Waiting for login...")
    result = app.acquire_token_by_device_flow(flow)
    _persist_cache(cache)
    if "access_token" not in result:
        raise RuntimeError(f"Login failed: {result.get('error_description', result)}")
    print(f"Logged in as {result.get('id_token_claims', {}).get('preferred_username', '?')}")


def _graph(method: str, path: str, body: dict | None = None) -> dict:
    token = get_access_token()
    url = f"{GRAPH_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Graph {method} {path} failed: {e.code} {e.read().decode()}")


def create_event(subject: str, start_iso: str, end_iso: str, body_html: str,
                 location: str = "", timezone: str = "Pacific Standard Time",
                 reminder_minutes: int = 1440) -> dict:
    """Create an event on Matthew's primary calendar."""
    payload = {
        "subject": subject,
        "body": {"contentType": "HTML", "content": body_html},
        "start": {"dateTime": start_iso, "timeZone": timezone},
        "end": {"dateTime": end_iso, "timeZone": timezone},
        "location": {"displayName": location} if location else {},
        "isReminderOn": True,
        "reminderMinutesBeforeStart": reminder_minutes,
        "showAs": "busy",
    }
    return _graph("POST", "/me/events", payload)


def find_event_by_subject(subject_substring: str, days_ahead: int = 120) -> list[dict]:
    start = datetime.utcnow().isoformat() + "Z"
    end = (datetime.utcnow() + timedelta(days=days_ahead)).isoformat() + "Z"
    path = f"/me/calendarView?startDateTime={start}&endDateTime={end}&$top=100"
    resp = _graph("GET", path)
    return [e for e in resp.get("value", []) if subject_substring.lower() in e.get("subject", "").lower()]


def list_upcoming(days: int = 30) -> list[dict]:
    start = datetime.utcnow().isoformat() + "Z"
    end = (datetime.utcnow() + timedelta(days=days)).isoformat() + "Z"
    path = f"/me/calendarView?startDateTime={start}&endDateTime={end}&$top=50&$orderby=start/dateTime"
    return _graph("GET", path).get("value", [])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--login", action="store_true", help="Run device-code login to cache refresh token")
    ap.add_argument("--test", action="store_true", help="Create a test event tomorrow at 9am")
    ap.add_argument("--list", action="store_true", help="List upcoming events (sanity check)")
    args = ap.parse_args()

    load_env()
    if not os.environ.get("MS_CLIENT_ID") or not os.environ.get("MS_TENANT_ID"):
        print("ERROR: MS_CLIENT_ID / MS_TENANT_ID not set in config.env")
        sys.exit(1)

    if args.login:
        device_login()
        return

    if args.test:
        tomorrow = (datetime.now() + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
        start_iso = tomorrow.strftime("%Y-%m-%dT%H:%M:%S")
        end_iso = (tomorrow + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        ev = create_event(
            subject="FORECLOSURE UPDATE! Graph API test event",
            start_iso=start_iso,
            end_iso=end_iso,
            body_html="<b>Test event</b> created via Microsoft Graph API to confirm auto-add works.",
            location="123 Sesame Street, Sesame, NY",
        )
        print(f"Created event {ev.get('id', '?')[:16]}… on {start_iso}")
        print(f"Web link: {ev.get('webLink', '?')}")
        return

    if args.list:
        events = list_upcoming(30)
        if not events:
            print("(no upcoming events in next 30 days)")
            return
        for e in events:
            when = e.get("start", {}).get("dateTime", "?")[:16]
            subj = e.get("subject", "?")
            print(f"  {when}  {subj}")
        return

    ap.print_help()


if __name__ == "__main__":
    main()
