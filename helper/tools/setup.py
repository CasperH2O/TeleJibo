#!/usr/bin/env python3
"""Download verified build tools locally."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data/prerequisites'


def fetch(url, checksum, name):
    downloads = DATA / 'downloads'
    downloads.mkdir(parents=True, exist_ok=True)
    archive = downloads / name
    if not archive.exists():
        temporary = archive.with_name(archive.name + '.part')
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        temporary.rename(archive)
    with archive.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != checksum:
            raise SystemExit('Checksum mismatch: ' + name)
    print('Verified ' + name, flush=True)
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    zig = json.loads((ROOT / 'tools/zig-lock.json').read_text())
    archive = fetch(zig['url'], zig['sha256'], zig['url'].rsplit('/', 1)[-1])
    destination = DATA / 'toolchain'
    destination.mkdir(exist_ok=True)
    if not (destination / 'zig').exists():
        with tarfile.open(archive) as source:
            top = source.getmembers()[0].name.split('/')[0]
            source.extractall(destination, filter='data')
        (destination / top).rename(destination / 'zig')
    system = DATA / 'system'
    system.mkdir(exist_ok=True)
    for pin in json.loads((ROOT / 'tools/system-lock.json').read_text()):
        archive = fetch(pin['url'], pin['sha256'], pin['name'])
        if pin['kind'] == 'deb':
            subprocess.run(['dpkg-deb', '-x', str(archive), str(system / 'host')], check=True)
        else:
            expected = system / 'gcc-linaro-4.9.4-2017.01-x86_64_arm-linux-gnueabihf'
            if not expected.exists():
                with tarfile.open(archive) as source:
                    source.extractall(system, filter='data')
    pins = json.loads((ROOT / 'pins.json').read_text())['tools']
    for key in ['zig', 'make', 'strip']:
        pin = pins[key]
        with (ROOT / pin['path']).open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != pin['sha256']:
                raise SystemExit('Extracted executable differs from pin: ' + key)
    print('Build tools ready.', flush=True)


if __name__ == '__main__':
    main()
