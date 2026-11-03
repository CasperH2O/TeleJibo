#!/usr/bin/env python3
"""Build TeleJibo's BEacon skill ZIP (dist/TeleJibo.zip), ready for Upload Skill ZIP or a release.

    python3 tools/package.py --api-file <private api.json> [--helper-payload <dir>]

--helper-payload is the staged payload of the Telegram helper (default helper/data/payload,
written by helper/stage.py after the build in helper/; see helper/README.md). Its stage.json
records the SHA-256 of each binary and of the helper source tree they were built from. The
packager refuses a payload whose binaries or source snapshot differ from that record, or
whose source tree is no longer the current helper/ tree. The payload's license texts, build
provenance and source snapshot ship alongside the binaries in telejibo/helper/, as their
licences require.

--api-file is the publisher's Telegram app key ({"api_id": int, "api_hash": "hex32"}). It
stays out of Git; the ZIP carries it scrambled in telejibo/config/app-key.bin (see
telejibo/lib/credentials.js for what that does and does not protect). Without it the
package installs, but sign-in needs a per-robot api.override.json.

The ZIP is deterministic (sorted entries, fixed timestamps) and checked against BEacon's
limits: 32 MB compressed, 64 MB expanded, 1,024 entries.
"""
import argparse
import base64
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / 'helper'))
import stage  # noqa: E402  (helper/stage.py: source hashing shared with the helper build)

SKILL = 'telejibo'
MAX_ZIP, MAX_EXPANDED, MAX_ENTRIES = 32 * 1024 * 1024, 64 * 1024 * 1024, 1024
STAMP = (2026, 1, 1, 0, 0, 0)
STORE_FILES = ['manifest.json', 'icon.png', 'banner.png', 'README.md']
# Skill files that never ship.
SKIP_DIRS = {'tests', 'node_modules', 'bin', 'config'}
HELPER_EXTRAS = ['LICENSE.md', 'THIRD_PARTY.md', 'BUILD-SOURCES.json', 'ACCOUNT-SOURCES.json', 'stage.json']


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def app_key(api_file):
    """The scrambled key, produced by the skill's own encoder so both sides always agree."""
    script = ("const c=require(process.argv[1]);const v=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));"
              "process.stdout.write(c.encode(v).toString('base64'));")
    out = subprocess.run(['node', '-e', script, str(HERE / SKILL / 'lib/credentials.js'), str(api_file)],
                         check=True, capture_output=True, text=True).stdout
    return base64.b64decode(out)


def check_helper(helper, live_source=stage.HERE):
    """The staged helper must be exactly what stage.json says, built from the current source."""
    try:
        record = json.loads((helper / 'stage.json').read_text())
    except FileNotFoundError:
        sys.exit(f'{helper} is not a staged helper payload (no stage.json); build it, then run helper/stage.py')
    for name, digest in sorted(record['binaries'].items()):
        path = helper / 'bin' / name
        if not path.is_file() or sha256(path) != digest:
            sys.exit(f'helper binary {name} does not match stage.json')
    snapshot = stage.source_digest(stage.source_files(helper / 'source'))
    if snapshot != record['source_sha256']:
        sys.exit('helper source snapshot does not match stage.json')
    if stage.source_digest(stage.source_files(live_source)) != record['source_sha256']:
        sys.exit('helper source changed since the binaries were built; rebuild and run helper/stage.py again')
    return record


def collect(helper, api_file, live_source=stage.HERE):
    record = check_helper(helper, live_source)
    entries = {}
    for name in STORE_FILES:
        entries[name] = (HERE / name).read_bytes()
    for file in sorted((HERE / SKILL).rglob('*')):
        relative = file.relative_to(HERE / SKILL)
        if file.is_file() and relative.parts[0] not in SKIP_DIRS and '__pycache__' not in relative.parts:
            entries[f'{SKILL}/{relative.as_posix()}'] = file.read_bytes()
    # The app's own licence and notices beside the code they cover.
    for name in ['LICENSE.md', 'THIRD_PARTY.md']:
        entries[f'{SKILL}/{name}'] = (HERE / name).read_bytes()
    for file in sorted((HERE / 'licenses').rglob('*')):
        if file.is_file():
            entries[f'{SKILL}/licenses/{file.relative_to(HERE / "licenses").as_posix()}'] = file.read_bytes()
    # The helper build, with the source it was built from.
    for name in sorted(record['binaries']):
        entries[f'{SKILL}/bin/{name}'] = (helper / 'bin' / name).read_bytes()
    for name in HELPER_EXTRAS:
        entries[f'{SKILL}/helper/{name}'] = (helper / name).read_bytes()
    for folder in ['licenses', 'source']:
        for file in sorted((helper / folder).rglob('*')):
            if file.is_file() and '__pycache__' not in file.parts:
                entries[f'{SKILL}/helper/{folder}/{file.relative_to(helper / folder).as_posix()}'] = file.read_bytes()
    if api_file:
        entries[f'{SKILL}/config/app-key.bin'] = app_key(api_file)
    return entries


def check_versions():
    manifest = json.loads((HERE / 'manifest.json').read_text())
    package = json.loads((HERE / SKILL / 'package.json').read_text())
    if manifest['version'] != package['version']:
        sys.exit('manifest.json and telejibo/package.json versions differ')
    if package['name'] != '@be/' + SKILL or package['jibo']['type'] != 'asset-pack':
        sys.exit('telejibo/package.json must be the @be/telejibo asset-pack')
    return manifest['version']


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--helper-payload', type=Path, default=HERE / 'helper' / 'data' / 'payload',
                        help='staged helper (default: helper/data/payload)')
    parser.add_argument('--api-file', type=Path, help='private Telegram app key JSON (omit for a keyless test build)')
    parser.add_argument('--output', type=Path, default=HERE / 'dist' / 'TeleJibo.zip')
    parser.add_argument('--helper-source', type=Path, default=stage.HERE, help=argparse.SUPPRESS)
    args = parser.parse_args()
    version = check_versions()
    entries = collect(args.helper_payload.resolve(), args.api_file, args.helper_source.resolve())
    if len(entries) > MAX_ENTRIES:
        sys.exit(f'{len(entries)} entries; BEacon accepts {MAX_ENTRIES}')
    expanded = sum(len(data) for data in entries.values())
    if expanded > MAX_EXPANDED:
        sys.exit(f'{expanded} bytes expanded; BEacon accepts {MAX_EXPANDED}')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix('.tmp')
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100755 if name.startswith(f'{SKILL}/bin/') else 0o100644) << 16
            archive.writestr(info, entries[name])
    size = temporary.stat().st_size
    if size > MAX_ZIP:
        temporary.unlink()
        sys.exit(f'{size} bytes compressed; BEacon accepts {MAX_ZIP}')
    temporary.replace(args.output)
    print(json.dumps({'zip': str(args.output), 'version': version, 'entries': len(entries), 'expanded': expanded,
                      'compressed': size, 'sha256': sha256(args.output), 'app_key': bool(args.api_file)}, indent=2))


if __name__ == '__main__':
    main()
