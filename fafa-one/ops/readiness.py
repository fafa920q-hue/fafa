"""Read-only public checks. No SSH guessing, port scan, DNS write or production login.

The resulting observations do not establish ownership, a production Git version,
origin certificate validity, privileged access, backups or application acceptance.
"""

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

HOSTS = ["fafa888.uk", "a.fafa888.uk"]
TARGET = "129.212.229.254"
SAFE_HEADERS = [
    "strict-transport-security",
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "server",
    "via",
]


def fetch(url, limit=100_000):
    start = time.monotonic()
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/dns-json"
            if "cloudflare-dns.com/" in url
            else "application/json, text/html",
            "User-Agent": "FAFA-ONE-read-only-preflight/2.0",
        },
    )
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("Read limit exceeded")
        return (
            response.status,
            dict(response.headers),
            raw.decode("utf8", "replace"),
            round((time.monotonic() - start) * 1000),
        )


def inspect(host):
    result = {"host": host, "expected_ipv4": TARGET, "dns": []}
    for resolver, base in [
        ("Cloudflare DoH", "https://cloudflare-dns.com/dns-query"),
        ("Google DoH", "https://dns.google/resolve"),
    ]:
        try:
            status, _, body, _ = fetch(base + "?name=" + host + "&type=A")
            data = json.loads(body)
            addresses = sorted(
                a["data"] for a in data.get("Answer", []) if a.get("type") == 1
            )
            result["dns"].append(
                {
                    "resolver": resolver,
                    "http_status": status,
                    "dns_status": data.get("Status"),
                    "addresses": addresses,
                    "matches_target": addresses == [TARGET],
                }
            )
        except (OSError, ValueError, KeyError, TypeError) as error:
            result["dns"].append(
                {"resolver": resolver, "error_type": type(error).__name__}
            )
    try:
        status, headers, body, elapsed = fetch("https://" + host)
        lower = {k.lower(): v for k, v in headers.items()}
        title = re.search(
            r"<title>(.*?)</title>", body, flags=re.IGNORECASE | re.DOTALL
        )
        result["https"] = {
            "status": status,
            "title": title.group(1).strip() if title else None,
            "headers": {k: lower[k] for k in SAFE_HEADERS if k in lower},
            "request_elapsed_ms": elapsed,
            "tls_scope": "system trust and session proxy; origin certificate not independently inspected",
        }
    except (OSError, ValueError, KeyError, TypeError) as error:
        result["https"] = {"error_type": type(error).__name__}
    result["cloudflare_proxy_flag"] = "control-plane access unavailable; A records only"
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with ThreadPoolExecutor(2) as executor:
        hosts = list(executor.map(inspect, HOSTS))
    result = {
        "observed_at_utc": datetime.now(UTC).isoformat(),
        "production_mutated": False,
        "hosts": hosts,
        "production_commit": None,
        "server_authenticated": False,
        "server_inventory": None,
        "production_backup_verified": False,
        "release_decision": "BLOCKED",
        "notes": [
            "No configured SSH identity, TCP grant or deployment credentials",
            "Archived Python source does not match the publicly observed production frontend/health routes",
            "DNS-to-IP matching does not prove server account ownership",
            "No protected routes or user data were accessed; no production restore or deploy attempted",
        ],
    }
    with open(args.output, "w") as output:
        json.dump(result, output, indent=2, ensure_ascii=False)
        output.write("\n")
    print("Read-only evidence saved; release BLOCKED")


if __name__ == "__main__":
    main()
