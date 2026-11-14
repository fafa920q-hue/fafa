import argparse
import json
import unittest
from unittest.mock import Mock, patch
from stage_resend_secret import read_secret, stage


class ResendSecretTests(unittest.TestCase):
    def args(self, store='secretsmanager'):
        return argparse.Namespace(store=store, reference='prod/fafa-one/resend')

    def test_exact_json_field_and_current_version_only(self):
        client = Mock()
        client.get_secret_value.return_value = {'SecretString': json.dumps({'RESEND_API_KEY': 'synthetic-never-real-key'})}
        self.assertEqual(read_secret(self.args(), client), 'synthetic-never-real-key')
        client.get_secret_value.assert_called_once_with(SecretId='prod/fafa-one/resend', VersionStage='AWSCURRENT')

    def test_missing_field_wrong_types_and_unsafe_values_rejected(self):
        client = Mock()
        for value in [{}, {'apiKey': 'synthetic-legacy-field'}, {'RESEND_API_KEY': None}, {'RESEND_API_KEY': 1234}, {'RESEND_API_KEY': 'injected\nheader value'}, {'RESEND_API_KEY': 'x' * 4097}]:
            with self.subTest(valueType=type(value).__name__):
                client.get_secret_value.return_value = {'SecretString': json.dumps(value)}
                with self.assertRaises((RuntimeError, ValueError, AttributeError)):
                    read_secret(self.args(), client)

    def test_ssm_requires_decryption_and_securestring(self):
        client = Mock()
        client.get_parameter.return_value = {'Parameter': {'Type': 'String', 'Value': 'synthetic-never-real-key'}}
        with self.assertRaisesRegex(RuntimeError, 'SECURESTRING_REQUIRED'):
            read_secret(self.args('ssm'), client)
        client.get_parameter.assert_called_once_with(Name='prod/fafa-one/resend', WithDecryption=True)

    def test_platform_denial_precedes_aws_access_or_file_writes(self):
        client = Mock()
        with patch('stage_resend_secret.sys.platform', 'win32'):
            with self.assertRaisesRegex(RuntimeError, 'ROOT_LINUX_REQUIRED'):
                stage(self.args(), client)
        client.get_secret_value.assert_not_called()


if __name__ == '__main__':
    unittest.main()
