"""Exercise the actual reusable-workflow shell steps using disposable local fixtures.

No npm staging command is executed. Git pushes, where tested, target a local bare
repository; npm version/install operate offline on dependency-free fixtures.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
PUBLISH = yaml.safe_load((ROOT / '.github/workflows/npm-publish.yml').read_text())
PREPARE = yaml.safe_load((ROOT / '.github/workflows/prepare-release.yml').read_text())


def step(workflow, job, name):
    return next(item for item in workflow['jobs'][job]['steps'] if item.get('name') == name)


def command(cwd, *args):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True).stdout.strip()


class Fixture:
    def __init__(self, workspace=False, version='1.2.3'):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.path = self.base / 'checkout'
        self.path.mkdir()
        self.manifest = 'packages/svg/package.json' if workspace else 'package.json'
        # These hooks must never run during release version bumps.
        hooks = {'version': 'node -e "process.exit(99)"', 'postversion': 'node -e "process.exit(99)"'}
        root = {'name': 'fixture-root', 'version': '9.9.9' if workspace else version, 'scripts': hooks}
        packages = {'': dict(root)}
        if workspace:
            root.update(private=True, workspaces=['packages/*'])
            packages[''] = dict(root)
            for name, current in [('svg', version), ('terminal', '2.0.0')]:
                data = {'name': f'fixture-{name}', 'version': current, 'scripts': hooks}
                self.write(f'packages/{name}/package.json', data)
                packages[f'packages/{name}'] = dict(data)
                packages[f'node_modules/fixture-{name}'] = {'resolved': f'packages/{name}', 'link': True}
        self.write('package.json', root)
        self.write('package-lock.json', {'name': root['name'], 'version': root['version'], 'lockfileVersion': 3, 'requires': True, 'packages': packages})
        command(self.path, 'git', 'init', '-q', '-b', 'main')
        command(self.path, 'git', 'config', 'user.name', 'Workflow tests')
        command(self.path, 'git', 'config', 'user.email', 'workflow-tests@example.invalid')
        command(self.path, 'git', 'add', '.')
        command(self.path, 'git', 'commit', '-qm', 'Fixture')
        self.origin = self.base / 'origin.git'
        command(self.path, 'git', 'init', '-q', '--bare', str(self.origin))
        command(self.path, 'git', 'remote', 'add', 'origin', str(self.origin))
        self.output = self.base / 'output'
        self.workspace = workspace

    def write(self, path, data):
        target = self.path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, indent=2) + '\n')

    def read(self, path):
        return json.loads((self.path / path).read_text())

    def run(self, item, **env):
        self.output.write_text('')
        settings = {
            **os.environ,
            'GITHUB_OUTPUT': str(self.output),
            'GITHUB_REF_NAME': 'main',
            'PACKAGE_DIRECTORY': 'packages/svg' if self.workspace else '.',
            'TAG_PREFIX': 'svg-v' if self.workspace else 'v',
            'BUMP': 'patch', 'PREID': 'beta',
            'npm_config_offline': 'true', 'npm_config_audit': 'false',
            'npm_config_fund': 'false',
            **env,
        }
        result = subprocess.run(['bash', '-euo', 'pipefail', '-c', item['run']], cwd=self.path, env=settings, text=True, capture_output=True)
        outputs = dict(line.split('=', 1) for line in self.output.read_text().splitlines() if '=' in line)
        return result, outputs

    def close(self):
        self.temp.cleanup()


class ReleaseWorkflowTests(unittest.TestCase):
    def fixture(self, *args, **kwargs):
        value = Fixture(*args, **kwargs)
        self.addCleanup(value.close)
        return value

    def success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_legacy_defaults_are_unchanged(self):
        for workflow in [PUBLISH, PREPARE]:
            inputs = workflow.get('on', workflow.get(True))['workflow_call']['inputs']
            self.assertEqual(inputs['package-directory']['default'], '.')
        self.assertEqual(PREPARE.get('on', PREPARE.get(True))['workflow_call']['inputs']['tag-prefix']['default'], 'v')
        fixture = self.fixture()
        result, out = fixture.run(step(PUBLISH, 'publish', 'Determine release'))
        self.success(result)
        self.assertEqual(out, {'directory': '.', 'package': 'fixture-root', 'version': '1.2.3', 'tag': 'latest'})

    def test_publishing_reads_selected_workspace_not_private_root(self):
        fixture = self.fixture(workspace=True)
        result, out = fixture.run(step(PUBLISH, 'publish', 'Determine release'), PACKAGE_DIRECTORY='packages/./svg/')
        self.success(result)
        self.assertEqual(out, {'directory': 'packages/svg', 'package': 'fixture-svg', 'version': '1.2.3', 'tag': 'latest'})
        install = step(PUBLISH, 'publish', 'Install dependencies')
        stage = step(PUBLISH, 'publish', 'Stage package on npm for maintainer approval')
        self.assertNotIn('working-directory', install)
        self.assertEqual(stage['working-directory'], '${{ steps.release.outputs.directory }}')
        self.assertIn('--workspaces=false', stage['run'])

    def test_publishing_keeps_branch_and_version_restrictions(self):
        for branch, version, tag in [('next', '2.0.0-beta.1', 'next'), ('releases/v1', '1.2.3', 'release-1')]:
            with self.subTest(branch=branch):
                fixture = self.fixture(workspace=True, version=version)
                result, out = fixture.run(step(PUBLISH, 'publish', 'Determine release'), GITHUB_REF_NAME=branch)
                self.success(result)
                self.assertEqual(out['tag'], tag)
        for branch, version in [('main', '2.0.0-beta.1'), ('next', '2.0.0'), ('releases/v1', '2.0.0'), ('releases/vx', '1.0.0'), ('feature/example', '1.0.0'), ('main', 'invalid')]:
            with self.subTest(branch=branch, version=version):
                fixture = self.fixture(workspace=True, version=version)
                result, _ = fixture.run(step(PUBLISH, 'publish', 'Determine release'), GITHUB_REF_NAME=branch)
                self.assertNotEqual(result.returncode, 0)

    def test_directories_cannot_escape_checkout_or_inject_commands(self):
        fixture = self.fixture(workspace=True)
        outside = fixture.base / 'outside'
        outside.mkdir()
        (outside / 'package.json').write_text('{"name":"outside","version":"1.0.0"}')
        (fixture.path / 'escape').symlink_to(outside, target_is_directory=True)
        (fixture.path / 'packages/svg/package.json').unlink()
        (fixture.path / 'packages/svg/package.json').symlink_to(outside / 'package.json')
        for directory in ['..', str(fixture.path), 'escape', 'packages/svg', 'missing', '$(touch injected)']:
            with self.subTest(directory=directory):
                result, _ = fixture.run(step(PUBLISH, 'publish', 'Determine release'), PACKAGE_DIRECTORY=directory)
                self.assertNotEqual(result.returncode, 0)
        self.assertFalse((fixture.path / 'injected').exists())

    def test_private_packages_are_rejected(self):
        fixture = self.fixture(workspace=True)
        for item in [step(PUBLISH, 'publish', 'Determine release'), step(PREPARE, 'prepare', 'Validate branch, bump and package version')]:
            result, _ = fixture.run(item, PACKAGE_DIRECTORY='.')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('selected package is private', result.stderr)
        self.assertEqual(fixture.read('package.json')['version'], '9.9.9')

    def test_root_version_bump_preserves_existing_behavior(self):
        fixture = self.fixture()
        result, out = fixture.run(step(PREPARE, 'prepare', 'Validate branch, bump and package version'))
        self.success(result)
        self.assertEqual(out['version'], '1.2.4')
        self.assertEqual(out['manifest'], 'package.json')
        self.assertEqual(fixture.read('package-lock.json')['version'], '1.2.4')

    def test_workspace_bump_only_updates_selected_manifest_and_shared_lock(self):
        fixture = self.fixture(workspace=True)
        before = (fixture.path / 'package.json').read_bytes()
        other = (fixture.path / 'packages/terminal/package.json').read_bytes()
        result, out = fixture.run(step(PREPARE, 'prepare', 'Validate branch, bump and package version'))
        self.success(result)
        self.assertEqual(out['manifest'], 'packages/svg/package.json')
        self.assertEqual(out['package'], 'fixture-svg')
        self.assertEqual(out['version'], '1.2.4')
        self.assertEqual(fixture.read('package-lock.json')['packages']['packages/svg']['version'], '1.2.4')
        self.assertEqual((fixture.path / 'package.json').read_bytes(), before)
        self.assertEqual((fixture.path / 'packages/terminal/package.json').read_bytes(), other)

    def test_prerelease_bumps_and_maintenance_guards(self):
        fixture = self.fixture(workspace=True)
        result, out = fixture.run(step(PREPARE, 'prepare', 'Validate branch, bump and package version'), GITHUB_REF_NAME='next', BUMP='preminor')
        self.success(result)
        self.assertEqual(out['version'], '1.3.0-beta.0')
        for branch, bump in [('main', 'prerelease'), ('next', 'patch'), ('releases/v1', 'major'), ('feature/example', 'patch')]:
            with self.subTest(branch=branch, bump=bump):
                fixture = self.fixture(workspace=True)
                before = (fixture.path / fixture.manifest).read_bytes()
                result, _ = fixture.run(step(PREPARE, 'prepare', 'Validate branch, bump and package version'), GITHUB_REF_NAME=branch, BUMP=bump)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((fixture.path / fixture.manifest).read_bytes(), before)

    def test_tag_jobs_ignore_other_package_release_prs(self):
        fixture = self.fixture(workspace=True)
        selection = step(PREPARE, 'tag', 'Select matching package release PR')
        for source, expected in [('release/prepare/main/svg-v1.2.4', 'true'), ('release/prepare/main/terminal-v1.2.4', 'false'), ('release/prepare/main/v1.2.4', 'false')]:
            result, out = fixture.run(selection, TARGET='main', SOURCE=source)
            self.success(result)
            self.assertEqual(out['matches'], expected)
        for name in ['Create release app token', 'Check out merged release commit', 'Verify merged version and create Git tag']:
            self.assertIn("steps.selection.outputs.matches == 'true'", step(PREPARE, 'tag', name)['if'])

    def test_invalid_tag_prefix_is_rejected_before_changes(self):
        fixture = self.fixture(workspace=True)
        for prefix in ['', '../bad', 'bad..prefix', 'bad/prefix', 'bad\noutput=true']:
            with self.subTest(prefix=prefix):
                result, _ = fixture.run(step(PREPARE, 'prepare', 'Validate branch, bump and package version'), TAG_PREFIX=prefix)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(fixture.read(fixture.manifest)['version'], '1.2.3')

    def test_root_and_workspace_tags_point_to_merged_commit_and_are_idempotent(self):
        for workspace in [False, True]:
            with self.subTest(workspace=workspace):
                fixture = self.fixture(workspace=workspace)
                result, out = fixture.run(step(PREPARE, 'prepare', 'Validate branch, bump and package version'))
                self.success(result)
                command(fixture.path, 'git', 'add', '.')
                command(fixture.path, 'git', 'commit', '-qm', 'Merged release')
                prefix = 'svg-v' if workspace else 'v'
                source = f'release/prepare/main/{prefix}{out["version"]}'
                verify = step(PREPARE, 'tag', 'Verify merged version and create Git tag')
                for _ in range(2):
                    result, _ = fixture.run(verify, TARGET='main', SOURCE=source)
                    self.success(result)
                tag = f'{prefix}{out["version"]}'
                head = command(fixture.path, 'git', 'rev-parse', 'HEAD')
                self.assertEqual(command(fixture.path, 'git', 'rev-parse', f'{tag}^{{}}'), head)
                self.assertIn(head, command(fixture.path, 'git', '--git-dir', str(fixture.origin), 'show-ref', '--tags', '-d'))

    def test_next_and_maintenance_tags_keep_branch_policy(self):
        for target, bump in [('next', 'preminor'), ('releases/v1', 'patch')]:
            with self.subTest(target=target):
                fixture = self.fixture(workspace=True)
                result, out = fixture.run(step(PREPARE, 'prepare', 'Validate branch, bump and package version'), GITHUB_REF_NAME=target, BUMP=bump)
                self.success(result)
                command(fixture.path, 'git', 'add', '.')
                command(fixture.path, 'git', 'commit', '-qm', 'Merged release')
                source = f'release/prepare/{target.replace("/", "-")}/svg-v{out["version"]}'
                result, selected = fixture.run(step(PREPARE, 'tag', 'Select matching package release PR'), TARGET=target, SOURCE=source)
                self.success(result)
                self.assertEqual(selected['matches'], 'true')
                result, _ = fixture.run(step(PREPARE, 'tag', 'Verify merged version and create Git tag'), TARGET=target, SOURCE=source)
                self.success(result)
                self.assertEqual(command(fixture.path, 'git', 'tag', '--list'), f'svg-v{out["version"]}')

    def test_wrong_source_unchanged_version_and_existing_other_commit_tag_fail(self):
        fixture = self.fixture(workspace=True)
        verify = step(PREPARE, 'tag', 'Verify merged version and create Git tag')
        result, _ = fixture.run(verify, TARGET='main', SOURCE='release/prepare/main/svg-v1.2.4')
        self.assertNotEqual(result.returncode, 0)
        # Same-version merge must not acquire a release tag.
        (fixture.path / 'note.txt').write_text('No version change')
        command(fixture.path, 'git', 'add', '.')
        command(fixture.path, 'git', 'commit', '-qm', 'Unchanged version')
        result, _ = fixture.run(verify, TARGET='main', SOURCE='release/prepare/main/svg-v1.2.3')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('did not change', result.stderr)
        # Existing tags on older commits must never be moved.
        command(fixture.path, 'git', 'tag', 'svg-v1.2.4')
        result, _ = fixture.run(step(PREPARE, 'prepare', 'Validate branch, bump and package version'))
        self.success(result)
        command(fixture.path, 'git', 'add', '.')
        command(fixture.path, 'git', 'commit', '-qm', 'Release version')
        result, _ = fixture.run(verify, TARGET='main', SOURCE='release/prepare/main/svg-v1.2.4')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('different commit', result.stderr)

    def test_release_commit_stages_selected_manifest_and_lock(self):
        commit = step(PREPARE, 'prepare', 'Commit version and open release PR')
        self.assertIn('git add -- "$MANIFEST" package-lock.json', commit['run'])
        self.assertIn('release/prepare/${TARGET//\\//-}/${TAG_PREFIX}$VERSION', commit['run'])
        self.assertEqual(commit['env']['MANIFEST'], '${{ steps.release.outputs.manifest }}')
        self.assertIn('$PACKAGE', commit['run'])

    def test_all_embedded_shell_steps_parse(self):
        for workflow in [PUBLISH, PREPARE]:
            for job in workflow['jobs'].values():
                for item in job.get('steps', []):
                    if 'run' in item:
                        result = subprocess.run(['bash', '-n'], input=item['run'], text=True, capture_output=True)
                        self.success(result)


if __name__ == '__main__':
    unittest.main()
