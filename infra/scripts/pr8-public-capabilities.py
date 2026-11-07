"""Read-only release capability/public member observations, never credentials."""
import json
import os
import pathlib
import urllib.request
import urllib.error
out = {
    "scope": "Read-only GitHub settings and public endpoints; no AWS execution",
    "observerSourceSha": "d627f721062c9ea09277e6f8b6825668de6ea8e1",
    "productionSha": "NOT_READ",
    "deployEnabled": os.getenv("DEPLOY_ENABLED") == "true",
    "awsRoleConfigured": os.getenv("ROLE_PRESENT") == "true",
    "awsInstanceConfigured": os.getenv("INSTANCE_PRESENT") == "true",
    "awsRegionMatches": os.getenv("REGION_MATCHES") == "true",
    "awsExecution": "NOT_AVAILABLE_IN_THIS_JOB",
}
req = urllib.request.Request("https://api.github.com/repos/fafa920q-hue/fafa/environments/production",
    headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Accept": "application/vnd.github+json"})
try:
    with urllib.request.urlopen(req, timeout=15) as response:
        env = json.load(response)
    rules = env.get("protection_rules", [])
    out["environment"] = {"readStatus": 200,
        "requiredReviewerCount": sum(len(r.get("reviewers", [])) for r in rules if r.get("type") == "required_reviewers"),
        "adminBypassDisabled": env.get("can_admins_bypass") is False}
except urllib.error.HTTPError as error:
    out["environment"] = {"readStatus": error.code, "permissionsNotElevated": True}
except Exception as error:
    out["environment"] = {"errorType": type(error).__name__}
try:
    with urllib.request.urlopen("https://fafa888.uk/auth/member/config", timeout=15) as response:
        data = json.load(response)
        out["memberPublicConfig"] = {"httpStatus": response.status,
            "registrationOpen": data.get("registrationOpen"),
            "mailConfigured": data.get("mailConfigured")}
except urllib.error.HTTPError as error:
    out["memberPublicConfig"] = {"httpStatus": error.code}
except Exception as error:
    out["memberPublicConfig"] = {"errorType": type(error).__name__}
root = pathlib.Path("docs/evidence/production")
root.mkdir(parents=True, exist_ok=True)
(root/"release-capabilities.json").write_text(json.dumps(out, indent=2)+"\n")
print(json.dumps(out))
