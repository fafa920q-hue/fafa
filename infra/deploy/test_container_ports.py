import io
import json
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from check_container_ports import (
    INSPECT_FORMAT, PortCheckError, TARGETS, check_services, main, validate_container,
)


def container(container_id="a" * 64, running=True):
    return {
        "Id": container_id,
        "State": {"Running": running},
        "HostConfig": {"NetworkMode": "bridge", "PortBindings": {}},
        "NetworkSettings": {"Ports": {"4000/tcp": None, "5432/tcp": None}},
        "Config": {"ExposedPorts": {"4000/tcp": {}, "5432/tcp": {}}},
    }


def binding(address="", port="49152"):
    return [{"HostIp": address, "HostPort": port}]


class PortMetadataTests(unittest.TestCase):
    def assert_code(self, value, service, code):
        with self.assertRaises(PortCheckError) as raised:
            validate_container(value, service)
        self.assertEqual(raised.exception.code, code)

    def test_expose_only_null_and_empty_maps_are_allowed(self):
        for service in TARGETS:
            for host in (None, {}):
                for network in (None, {}, {str(TARGETS[service]) + "/tcp": None},
                                {str(TARGETS[service]) + "/tcp": []}):
                    with self.subTest(service=service, host=host, network=network):
                        value = container()
                        value["HostConfig"]["PortBindings"] = host
                        value["NetworkSettings"]["Ports"] = network
                        validate_container(value, service)

    def test_all_actual_bindings_are_rejected_from_either_map(self):
        for service, port in TARGETS.items():
            for location in ("HostConfig", "NetworkSettings"):
                for address in ("", "0.0.0.0", "127.0.0.1", "::", "::1"):
                    for protocol in ("tcp", "udp"):
                        with self.subTest(service=service, location=location,
                                          address=address, protocol=protocol):
                            value = container()
                            key = "PortBindings" if location == "HostConfig" else "Ports"
                            value[location][key] = {
                                str(port) + "/" + protocol: binding(address)
                            }
                            self.assert_code(value, service, "PUBLISHED_INTERNAL_PORT")

    def test_stopped_private_service_is_not_misreported_as_published(self):
        for service in TARGETS:
            self.assert_code(container(running=False), service, "SERVICE_NOT_RUNNING")

    def test_stopped_configured_binding_is_still_rejected(self):
        value = container(running=False)
        value["NetworkSettings"]["Ports"] = None
        value["HostConfig"]["PortBindings"] = {"4000/tcp": binding("127.0.0.1")}
        self.assert_code(value, "api", "PUBLISHED_INTERNAL_PORT")

    def test_ephemeral_host_port_is_detected_from_runtime_allocation(self):
        for requested in ("", "0"):
            value = container()
            value["HostConfig"]["PortBindings"] = {"4000/tcp": binding("", requested)}
            value["NetworkSettings"]["Ports"] = {"4000/tcp": binding("::", "32781")}
            self.assert_code(value, "api", "PUBLISHED_INTERNAL_PORT")

    def test_unresolved_publish_request_is_not_called_a_real_binding(self):
        for requested in ("", "0"):
            value = container()
            value["HostConfig"]["PortBindings"] = {"4000/tcp": binding("", requested)}
            self.assert_code(value, "api", "UNRESOLVED_PORT_BINDING")

    def test_host_network_and_malformed_metadata_fail_closed(self):
        value = container()
        value["HostConfig"]["NetworkMode"] = "host"
        self.assert_code(value, "api", "HOST_NETWORK_NOT_ALLOWED")
        for port in (":0", "garbage", "65536", -1, None):
            value = container()
            value["NetworkSettings"]["Ports"] = {"4000/tcp": binding("", port)}
            self.assert_code(value, "api", "INVALID_INSPECTION")
        self.assert_code({}, "postgres", "INVALID_INSPECTION")


class DockerCommandTests(unittest.TestCase):
    def setUp(self):
        self.compose = ["docker", "compose", "--env-file", "fixture.env", "-f", "fixture.yaml"]
        self.ids = {"api": ["a" * 64], "postgres": ["b" * 64]}
        self.containers = {
            "a" * 64: container("a" * 64),
            "b" * 64: container("b" * 64),
        }
        self.calls = []

    def docker_run(self, args, **kwargs):
        self.calls.append(args)
        if args[:len(self.compose)] == self.compose:
            if args[-4:-1] == ["ps", "--all", "--quiet"]:
                return subprocess.CompletedProcess(args, 0, "\n".join(self.ids[args[-1]]) + "\n")
            # Historical Docker/Compose responses are present but must never be used.
            if "port" in args:
                service = "api" if "api" in args else "postgres"
                return subprocess.CompletedProcess(
                    args, 0, "service api is not running\n" if service == "api" else ":0\n"
                )
        if args[:3] == ["docker", "container", "inspect"]:
            values = []
            for prefix in args[5:]:
                values.append(next(value for key, value in self.containers.items()
                                   if key.startswith(prefix)))
            return subprocess.CompletedProcess(args, 0, "\n".join(json.dumps(v) for v in values))
        raise AssertionError("Unexpected Docker command")

    def test_compose_zero_and_not_running_text_are_never_consulted(self):
        self.assertEqual(check_services(self.compose, self.docker_run), [])
        self.assertFalse(any("port" in args for args in self.calls))
        self.assertEqual(len(self.calls), 4)
        self.assertTrue(all(args[-4:-1] == ["ps", "--all", "--quiet"]
                            for args in self.calls if args[:2] == ["docker", "compose"]))
        self.assertNotIn(".Config.Env", INSPECT_FORMAT)
        self.assertIn(".HostConfig.PortBindings", INSPECT_FORMAT)
        self.assertIn(".NetworkSettings.Ports", INSPECT_FORMAT)

    def test_stopped_service_is_included_and_both_services_are_checked(self):
        self.containers["a" * 64]["State"]["Running"] = False
        errors = check_services(self.compose, self.docker_run)
        self.assertEqual([(error.service, error.code) for error in errors],
                         [("api", "SERVICE_NOT_RUNNING")])
        self.assertTrue(any(args[-1] == "postgres" for args in self.calls))

    def test_second_replica_with_binding_cannot_be_hidden(self):
        self.ids["api"].append("c" * 64)
        self.containers["c" * 64] = container("c" * 64)
        self.containers["c" * 64]["NetworkSettings"]["Ports"] = {
            "4000/tcp": binding("127.0.0.1", "14000")
        }
        self.assertEqual([e.code for e in check_services(self.compose, self.docker_run)],
                         ["PUBLISHED_INTERNAL_PORT"])

    def test_missing_container_and_short_ids(self):
        self.ids["api"] = []
        self.assertEqual([e.code for e in check_services(self.compose, self.docker_run)],
                         ["CONTAINER_MISSING"])
        self.ids["api"] = ["a" * 12]
        self.assertEqual(check_services(self.compose, self.docker_run), [])

    def test_failed_inspect_and_invalid_json_do_not_pass_or_leak_output(self):
        for failure in (
            subprocess.CalledProcessError(1, ["docker"], stderr="sensitive-fixture"),
            subprocess.TimeoutExpired(["docker"], 30),
            OSError("sensitive-fixture"),
        ):
            def fail(args, **kwargs):
                if args[:3] == ["docker", "container", "inspect"]:
                    raise failure
                return self.docker_run(args, **kwargs)
            errors = check_services(self.compose, fail)
            self.assertEqual([e.code for e in errors],
                             ["INSPECTION_FAILED", "INSPECTION_FAILED"])
            self.assertNotIn("sensitive-fixture", str(errors))
        def corrupt(args, **kwargs):
            if args[:3] == ["docker", "container", "inspect"]:
                return subprocess.CompletedProcess(args, 0, "invalid-json")
            return self.docker_run(args, **kwargs)
        self.assertTrue(check_services(self.compose, corrupt))

    def test_cli_distinguishes_stopped_from_published_without_raw_metadata(self):
        errors = [PortCheckError("SERVICE_NOT_RUNNING", "api")]
        output, diagnostic = io.StringIO(), io.StringIO()
        with patch("check_container_ports.check_services", return_value=errors):
            with redirect_stdout(output), redirect_stderr(diagnostic):
                self.assertEqual(main(), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("SERVICE_NOT_RUNNING: api", diagnostic.getvalue())
        self.assertNotIn("Forbidden published", diagnostic.getvalue())


if __name__ == "__main__":
    unittest.main()
