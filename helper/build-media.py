#!/usr/bin/env python3
"""Cross-build the calling engine and helper for ARMv7 / glibc 2.17+."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent
REPO = HERE
DATA = HERE / 'data'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dependencies-only', action='store_true')
    parser.add_argument('--engine-only', action='store_true', help='Reuse previously built codec dependencies')
    args = parser.parse_args()
    pins = json.loads((HERE / 'pins.json').read_text())
    for name in ['zig', 'make', 'strip']:
        pin = pins['tools'][name]
        with (REPO / pin['path']).open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != pin['sha256']:
                raise SystemExit('Reused tool checksum mismatch: ' + name)
    source = DATA / 'media-src'
    for pin in json.loads((HERE / 'media-pins.json').read_text())['sources']:
        if (source / pin['name'] / '.spike-source-sha256').read_text().strip() != pin['sha256']:
            raise SystemExit('Run fetch-media.py first')
    work = DATA / 'media-build'
    prefix = work / 'prefix'
    wrappers = work / 'wrappers'
    wrappers.mkdir(parents=True, exist_ok=True)
    (work / 'logs').mkdir(exist_ok=True)
    (work / 'home').mkdir(exist_ok=True)
    zig = REPO / pins['tools']['zig']['path']
    layout = HERE / 'tools/old-glibc-arm.ld'
    for name, language in [('cc', 'cc'), ('cxx', 'c++'), ('ar', 'ar'), ('ranlib', 'ranlib')]:
        body = '#!/bin/bash\nset -eu\n'
        flags = ''
        if language in ['cc', 'c++']:
            # FFmpeg uses GCC's spelling; Zig CPU names use underscores.
            body += 'args=()\nfor arg in "$@"; do args+=("${arg/#-mcpu=cortex-a15/-mcpu=cortex_a15}"); done\nset -- "${args[@]}"\n'
            body += 'link=true\nfor arg in "$@"; do case "$arg" in -c|-E|-S|--version|-dumpmachine) link=false;; esac; done\nextra=()\n'
            body += 'if "$link"; then extra+=(' + shlex.quote('-Wl,-T,' + str(layout)) + '); fi\n'
            flags = ' -target arm-linux-gnueabihf.2.17 -mcpu=cortex_a15 "${extra[@]}"'
        body += 'exec ' + shlex.quote(str(zig)) + ' ' + language + flags + ' "$@"\n'
        (wrappers / name).write_text(body)
        (wrappers / name).chmod(0o755)
    (wrappers / 'hostcc').write_text('#!/bin/bash\nexec ' + shlex.quote(str(zig)) + ' cc "$@"\n')
    (wrappers / 'hostcc').chmod(0o755)
    cmake = next((DATA / 'tools').glob('cmake-*/bin/cmake'))
    make = REPO / pins['tools']['make']['path']
    binutils = (REPO / pins['tools']['strip']['path']).parent
    env = {'PATH': ':'.join(map(str, [DATA / 'tools', cmake.parent, make.parent, binutils, Path('/usr/bin'), Path('/bin')])),
           'HOME': str(work / 'home'), 'LANG': 'C', 'LC_ALL': 'C',
           'ZIG_GLOBAL_CACHE_DIR': str(DATA / 'zig-cache'),
           'CC': str(wrappers / 'cc'), 'CXX': str(wrappers / 'cxx'),
           'AR': str(wrappers / 'ar'), 'RANLIB': str(wrappers / 'ranlib')}
    steps = []

    def run(name, command, cwd=work, extra=None):
        if args.engine_only and not name.startswith('engine-'):
            return
        print(name, flush=True)
        start = time.monotonic()
        with (work / 'logs' / (name + '.log')).open('w') as log:
            result = subprocess.run(['timeout', '--kill-after=10s', '30m', *map(str, command)],
                                    cwd=cwd, env=env | (extra or {}), stdout=log, stderr=subprocess.STDOUT)
        steps.append({'step': name, 'exit': result.returncode, 'seconds': round(time.monotonic() - start, 2)})
        (work / 'result.json').write_text(json.dumps(steps, indent=2) + '\n')
        if result.returncode:
            print((work / 'logs' / (name + '.log')).read_text()[-7000:])
            raise SystemExit(result.returncode)

    toolchain = work / 'arm.cmake'
    toolchain.write_text('\n'.join([
        'set(CMAKE_SYSTEM_NAME Linux)', 'set(CMAKE_SYSTEM_PROCESSOR armv7)',
        f'set(CMAKE_C_COMPILER "{wrappers / "cc"}")',
        f'set(CMAKE_CXX_COMPILER "{wrappers / "cxx"}")',
        f'set(CMAKE_AR "{wrappers / "ar"}")', f'set(CMAKE_RANLIB "{wrappers / "ranlib"}")',
        f'set(CMAKE_FIND_ROOT_PATH "{prefix}")',
        'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)', 'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)', '']))
    common = [cmake, '-G', 'Ninja', '-DCMAKE_TOOLCHAIN_FILE=' + str(toolchain),
              '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_C_FLAGS_RELEASE=-O2 -DNDEBUG',
              '-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG', '-DCMAKE_INSTALL_PREFIX=' + str(prefix),
              '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5']
    for name, flags in [('opus', ['-DOPUS_BUILD_TESTING=OFF', '-DOPUS_BUILD_PROGRAMS=OFF']),
                        ('jpeg', ['-DENABLE_SHARED=OFF', '-DWITH_SIMD=OFF', '-DWITH_TURBOJPEG=OFF'])]:
        run(name + '-configure', [*common, '-S', source / name, '-B', work / name, *flags])
        run(name + '-build', [cmake, '--build', work / name, '-j', '8'])
        run(name + '-install', [cmake, '--install', work / name])
    vpx = work / 'vpx'
    vpx.mkdir(exist_ok=True)
    run('vpx-configure', [source / 'vpx/configure', '--target=armv7-linux-gcc', '--prefix=' + str(prefix),
        '--enable-pic', '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests',
        '--disable-shared', '--enable-static', '--disable-runtime-cpu-detect', '--disable-neon-asm'], vpx,
        {'AS': str(wrappers / 'cc'), 'LD': str(wrappers / 'cc')})
    run('vpx-build', [make, '-j8'], vpx)
    run('vpx-install', [make, 'install'], vpx)
    # OpenH264's makefiles build in-tree. Work only in an ignored copy.
    h264 = work / 'openh264'
    if not h264.exists():
        shutil.copytree(source / 'openh264', h264)
    run('openh264-build', [make, '-j8', 'libopenh264.a', 'OS=linux', 'ARCH=arm',
        'USE_ASM=No', 'BUILDTYPE=Release', 'CXX=' + str(wrappers / 'cxx'),
        'CC=' + str(wrappers / 'cc'), 'AR=' + str(wrappers / 'ar')], h264)
    (prefix / 'include/wels').mkdir(parents=True, exist_ok=True)
    for header in (source / 'openh264/codec/api/wels').glob('*.h'):
        shutil.copy2(header, prefix / 'include/wels' / header.name)
    shutil.copy2(h264 / 'libopenh264.a', prefix / 'lib/libopenh264.a')
    ffmpeg = work / 'ffmpeg'
    ffmpeg.mkdir(exist_ok=True)
    # glibc 2.17 exports sysctl, but Zig's modern headers omit sys/sysctl.h.
    # Check the declaration as well as the linker symbol (see recorded patch).
    configure = source / 'ffmpeg/configure'
    text = configure.read_text()
    before = 'check_func  sysctl\n'
    after = 'check_func_headers sys/sysctl.h sysctl\n'
    if before in text:
        configure.write_text(text.replace(before, after))
    elif after not in text:
        raise SystemExit('FFmpeg sysctl patch context changed')
    run('ffmpeg-configure', [source / 'ffmpeg/configure', '--prefix=' + str(prefix),
        '--enable-cross-compile', '--target-os=linux', '--arch=arm', '--cpu=cortex-a15',
        '--cc=' + str(wrappers / 'cc'), '--cxx=' + str(wrappers / 'cxx'),
        '--host-cc=' + str(wrappers / 'hostcc'),
        '--ar=' + str(wrappers / 'ar'), '--ranlib=' + str(wrappers / 'ranlib'),
        '--nm=' + str(binutils / 'arm-linux-gnueabihf-nm'),
        '--disable-everything', '--disable-programs', '--disable-doc', '--disable-debug',
        '--disable-network', '--disable-autodetect', '--disable-shared', '--enable-static',
        '--enable-pic', '--enable-decoder=h264,hevc', '--enable-parser=h264,hevc'], ffmpeg)
    run('ffmpeg-build', [make, '-j8'], ffmpeg)
    run('ffmpeg-install', [make, 'install'], ffmpeg)
    # Populate only empty/marked archive submodule directories. Copies preserve
    # tg_owt's include paths using libsrtp/../libsrtp_config; symlinks don't.
    for relative, name in [('abseil-cpp', 'abseil'), ('crc32c/src', 'crc32c'),
                            ('libsrtp', 'libsrtp'), ('libyuv', 'libyuv')]:
        destination = source / 'tg_owt/src/third_party' / relative
        if destination.is_symlink():
            if destination.resolve() != source / name:
                raise SystemExit('Unexpected submodule symlink: ' + str(destination))
            destination.unlink()
        if (destination / '.spike-source-sha256').exists():
            if (destination / '.spike-source-sha256').read_text() != (source / name / '.spike-source-sha256').read_text():
                raise SystemExit('Submodule pin changed: ' + name)
        else:
            if destination.exists():
                destination.rmdir()
            shutil.copytree(source / name, destination)
    if args.dependencies_only:
        return
    run('engine-configure', [*common, '-S', HERE / 'media', '-B', work / 'engine',
        '-DMEDIA_SOURCE=' + str(source), '-DMEDIA_PREFIX=' + str(prefix),
        '-DTDLIB_LIBRARY=' + str(next((DATA / 'runtime').glob('libtdjson.so.*'))),
        '-DTDLIB_PREFIX=' + str(DATA / 'prefix')])
    run('engine-build', [cmake, '--build', work / 'engine', '-j', '8'])


if __name__ == '__main__':
    main()
