"""Protected, fixed-target SSM deployment. Never prints tokens, commands or raw SSM output."""
import json
import ipaddress
import os
import re
import subprocess
import sys
import time
import urllib.request

TARGET_IP = "3.19.237.155"
REPOSITORY = "fafa920q-hue/fafa"

def require_protection(environment):
    rules = environment.get("protection_rules", [])
    reviewers = [rule for rule in rules if rule.get("type") == "required_reviewers" and rule.get("reviewers")]
    if not reviewers or environment.get("can_admins_bypass", True):
        raise RuntimeError("production must require human reviewers and prohibit admin bypass")

def github(path):
    request = urllib.request.Request("https://api.github.com/repos/" + REPOSITORY + path,
        headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def aws(*args):
    result = subprocess.run(["aws", *args, "--output", "json", "--no-cli-pager"],
        capture_output=True, text=True, check=True, timeout=60)
    return json.loads(result.stdout)

def port_open(permission, port, ipv4_only=False):
    protocol = permission.get("IpProtocol")
    matches = protocol == "-1" or (protocol in ("tcp", "6") and permission.get("FromPort", 65536) <= port <= permission.get("ToPort", -1))
    public = any(item.get("CidrIp") == "0.0.0.0/0" for item in permission.get("IpRanges", []))
    if not ipv4_only:
        public = public or any(item.get("CidrIpv6") == "::/0" for item in permission.get("Ipv6Ranges", []))
    return matches and public

def forbidden_public_port(permission, port):
    protocol = permission.get("IpProtocol")
    matches = protocol == "-1" or (protocol in ("tcp", "6") and permission.get("FromPort", 65536) <= port <= permission.get("ToPort", -1))
    networks = [item["CidrIp"] for item in permission.get("IpRanges", [])] + [item["CidrIpv6"] for item in permission.get("Ipv6Ranges", [])]
    public = any(cidr in ("0.0.0.0/0", "::/0") or ipaddress.ip_network(cidr).is_global for cidr in networks)
    return matches and (public or bool(permission.get("PrefixListIds")))

def require_network(groups):
    permissions = [rule for group in groups for rule in group.get("IpPermissions", [])]
    if not all(any(port_open(rule, port, ipv4_only=True) for rule in permissions) for port in (80, 443)):
        raise RuntimeError("public TCP 80/443 not verified; no rules were changed")
    if any(forbidden_public_port(rule, port) for rule in permissions for port in (4000, 5432)):
        raise RuntimeError("public 4000/5432 rule detected; authorization is needed to correct it")

def preflight():
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or os.environ.get("GITHUB_REF") != "refs/heads/feat/fafa-one-control-panel":
        raise RuntimeError("unexpected repository or deployment branch")
    require_protection(github("/environments/production"))
    sha = os.environ["GITHUB_SHA"]
    if not re.fullmatch("[0-9a-f]{40}", sha):
        raise RuntimeError("invalid deployment SHA")
    for _ in range(150):
        runs = github("/actions/runs?event=pull_request&head_sha=" + sha + "&per_page=20")["workflow_runs"]
        checks = [run for run in runs if run["name"] == "FAFA ONE checks" and run["head_sha"] == sha]
        if checks:
            latest = max(checks, key=lambda run: run["id"])
            if latest["status"] == "completed":
                if latest["conclusion"] != "success":
                    raise RuntimeError("this exact SHA has not passed all CI")
                print("Required human approval and exact-SHA CI verified.")
                return
        time.sleep(15)
    raise RuntimeError("timed out waiting for exact-SHA CI")

def deploy():
    # Recheck after approval so removing protection while queued cannot open the gate.
    require_protection(github("/environments/production"))
    instance = os.environ["AWS_INSTANCE_ID"]
    sha = os.environ["GITHUB_SHA"]
    if not re.fullmatch("i-[0-9a-f]{8,17}", instance) or not re.fullmatch("[0-9a-f]{40}", sha):
        raise RuntimeError("invalid target")
    response = aws("ec2", "describe-instances", "--instance-ids", instance)
    machine = response["Reservations"][0]["Instances"][0]
    if machine.get("PublicIpAddress") != TARGET_IP or machine["State"]["Name"] != "running":
        raise RuntimeError("instance is not the approved running server")
    group_ids = [group["GroupId"] for group in machine["SecurityGroups"]]
    groups = aws("ec2", "describe-security-groups", "--group-ids", *group_ids)["SecurityGroups"]
    require_network(groups)
    managed = aws("ssm", "describe-instance-information", "--filters",
        json.dumps([{"Key": "InstanceIds", "Values": [instance]}]))["InstanceInformationList"]
    if len(managed) != 1 or managed[0]["PingStatus"] != "Online":
        raise RuntimeError("approved server is not online in SSM")
    command = aws("ssm", "send-command", "--document-name", "FAFAOne-Deploy",
        "--document-version", "1", "--instance-ids", instance, "--parameters",
        json.dumps({"CommitSHA": [sha], "Action": ["deploy"]}),
        "--timeout-seconds", "3600")["Command"]["CommandId"]
    print("SSM command submitted to the approved instance.")
    for _ in range(240):
        time.sleep(10)
        try:
            invocation = aws("ssm", "get-command-invocation", "--command-id", command, "--instance-id", instance)
        except subprocess.CalledProcessError:
            continue
        if invocation["Status"] == "Success":
            lines = invocation.get("StandardOutputContent", "").splitlines()
            matches = [line for line in lines if line.startswith("FAFA_DEPLOY_RESULT=")]
            if not matches:
                raise RuntimeError("deployment completed without a verifiable result")
            result = json.loads(matches[-1].split("=", 1)[1])
            if result.get("deployed") is not True or result.get("databaseBackupVerified") is not True:
                raise RuntimeError("deployment evidence did not pass")
            print(json.dumps({"sha": sha, "ssmStatus": "Success", "databaseBackupVerified": True,
                "productionGoogleAndOwner": "REQUIRES_BROWSER_VERIFICATION", "nodeImport": "NOT_PERFORMED"}))
            return
        if invocation["Status"] in ("Failed", "Cancelled", "TimedOut", "Cancelling"):
            raise RuntimeError("SSM deployment failed; inspect the protected AWS command record, no raw output copied here")
    raise RuntimeError("SSM deployment did not finish in the allowed time")

if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["preflight"]:
            preflight()
        elif sys.argv[1:] == ["deploy"]:
            deploy()
        else:
            raise RuntimeError("expected preflight or deploy")
    except Exception as error:
        # Only our static RuntimeError messages are safe; external API errors may contain sensitive details.
        print(str(error) if isinstance(error, RuntimeError) else "Deployment access/API validation failed; no credentials printed.", file=sys.stderr)
        sys.exit(1)
