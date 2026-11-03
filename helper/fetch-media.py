#!/usr/bin/env python3
"""Fetch the pinned Linux calling-engine sources; never install system packages."""
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
DATA = HERE / 'data'


def main():
    sources = DATA / 'media-src'
    sources.mkdir(parents=True, exist_ok=True)
    downloads = DATA / 'downloads'
    downloads.mkdir(exist_ok=True)
    for pin in json.loads((HERE / 'media-pins.json').read_text())['sources']:
        archive = downloads / pin['archive']
        if not archive.exists():
            temporary = archive.with_suffix('.part')
            with urllib.request.urlopen(pin['url'], timeout=120) as response, temporary.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            temporary.rename(archive)
        with archive.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != pin['sha256']:
                raise SystemExit('Archive checksum mismatch: ' + pin['name'])
        destination = sources / pin['name']
        marker = destination / '.spike-source-sha256'
        if destination.exists():
            if not marker.exists() or marker.read_text().strip() != pin['sha256']:
                raise SystemExit('Refusing unmarked or changed source pin: ' + str(destination))
        else:
            destination.mkdir()
            with tarfile.open(archive) as source:
                for member in source:
                    member.name = '/'.join(member.name.split('/')[1:])
                    if member.name:
                        source.extract(member, destination, filter='data')
            marker.write_text(pin['sha256'] + '\n')
        print('Verified ' + pin['name'], flush=True)


if __name__ == '__main__':
    main()
