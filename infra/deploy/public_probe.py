"""Read-only public checks; no credentials, no raw HTTP bodies in reports."""
import datetime
import json
import pathlib
import socket
import urllib.error
import urllib.request

CHECKS = [
    ("web", "https://fafa888.uk/", 200),
    ("admin", "https://a.fafa888.uk/", 200),
    ("ready", "https://fafa888.uk/api/ready", 200),
    ("anonymousApi", "https://fafa888.uk/api/me", 401),
    ("authConfig", "https://fafa888.uk/auth/config", 200),
]
def main():
    network = {}
    for host in ('fafa888.uk', 'a.fafa888.uk', '3.19.237.155'):
        item = {}
        try:
            item['addresses'] = sorted({entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
        except OSError as error:
            item['dnsError'] = type(error).__name__
        for port in (80, 443):
            try:
                with socket.create_connection((host, port), timeout=5):
                    item[str(port)] = 'TCP_CONNECTED'
            except OSError as error:
                item[str(port)] = type(error).__name__
        network[host] = item
    results = {}
    passed = True
    for name, url, expected in CHECKS:
        try:
            try:
                response = urllib.request.urlopen(url, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                body = response.read(1100000)
                code = response.getcode()
            item = {"status": code, "expected": expected, "passed": code == expected}
            if name == "ready" and code == 200:
                item["passed"] = json.loads(body).get("status") == "ready"
            if name == "authConfig" and code == 200:
                config = json.loads(body)
                item["demoDisabled"] = config.get("demo") is False and config.get("mock") is False
                item["googleConfigured"] = config.get("google") is True
                item["passed"] = item["passed"] and item["demoDisabled"] and item["googleConfigured"]
            results[name] = item
            passed = passed and item["passed"]
        except Exception as error:
            results[name] = {"passed": False, "errorType": type(error).__name__, "reason": str(error)[:300]}
            passed = False
    directory = pathlib.Path("docs/evidence/production")
    directory.mkdir(parents=True, exist_ok=True)
    report = {"verifiedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": "Read-only public HTTPS; no AWS execution and no authenticated user actions",
        "network": network, "checks": results, "passed": passed,
        "googleLogin": "NOT_TESTED", "ownerBinding": "NOT_TESTED", "nodeImport": "NOT_PERFORMED"}
    (directory / "public-observation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
