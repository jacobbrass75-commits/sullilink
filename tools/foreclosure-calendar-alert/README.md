# Foreclosure Calendar Alert

Automated trustee-sale reminders for Matthew Sullivan's foreclosure business.
Pulls upcoming sale dates from RealNex CRM (or a CSV/XLSX import) and surfaces
them on his Outlook calendar so he doesn't miss a sale.

## Two delivery paths

### Path A — SMTP + .ics attachment (no IT approval needed)
Sends an email from Matthew's own Office365 address to himself with a
`.ics` meeting attachment. He taps the attachment on his phone → "Add to
Calendar" → event lands on his Outlook calendar with 1-day and 1-hour
reminders baked in.

- **Pros:** works today with only an Outlook app password, no Azure setup
- **Cons:** one tap per property (not fully silent)

### Path B — Microsoft Graph API (fully automated, no tap)
Writes events directly to his primary Outlook calendar via Microsoft Graph.
Zero email, zero tap — events just appear.

- **Pros:** fully headless, clean
- **Cons:** requires Azure app registration + tenant admin consent
  (Lee & Associates locks down third-party app consent, so an IT admin has
  to approve the registered app once)

## Files

| File | Purpose |
|---|---|
| `graph_calendar.py` | Microsoft Graph client (Path B). Device-code login, token cache, create/list events. |
| `send_sale_reminder.py` | One-off CSV-driven .ics email (Path A). Handy for testing a single property. |
| `send_calendar_reminders.py` | Batch .ics emailer from `upcoming_sales.json` (Path A). |
| `sync_sales_to_calendar.py` | RealNex-native calendar events (dormant — Matthew doesn't use RealNex calendar). |
| `realnex_client.py` | Shared RealNex REST client (urllib-based; bundled copy). |
| `field_mapping.py` | RealNex custom-field reference (userDate2 = Sale Date, user29 = Bene contact, etc.). |
| `sesame_street_import.csv` | Fake test property for end-to-end sanity checks. |

## Setup

1. Copy `config.example.env` → `config.env` and fill in:
   - `REALNEX_API_TOKEN` — JWT from RealNex User Management
   - `SMTP_USER` / `SMTP_PASSWORD` — Matthew's Office365 app password (Path A only)
   - `MS_CLIENT_ID` / `MS_TENANT_ID` — from Azure app registration (Path B only)

2. **Path A** setup:
   ```bash
   python3 send_sale_reminder.py --csv sesame_street_import.csv --dry-run
   python3 send_sale_reminder.py --csv sesame_street_import.csv
   ```

3. **Path B** setup (after Lee IT approves the Azure app):
   ```bash
   python3 graph_calendar.py --login   # one-time device-code auth
   python3 graph_calendar.py --test    # sanity-check write
   python3 graph_calendar.py --list    # show upcoming events
   ```

## Known RealNex API limitations

- `PUT /contact/{key}` and `PUT /property/{key}` return 415 regardless of
  Content-Type — RealNex API bug.
- `POST /property` silently drops `userFields` / `userDataFields` /
  `user1-30` / `userDate1-27` / `userNumber1-3`. Top-level fields persist;
  custom foreclosure fields do not.
- **Workaround:** populate foreclosure fields via the RealNex UI or CSV
  bulk import. See `sesame_street_import.csv` for the exact column headers
  RealNex's automap expects.
