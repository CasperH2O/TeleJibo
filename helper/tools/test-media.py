#!/usr/bin/env python3
"""Exercise live pipe framing and cleanup on the host; no devices or network."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
data = root / 'data'
pin = json.loads((root / 'pins.json').read_text())['tools']['zig']
compiler = root / pin['path']
with compiler.open('rb') as stream:
    if hashlib.file_digest(stream, 'sha256').hexdigest() != pin['sha256']:
        raise SystemExit('Zig executable pin mismatch')
output = data / 'host-tests'
output.mkdir(parents=True, exist_ok=True)
subprocess.run([str(compiler), 'c++', '-std=c++20', '-O2', '-pthread',
                str(root / 'tests/pipe-media-test.cpp'), '-o', str(output / 'pipe-media-test')],
               check=True, timeout=180, env=os.environ | {'ZIG_GLOBAL_CACHE_DIR': str(data / 'zig-cache')})
subprocess.run([str(output / 'pipe-media-test')], check=True, timeout=10)
