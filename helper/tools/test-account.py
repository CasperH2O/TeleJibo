#!/usr/bin/env python3
"""Run the real account controller with synthetic updates, without firmware."""
import hashlib
import json
from pathlib import Path
import subprocess
import os

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
pins = json.loads((ROOT / 'pins.json').read_text())
compiler = ROOT / pins['tools']['zig']['path']
with compiler.open('rb') as stream:
    if hashlib.file_digest(stream, 'sha256').hexdigest() != pins['tools']['zig']['sha256']:
        raise SystemExit('Zig executable pin mismatch')
source = DATA / 'media-src/tgcalls'
pin = next(p for p in json.loads((ROOT / 'media-pins.json').read_text())['sources'] if p['name'] == 'tgcalls')
archive = DATA / 'downloads' / pin['archive']
with archive.open('rb') as stream:
    if hashlib.file_digest(stream, 'sha256').hexdigest() != pin['sha256']:
        raise SystemExit('tgcalls source archive pin mismatch')
# Use the exact json11 files from the verified archive, not unreviewed local edits.
import tarfile
with tarfile.open(archive) as packed:
    for name in ['json11.cpp', 'json11.hpp']:
        path = source / 'tgcalls/third-party' / name
        member = next(m for m in packed.getmembers() if m.name.endswith('/tgcalls/third-party/' + name))
        if packed.extractfile(member).read() != path.read_bytes():
            raise SystemExit('json11 build input differs from archive')
output = DATA / 'host-tests'
output.mkdir(parents=True, exist_ok=True)
subprocess.run([str(compiler), 'c++', '-std=c++20', '-O2', str(ROOT / 'tests/account-test.cpp'),
                str(source / 'tgcalls/third-party/json11.cpp'), '-I' + str(source / 'tgcalls'), '-I' + str(ROOT / 'media'),
                '-o', str(output / 'account-test')], check=True, timeout=180,
               env=os.environ | {'ZIG_GLOBAL_CACHE_DIR': str(DATA / 'zig-cache')})
subprocess.run([str(output / 'account-test')], check=True, timeout=30)
