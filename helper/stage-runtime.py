#!/usr/bin/env python3
"""Strip the TDLib runtime while retaining the original linker output."""
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
REPO = HERE
DATA = HERE / 'data'


def main():
    pin = json.loads((HERE / 'pins.json').read_text())['tools']['strip']
    strip = REPO / pin['path']
    with strip.open('rb') as f:
        if hashlib.file_digest(f, 'sha256').hexdigest() != pin['sha256']:
            raise SystemExit('Strip tool checksum mismatch')
    library = next(p for p in (DATA / 'build-arm').glob('libtdjson.so.*') if not p.is_symlink())
    runtime = DATA / 'runtime'
    runtime.mkdir(exist_ok=True)
    for binary in [library]:
        subprocess.run([str(strip), '--strip-unneeded', '-o', str(runtime / binary.name), str(binary)],
                       check=True, timeout=60)
        print(binary.name, (runtime / binary.name).stat().st_size)


if __name__ == '__main__':
    main()
