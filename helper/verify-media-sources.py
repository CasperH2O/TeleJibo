#!/usr/bin/env python3
"""Compare the actual media build inputs with all pinned public archives."""
import hashlib
import json
import os
from pathlib import Path
import tarfile

HERE = Path(__file__).resolve().parent
DATA = HERE / 'data'
SUBMODULES = {'abseil': 'abseil-cpp', 'crc32c': 'crc32c/src',
              'libsrtp': 'libsrtp', 'libyuv': 'libyuv'}


def main():
    report = {'sources': {}, 'changed': [], 'patches': ['ffmpeg/configure: require sysctl header and symbol']}
    for pin in json.loads((HERE / 'media-pins.json').read_text())['sources']:
        archive = DATA / 'downloads' / pin['archive']
        with archive.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != pin['sha256']:
                raise SystemExit('Archive checksum mismatch: ' + pin['name'])
        roots = [DATA / 'media-src' / pin['name']]
        if pin['name'] in SUBMODULES:
            roots.append(DATA / 'media-src/tg_owt/src/third_party' / SUBMODULES[pin['name']])
        count = 0
        with tarfile.open(archive) as source:
            for member in source:
                relative = '/'.join(member.name.split('/')[1:])
                if not relative or member.isdir():
                    continue
                expected = source.extractfile(member).read() if member.isfile() else None
                if pin['name'] == 'ffmpeg' and relative == 'configure':
                    expected = expected.replace(b'check_func  sysctl\n', b'check_func_headers sys/sysctl.h sysctl\n')
                for root in roots:
                    path = root / relative
                    if member.isfile():
                        match = path.is_file() and not path.is_symlink() and path.read_bytes() == expected
                    elif member.issym():
                        match = path.is_symlink() and os.readlink(path) == member.linkname
                    else:
                        match = False
                    if not match:
                        report['changed'].append(str(path.relative_to(DATA)))
                count += 1
        report['sources'][pin['name']] = {'archive_files': count, 'build_copies': len(roots)}
    report['passed'] = not report['changed']
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
