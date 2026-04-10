# RealNex Foreclosure Tracker

Automated foreclosure date tracking for Sullivan CRE business. Connects RealNex CRM to PropertyRadar and RETRAN to keep NOD, NOS, and Trustee Sale dates current, and sends Outlook calendar reminders for upcoming sales.

## Architecture

```
PropertyRadar / RETRAN  -->  update_foreclosure_dates.py  -->  RealNex CRM
                                      |
                                      v
                              upcoming_sales.json
                                      |
                                      v
                          send_calendar_reminders.py  -->  Outlook Calendar
```

## Setup

1. Copy `config.example.env` to `config.env` and fill in credentials:
   - **RealNex API Token**: Found in RealNex CRM under User Management (JWT)
   - **PropertyRadar API Token**: Account Settings -> scroll to bottom -> Integration Name -> reveal key
   - **RETRAN**: Login credentials for retran.net

2. Run the updater:
   ```bash
   python update_foreclosure_dates.py
   ```

3. Send calendar reminders (for sales within 30 days):
   ```bash
   python send_calendar_reminders.py
   ```

## API Reference

### RealNex CRM API
- **Base URL**: `https://sync.realnex.com`
- **Auth**: `Authorization: Bearer <JWT>`
- **Swagger**: `https://sync.realnex.com/swagger` (v1 and v2)
- **OData queries**: `/api/v1/CrmOData/Contacts`, `/Properties`, `/Companies`, etc.
- **CRUD**: `/api/v1/Crm/property/{key}`, `/contact/{key}`, `/company/{key}`, etc.

### PropertyRadar API
- **Base URL**: `https://api.propertyradar.com/v1`
- **Auth**: `Authorization: Bearer <API_TOKEN>` (NOT the web login session)
- **Login** (web session only): `POST https://app.propertyradar.com/api/v1/sessions`
- **Search**: `POST /v1/properties` with Criteria array
- **Docs**: `https://developers.propertyradar.com/`

### RETRAN
- **Site**: `https://www.retran.net`
- **Auth**: Form-based login (ASP session cookies)
- **No API** - web scraping required
- **Limit**: Only allows a few active sessions at a time

## RealNex Custom Field Mapping

See `field_mapping.py` for complete mapping. Key fields:

| API Field | CRM Label |
|-----------|-----------|
| `userDate1` | NOD (Notice of Default) |
| `userDate2` | Sale Date |
| `userDate3` | Back to Beneficiary On |
| `userDate4` | NOS (Notice of Sale) |
| `userdate17` | Foreclosure Recording Date |
| `userdate26` | LIS (Lis Pendens) |
| `user2` | APN |
| `user14` | Bene/Client Name |
| `user19` | Trustee Name |
| `user23` | Trustee Phone # |
| `user24` | Borrower/Owner |
| `usernumber3` | Opening Bid/Sale Amount |
| `buildingClass` | Foreclosure Stage |

## Files

| File | Purpose |
|------|---------|
| `realnex_client.py` | RealNex CRM API client (full CRUD for all entities) |
| `propertyradar_client.py` | PropertyRadar API client (search by APN, get foreclosure data) |
| `retran_client.py` | RETRAN web scraper client (login + search) |
| `field_mapping.py` | CRM custom field definitions and helper functions |
| `update_foreclosure_dates.py` | Main script: pull properties, lookup dates, update CRM |
| `send_calendar_reminders.py` | Send Outlook calendar invites for upcoming sales |
| `config.example.env` | Template for credentials (copy to config.env) |

## TODO

- [ ] Get PropertyRadar API token (Account Settings -> Integration Name)
- [ ] Get RETRAN sessions cleared (call 1-877-711-1147 or log out other sessions)
- [ ] Set up Microsoft Graph API or SMTP for calendar reminders
- [ ] Add PropertyRadar field mapping once API token is working
- [ ] Parse RETRAN HTML results into structured data
- [ ] Add rate limiting for bulk API calls
- [ ] Add logging and error recovery for interrupted runs
