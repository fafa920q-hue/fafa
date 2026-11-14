import unittest
from ssm_deploy import require_protection, require_network

class DeploymentGuards(unittest.TestCase):
    def test_unprotected_environment_is_rejected(self):
        for value in ({}, {"protection_rules": [{"type":"required_reviewers", "reviewers":[{"id":1}]}]}, {"can_admins_bypass": False}):
            with self.assertRaises(RuntimeError):
                require_protection(value)
        require_protection({"can_admins_bypass": False, "protection_rules":[{"type":"required_reviewers","reviewers":[{"id":1}]}]})

    def test_only_web_ports_may_be_public(self):
        def rule(start, end):
            return {"IpProtocol":"tcp","FromPort":start,"ToPort":end,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]}
        web = [rule(80,80),rule(443,443)]
        require_network([{"IpPermissions":web}])
        for extra in [rule(4000,4000),rule(5432,5432),rule(1,65535), {**rule(5432,5432), 'IpRanges':[{'CidrIp':'8.8.8.8/32'}]}]:
            with self.assertRaises(RuntimeError):
                require_network([{"IpPermissions":web+[extra]}])
        with self.assertRaises(RuntimeError):
            require_network([{"IpPermissions":[rule(443,443)]}])

if __name__ == "__main__":
    unittest.main()
