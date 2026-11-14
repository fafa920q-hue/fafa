import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('v3_release', Path(__file__).with_name('v3_ec2_release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePermissions(unittest.TestCase):
    def test_private_umask_directories_become_traversable_without_changing_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'release'
            source = root / 'apps/api/src'
            source.mkdir(parents=True)
            for path in [root, root / 'apps', root / 'apps/api', source]:
                path.chmod(0o700)
            entry = source / 'index.ts'
            entry.write_text('export {};\n')
            entry.chmod(0o644)
            release.normalize_release_directories(root)
            self.assertTrue(all(path.stat().st_mode & 0o777 == 0o755 for path in [root, root / 'apps', root / 'apps/api', source]))
            self.assertEqual(entry.stat().st_mode & 0o777, 0o644)

    def test_directory_symlink_does_not_change_external_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'release'
            root.mkdir()
            external = Path(temp) / 'external'
            external.mkdir(mode=0o700)
            (root / 'linked').symlink_to(external, target_is_directory=True)
            release.normalize_release_directories(root)
            self.assertEqual(external.stat().st_mode & 0o777, 0o700)

    def test_test_evidence_cannot_be_reused_after_application_change(self):
        with patch.object(release, 'checked', side_effect=[b'', b'apps/api/src/server.ts\n']):
            self.assertFalse(release.application_matches('a' * 40, 'b' * 40))

    def test_only_release_tool_fix_can_reuse_identical_application_tests(self):
        with patch.object(release, 'checked', side_effect=[b'', b'infra/deploy/v3_ec2_release.py\ninfra/deploy/test_v3_ec2_release.py\n']):
            self.assertTrue(release.application_matches('a' * 40, 'b' * 40))


if __name__ == '__main__':
    unittest.main()
