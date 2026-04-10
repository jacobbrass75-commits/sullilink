"""
PropertyRadar API Client
Login: POST https://app.propertyradar.com/api/v1/sessions
Search: POST https://api.propertyradar.com/v1/properties (requires separate API token from Account Settings)

Web session login works but the /v1/properties endpoint needs a dedicated API token.
Get it from: Account Settings -> scroll to bottom -> "Get API Free Trial" -> Integration Name -> reveal key
"""
import urllib.request
import ssl
import json
from typing import Optional


class PropertyRadarClient:
    API_BASE = "https://api.propertyradar.com/v1"
    APP_BASE = "https://app.propertyradar.com/api/v1"

    def __init__(self, api_token: Optional[str] = None, email: Optional[str] = None, password: Optional[str] = None):
        self.api_token = api_token
        self.email = email
        self.password = password
        self.session_id = None
        self.ctx = ssl.create_default_context()

    def login(self) -> str:
        """Login with email/password to get a web session ID.
        NOTE: This session ID does NOT work with the /v1/properties API.
        You need a separate API token from Account Settings for that.
        """
        if not self.email or not self.password:
            raise ValueError("Email and password required for login")
        payload = json.dumps({"Login": self.email, "Password": self.password}).encode()
        req = urllib.request.Request(
            f"{self.APP_BASE}/sessions",
            data=payload,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=15, context=self.ctx)
        data = json.loads(resp.read().decode())
        self.session_id = data["results"][0]["SessionID"]
        return self.session_id

    def search_properties(self, criteria: list, fields: Optional[list] = None, limit: int = 10) -> dict:
        """Search properties using the API token (NOT session).

        Example criteria:
            [{"name": "APN", "value": ["6006-029-002"]}]
            [{"name": "ZipFive", "value": ["90003"]}, {"name": "ForeclosureStatus", "value": ["PreForeclosure"]}]

        Example fields:
            ["Address", "APN", "ForeclosureStatus", "AuctionDate", "NODDate", "NOSDate"]
        """
        if not self.api_token:
            raise ValueError(
                "API token required. Get it from PropertyRadar Account Settings -> Integration Name. "
                "The web session_id does NOT work for property searches."
            )
        body = {"Criteria": criteria, "Limit": limit}
        if fields:
            body["Fields"] = fields
        payload = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self.API_BASE}/properties",
            data=payload,
            headers={
                "Authorization": f"Bearer {self.api_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        resp = urllib.request.urlopen(req, timeout=30, context=self.ctx)
        return json.loads(resp.read().decode())

    def lookup_by_apn(self, apn: str, fields: Optional[list] = None) -> dict:
        """Lookup a single property by APN."""
        default_fields = [
            "Address", "APN", "RadarID",
            "ForeclosureStatus", "NODDate", "NOSDate",
            "AuctionDate", "TrusteeSaleDate",
            "ForeclosureRecordingDate", "LoanAmount",
            "EstimatedValue", "OwnerName",
        ]
        return self.search_properties(
            criteria=[{"name": "APN", "value": [apn]}],
            fields=fields or default_fields,
            limit=1,
        )
