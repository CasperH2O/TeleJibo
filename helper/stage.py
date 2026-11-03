#!/usr/bin/env python3
"""Stage the built Telegram helper for TeleJibo's packager.

Run after relink-tdlib.py. Writes data/payload/:

    bin/telegram-helper, bin/libtdjson.so.<version>   stripped binaries
    licenses/                                         dependency license texts
    source/                                           snapshot of this directory (corresponding source)
    BUILD-SOURCES.json, ACCOUNT-SOURCES.json          pinned dependency provenance
    LICENSE.md, THIRD_PARTY.md                        notices
    stage.json                                        SHA-256 of each binary and of the source snapshot

tools/package.py refuses a payload whose stage.json does not match its own contents or
the current source tree, so binaries always correspond to the source that ships with them.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
DATA = HERE / 'data'
LICENSE_NAMES = ('LICENSE', 'LICENCE', 'COPYING', 'PATENTS', 'COPYRIGHT', 'NOTICE')


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def source_files(root=HERE):
    """Every file of the helper source tree (never build output), rejecting links."""
    selected = []
    for path in sorted(root.rglob('*'), key=lambda p: p.relative_to(root).as_posix()):
        relative = path.relative_to(root)
        if relative.parts[0] == 'data' or '__pycache__' in relative.parts or path.suffix == '.pyc':
            continue
        if path.is_symlink():
            raise ValueError('Linked source input: ' + relative.as_posix())
        if path.is_file():
            selected.append((relative, path))
    return selected


def source_digest(files):
    """One hash over names and contents of the source snapshot."""
    return hashlib.sha256(canonical([[relative.as_posix(), digest(path)] for relative, path in files])).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.parse_args()
    os.umask(0o022)
    result = json.loads((DATA / 'release-runtime/result.json').read_text())
    runtime = DATA / 'release-runtime/libtdjson.so.1.8.69'
    if not all(result['checks'].values()) or digest(runtime) != result['sha256']:
        raise SystemExit('Build the release runtime with relink-tdlib.py first')
    pins = json.loads((HERE / 'pins.json').read_text())
    strip = HERE / pins['tools']['strip']['path']
    if digest(strip) != pins['tools']['strip']['sha256']:
        raise SystemExit('Strip tool checksum mismatch')
    stage = DATA / 'payload'
    if stage.exists():
        shutil.rmtree(stage)  # Replace only the staging directory.
    (stage / 'bin').mkdir(parents=True)
    subprocess.run([str(strip), '--strip-unneeded', '-o', str(stage / 'bin/telegram-helper'),
                    str(DATA / 'media-build/engine/telegram-helper')], check=True, timeout=60)
    shutil.copy2(runtime, stage / 'bin' / runtime.name)
    for name in ['tgcalls', 'tg_owt', 'abseil', 'crc32c', 'libsrtp', 'opus', 'vpx', 'openh264', 'jpeg', 'ffmpeg', 'libyuv']:
        source = DATA / 'media-src' / name
        for path in source.rglob('*'):
            if path.is_file() and (path.name.upper().startswith(LICENSE_NAMES) or path.name == 'README.ijg'):
                destination = stage / 'licenses' / name / path.relative_to(source)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, destination)
    for path in (DATA / 'td').glob('LICENSE*'):
        if path.is_file():
            shutil.copy2(path, stage / 'licenses' / ('tdlib-' + path.name))
    for path in (DATA / 'deps').glob('openssl-*/LICENSE*'):
        if path.is_file():
            shutil.copy2(path, stage / 'licenses' / ('openssl-' + path.name))
    for path in (DATA / 'deps').glob('zlib-*/LICENSE'):
        shutil.copy2(path, stage / 'licenses' / 'zlib-LICENSE')
    (stage / 'BUILD-SOURCES.json').write_bytes(canonical(json.loads((HERE / 'media-pins.json').read_text())) + b'\n')
    (stage / 'ACCOUNT-SOURCES.json').write_bytes(canonical(pins) + b'\n')
    files = source_files()
    for relative, path in files:
        destination = stage / 'source' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    shutil.copy2(HERE.parent / 'LICENSE.md', stage / 'LICENSE.md')
    shutil.copy2(HERE / 'THIRD_PARTY.md', stage / 'THIRD_PARTY.md')
    manifest = {'binaries': {path.name: digest(path) for path in sorted((stage / 'bin').iterdir())},
                'source_sha256': source_digest(files)}
    (stage / 'stage.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'payload': str(stage), **manifest}, indent=2))


if __name__ == '__main__':
    main()
