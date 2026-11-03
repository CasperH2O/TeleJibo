#!/usr/bin/env python3
"""Fetch checksum-pinned sources and build tools into data/."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
DATA = HERE / 'data'


def main():
    pins = json.loads((HERE / 'pins.json').read_text())
    downloads = DATA / 'downloads'
    downloads.mkdir(parents=True, exist_ok=True)
    for entry in pins['sources'] + pins['dependencies']:
        path = downloads / entry['name']
        if not path.exists():
            temporary = path.with_suffix(path.suffix + '.part')
            urllib.request.urlretrieve(entry['url'], temporary)
            temporary.rename(path)
        with path.open('rb') as f:
            actual = hashlib.file_digest(f, 'sha256').hexdigest()
        if actual != entry['sha256']:
            raise SystemExit('Checksum mismatch: ' + entry['name'])
        if 'destination' in entry:
            destination = DATA / entry['destination']
            marker = destination / '.spike-source-sha256'
            if destination.exists():
                if not marker.exists() or marker.read_text().strip() != actual:
                    raise SystemExit('Refusing existing unmarked source directory: ' + str(destination))
            else:
                destination.mkdir()
                with tarfile.open(path) as archive:
                    prefix = archive.getmembers()[0].name + '/'
                    for member in archive.getmembers():
                        if member.name.startswith(prefix):
                            member.name = member.name[len(prefix):]
                            if member.name:
                                archive.extract(member, destination, filter='data')
                marker.write_text(actual + '\n')
        elif path.name.endswith('.deb'):
            subprocess.run(['dpkg-deb', '-x', str(path), str(DATA / 'tools/gperf')], check=True)
        elif path.name.endswith('.zip'):
            with zipfile.ZipFile(path) as archive:
                for member in archive.infolist():
                    target = DATA / 'tools' / member.filename
                    if target.exists():
                        if target.read_bytes() != archive.read(member):
                            raise SystemExit('Existing tool differs: ' + str(target))
                    else:
                        archive.extract(member, DATA / 'tools')
            (DATA / 'tools/ninja').chmod(0o755)
        else:
            destination = DATA / ('tools' if path.name.startswith('cmake-') else 'deps')
            destination.mkdir(exist_ok=True)
            with tarfile.open(path) as archive:
                # Keep existing dependency builds: extraction is only needed once.
                top = archive.getmembers()[0].name.split('/')[0]
                if not (destination / top).exists():
                    archive.extractall(destination, filter='data')
        print('Verified ' + entry['name'])


if __name__ == '__main__':
    main()
