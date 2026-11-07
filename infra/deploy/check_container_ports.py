"""Inspect only port/state metadata; never serialize container environment."""
import json
import re
import subprocess
import sys

TARGETS = {"api": 4000, "postgres": 5432}
INSPECT_FORMAT = (
    '{"Id":{{json .Id}},"State":{"Running":{{json .State.Running}}},'
    '"HostConfig":{"NetworkMode":{{json .HostConfig.NetworkMode}},'
    '"PortBindings":{{json .HostConfig.PortBindings}}},'
    '"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}}}'
)


class PortCheckError(Exception):
    def __init__(self, code, service):
        self.code = code
        self.service = service
        super().__init__(code + ": " + service)


def validate_container(container, service):
    """EXPOSE/null is private; any positive host port is forbidden on any IP."""
    try:
        running = container["State"]["Running"]
        mode = container["HostConfig"]["NetworkMode"]
        maps = [
            container["HostConfig"]["PortBindings"],
            container["NetworkSettings"]["Ports"],
        ]
        if not isinstance(running, bool) or not isinstance(mode, str):
            raise ValueError()
        unresolved = False
        for mapping in maps:
            if mapping is None:
                continue
            if not isinstance(mapping, dict):
                raise ValueError()
            for protocol in ("tcp", "udp", "sctp"):
                bindings = mapping.get(str(TARGETS[service]) + "/" + protocol)
                if bindings is None:
                    continue
                if not isinstance(bindings, list):
                    raise ValueError()
                for binding in bindings:
                    if not isinstance(binding, dict):
                        raise ValueError()
                    address = binding["HostIp"]
                    port = binding["HostPort"]
                    if not isinstance(address, str) or not isinstance(port, str):
                        raise ValueError()
                    if port in ("", "0"):
                        # A request for automatic allocation/routed publication is
                        # not proof of a private port when no allocation is visible.
                        unresolved = True
                    elif re.fullmatch(r"[0-9]+", port) and 1 <= int(port) <= 65535:
                        raise PortCheckError("PUBLISHED_INTERNAL_PORT", service)
                    else:
                        raise ValueError()
        if mode == "host":
            raise PortCheckError("HOST_NETWORK_NOT_ALLOWED", service)
        if not running:
            raise PortCheckError("SERVICE_NOT_RUNNING", service)
        if unresolved:
            raise PortCheckError("UNRESOLVED_PORT_BINDING", service)
    except (KeyError, TypeError, ValueError):
        raise PortCheckError("INVALID_INSPECTION", service) from None


def check_services(compose, run=None):
    """Use --all to include stopped replicas; never call compose port."""
    if compose[:2] != ["docker", "compose"]:
        raise ValueError("expected docker compose command")
    run = run or subprocess.run
    errors = []
    for service in TARGETS:
        try:
            result = run(
                compose + ["ps", "--all", "--quiet", service],
                capture_output=True, text=True, check=True, timeout=30,
            )
            ids = list(dict.fromkeys(result.stdout.split()))
            if not ids:
                raise PortCheckError("CONTAINER_MISSING", service)
            if any(not re.fullmatch(r"[0-9a-f]{12,64}", item) for item in ids):
                raise PortCheckError("INVALID_INSPECTION", service)
            result = run(
                ["docker", "container", "inspect", "--format", INSPECT_FORMAT, *ids],
                capture_output=True, text=True, check=True, timeout=30,
            )
            containers = [
                json.loads(line) for line in result.stdout.splitlines() if line.strip()
            ]
            actual_ids = [item["Id"] for item in containers]
            if (
                len(containers) != len(ids)
                or any(not isinstance(item, str) for item in actual_ids)
                or len(set(actual_ids)) != len(ids)
                or any(
                    not any(actual.startswith(expected) for actual in actual_ids)
                    for expected in ids
                )
            ):
                raise PortCheckError("INVALID_INSPECTION", service)
            for container in containers:
                try:
                    validate_container(container, service)
                except PortCheckError as error:
                    errors.append(error)
        except PortCheckError as error:
            errors.append(error)
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
            errors.append(PortCheckError("INSPECTION_FAILED", service))
    return errors


def main():
    try:
        errors = check_services(sys.argv[1:])
    except ValueError:
        print("Invalid port-check invocation.", file=sys.stderr)
        return 1
    for error in errors:
        if error.code == "PUBLISHED_INTERNAL_PORT":
            print("Forbidden published database/API port: " + error.service, file=sys.stderr)
        else:
            print(error.code + ": " + error.service, file=sys.stderr)
    if errors:
        return 1
    print("Internal API/PostgreSQL ports verified: no host bindings; services running.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
