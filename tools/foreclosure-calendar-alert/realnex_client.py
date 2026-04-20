"""
RealNex CRM API Client
Base URL: https://sync.realnex.com
Auth: Bearer token (JWT from User Management)
"""
import urllib.request
import ssl
import json
from typing import Optional


class RealNexClient:
    def __init__(self, token: str, base_url: str = "https://sync.realnex.com"):
        self.token = token
        self.base_url = base_url
        self.ctx = ssl.create_default_context()

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        })
        resp = urllib.request.urlopen(req, timeout=30, context=self.ctx)
        raw = resp.read().decode()
        return json.loads(raw) if raw else {}

    # ── OData Queries (bulk read) ────────────────────────────────────
    def get_all_contacts(self, top: int = 100, skip: int = 0) -> dict:
        return self._request("GET", f"/api/v1/CrmOData/Contacts?$top={top}&$skip={skip}")

    def get_all_properties(self, top: int = 100, skip: int = 0) -> dict:
        return self._request("GET", f"/api/v1/CrmOData/Properties?$top={top}&$skip={skip}")

    def get_all_companies(self, top: int = 100, skip: int = 0) -> dict:
        return self._request("GET", f"/api/v1/CrmOData/Companies?$top={top}&$skip={skip}")

    def get_all_projects(self, top: int = 100, skip: int = 0) -> dict:
        return self._request("GET", f"/api/v1/CrmOData/Projects?$top={top}&$skip={skip}")

    def get_all_sale_comps(self, top: int = 100, skip: int = 0) -> dict:
        return self._request("GET", f"/api/v1/CrmOData/SaleComps?$top={top}&$skip={skip}")

    def get_all_lease_comps(self, top: int = 100, skip: int = 0) -> dict:
        return self._request("GET", f"/api/v1/CrmOData/LeaseComps?$top={top}&$skip={skip}")

    def get_all_spaces(self, top: int = 100, skip: int = 0) -> dict:
        return self._request("GET", f"/api/v1/CrmOData/Spaces?$top={top}&$skip={skip}")

    def count_properties(self) -> int:
        data = self._request("GET", "/api/v1/CrmOData/Properties?$count=true&$top=0")
        return data.get("@odata.count", 0)

    # ── Property CRUD ────────────────────────────────────────────────
    def get_property(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/property/{key}")

    def get_property_full(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/property/{key}/full")

    def get_property_details(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/property/{key}/details")

    def update_property(self, key: str, data: dict) -> dict:
        return self._request("PUT", f"/api/v1/Crm/property/{key}", data)

    def update_property_details(self, key: str, data: dict) -> dict:
        return self._request("PUT", f"/api/v1/Crm/property/{key}/details", data)

    def create_property(self, data: dict) -> dict:
        return self._request("POST", "/api/v1/Crm/property", data)

    def delete_property(self, key: str) -> dict:
        return self._request("DELETE", f"/api/v1/Crm/property/{key}")

    # ── Contact CRUD ─────────────────────────────────────────────────
    def get_contact(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/contact/{key}")

    def get_contact_full(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/contact/{key}/full")

    def update_contact(self, key: str, data: dict) -> dict:
        return self._request("PUT", f"/api/v1/Crm/contact/{key}", data)

    def create_contact(self, data: dict) -> dict:
        return self._request("POST", "/api/v1/Crm/contact", data)

    def delete_contact(self, key: str) -> dict:
        return self._request("DELETE", f"/api/v1/Crm/contact/{key}")

    # ── Company CRUD ─────────────────────────────────────────────────
    def get_company(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/company/{key}")

    def get_company_full(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/company/{key}/full")

    def update_company(self, key: str, data: dict) -> dict:
        return self._request("PUT", f"/api/v1/Crm/company/{key}", data)

    def create_company(self, data: dict) -> dict:
        return self._request("POST", "/api/v1/Crm/company", data)

    # ── Project/Deal CRUD ────────────────────────────────────────────
    def get_project(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/project/{key}")

    def get_project_full(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/project/{key}/full")

    def update_project(self, key: str, data: dict) -> dict:
        return self._request("PUT", f"/api/v1/Crm/project/{key}", data)

    def create_project(self, data: dict) -> dict:
        return self._request("POST", "/api/v1/Crm/project", data)

    # ── Events ───────────────────────────────────────────────────────
    def get_event(self, key: str) -> dict:
        return self._request("GET", f"/api/v1/Crm/event/{key}")

    def create_event(self, data: dict) -> dict:
        return self._request("POST", "/api/v1/Crm/event", data)

    def update_event(self, key: str, data: dict) -> dict:
        return self._request("PUT", f"/api/v1/Crm/event/{key}", data)

    # ── History ──────────────────────────────────────────────────────
    def create_history(self, data: dict) -> dict:
        return self._request("POST", "/api/v1/Crm/history", data)

    # ── Lookups ──────────────────────────────────────────────────────
    def get_field_definitions(self, table_name: Optional[str] = None) -> list:
        path = f"/api/v1/Crm/definitions/{table_name}" if table_name else "/api/v1/Crm/definitions"
        return self._request("GET", path)

    def get_property_types(self) -> list:
        return self._request("GET", "/api/v1/Crm/propertytypes")

    def get_event_types(self) -> list:
        return self._request("GET", "/api/v1/Crm/eventtypes")

    def get_teams(self) -> list:
        return self._request("GET", "/api/v1/Crm/teams")

    def get_users(self) -> list:
        return self._request("GET", "/api/v1/Crm/users")

    # ── Helpers ──────────────────────────────────────────────────────
    def iter_all_properties(self, page_size: int = 100):
        """Iterate all properties, yielding each one."""
        skip = 0
        while True:
            data = self.get_all_properties(top=page_size, skip=skip)
            records = data.get("value", [])
            if not records:
                break
            for r in records:
                yield r
            skip += page_size
