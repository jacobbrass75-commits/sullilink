"""
RETRAN Foreclosure Listing Service Client
Site: https://www.retran.net
Auth: Form-based login (old-school ASP session cookies)

RETRAN has NODs, Trustee Sales, REOs, postponements, and property details.
No API - must scrape the web interface.
"""
import urllib.request
import urllib.parse
import ssl
import http.cookiejar
import re
from typing import Optional


class RetranClient:
    BASE_URL = "https://www.retran.net"

    def __init__(self, login: str, password: str):
        self.login_email = login
        self.password = password
        self.ctx = ssl.create_default_context()
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cj),
            urllib.request.HTTPSHandler(context=self.ctx),
        )
        self.ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        self.logged_in = False

    def _get(self, path: str) -> str:
        req = urllib.request.Request(
            f"{self.BASE_URL}{path}",
            headers={"User-Agent": self.ua, "Referer": self.BASE_URL},
        )
        resp = self.opener.open(req, timeout=15)
        return resp.read().decode(errors="replace")

    def _post(self, path: str, data: dict, referer: str = "") -> str:
        form_data = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(
            f"{self.BASE_URL}{path}",
            data=form_data,
            headers={
                "User-Agent": self.ua,
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": referer or self.BASE_URL,
            },
        )
        resp = self.opener.open(req, timeout=15)
        return resp.read().decode(errors="replace")

    def authenticate(self) -> bool:
        """Login to RETRAN. Returns True on success.
        NOTE: RETRAN limits active sessions. If login fails with
        'too many active sessions', someone needs to log out first
        or call 1(877)711-1147 to reset.
        """
        html = self._post("/login4scvb2.asp", {
            "action": "validate_login",
            "login": self.login_email,
            "password": self.password,
            "Submit": "Login",
        }, referer=f"{self.BASE_URL}/login4scvb2.asp")

        if "too many active sessions" in html.lower():
            raise RuntimeError(
                "RETRAN: Too many active sessions. "
                "Log out other sessions or call 1(877)711-1147"
            )
        if "txtSearch" in html:
            self.logged_in = True
            return True

        # Check for redirect to search
        search_html = self._get("/search.asp")
        if "txtSearch" in search_html:
            self.logged_in = True
            return True

        return False

    def search_by_apn(self, apn: str) -> str:
        """Search RETRAN by APN. Returns raw HTML results."""
        if not self.logged_in:
            self.authenticate()
        return self._post("/reports/list.asp", {
            "txtSearch": apn,
            "select": "apn",
            "sortIndex": "tor_mailing_city",
            "sortType": "desc",
            "Submit": "Search",
        }, referer=f"{self.BASE_URL}/search.asp")

    def search_by_address(self, address: str) -> str:
        """Search RETRAN by address. Returns raw HTML results."""
        if not self.logged_in:
            self.authenticate()
        return self._post("/reports/list.asp", {
            "txtSearch": address,
            "select": "address",
            "sortIndex": "tor_mailing_city",
            "sortType": "desc",
            "Submit": "Search",
        }, referer=f"{self.BASE_URL}/search.asp")

    @staticmethod
    def parse_results(html: str) -> list[dict]:
        """Parse RETRAN HTML search results into structured data.
        TODO: Implement based on actual result HTML structure.
        Need to inspect a successful search response to build the parser.
        """
        results = []
        # Strip scripts/styles
        text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.S)
        text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.S)

        # Look for table rows with property data
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.S | re.I)
        for row in rows:
            cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
            if cells:
                clean = [re.sub(r"<[^>]+>", "", c).strip() for c in cells]
                if any(clean):
                    results.append(clean)
        return results
