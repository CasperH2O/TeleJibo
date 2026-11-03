#!/usr/bin/env python3
"""Build TDLib and its dependencies for Cortex-A15 / old glibc.

Run fetch.py first. No system installation or firmware modification.
"""
import json
import hashlib
from pathlib import Path
import shlex
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
REPO = HERE
DATA = HERE / 'data'


def main():
    pins = json.loads((HERE / 'pins.json').read_text())
    for key in ['zig', 'make']:
        entry = pins['tools'][key]
        with (REPO / entry['path']).open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != entry['sha256']:
                raise SystemExit('Reused tool checksum mismatch: ' + key)
    tools = DATA / 'tools'
    zig = REPO / pins['tools']['zig']['path']
    cmake = next(tools.glob('cmake-*/bin/cmake'))
    make = REPO / pins['tools']['make']['path']
    wrappers = DATA / 'wrappers'
    wrappers.mkdir(exist_ok=True)
    layout = HERE / 'tools/old-glibc-arm.ld'
    for name, language, target in [('host-cc', 'cc', False), ('host-cxx', 'c++', False),
                                   ('arm-cc', 'cc', True), ('arm-cxx', 'c++', True),
                                   ('ar', 'ar', False), ('ranlib', 'ranlib', False)]:
        body = '#!/bin/bash\nset -eu\n'
        if language in ('cc', 'c++'):
            # Zig 0.15.2 rejects GNU archive-symbol hiding. The final relink applies
            # tdjson.exports to restrict the public ABI.
            body += 'args=()\nfor a in "$@"; do [[ "$a" == -Wl,--exclude-libs,ALL ]] || args+=("$a"); done\nset -- "${args[@]}"\n'
        flags = ''
        if target:
            body += 'link=true\nfor a in "$@"; do case "$a" in -c|-E|-S|--version|-dumpmachine) link=false;; esac; done\nextra=()\n'
            body += 'if "$link"; then extra+=(' + shlex.quote('-Wl,-T,' + str(layout)) + '); fi\n'
            flags = ' -target arm-linux-gnueabihf.2.17 -mcpu=cortex_a15 "${extra[@]}"'
        body += 'exec ' + shlex.quote(str(zig)) + ' ' + language + flags + ' "$@"\n'
        (wrappers / name).write_text(body)
        (wrappers / name).chmod(0o755)
    for name in ['build-home', 'zig-cache', 'logs', 'prefix', 'runtime', 'build-host', 'build-arm', 'build-openssl', 'build-zlib']:
        (DATA / name).mkdir(exist_ok=True)
    env = {'HOME': str(DATA / 'build-home'), 'PATH': ':'.join(map(str, [wrappers, tools,
           tools / 'gperf/usr/bin', cmake.parent, make.parent, Path('/usr/bin'), Path('/bin')])),
           'LANG': 'C', 'LC_ALL': 'C', 'ZIG_GLOBAL_CACHE_DIR': str(DATA / 'zig-cache')}
    steps = []

    def run(name, args, cwd=DATA, extra=None):
        print(name, flush=True)
        start = time.monotonic()
        with (DATA / 'logs' / (name + '.log')).open('w') as log:
            result = subprocess.run(['timeout', '--kill-after=10s', '30m', *map(str, args)],
                                    cwd=cwd, env=env | (extra or {}), stdout=log, stderr=subprocess.STDOUT)
        steps.append({'step': name, 'exit': result.returncode, 'seconds': round(time.monotonic() - start, 2)})
        (DATA / 'build-result.json').write_text(json.dumps(steps, indent=2) + '\n')
        if result.returncode:
            print((DATA / 'logs' / (name + '.log')).read_text()[-6000:])
            raise SystemExit(result.returncode)

    source = DATA / 'td'
    run('host-configure', [cmake, '-S', source, '-B', DATA / 'build-host', '-G', 'Ninja',
        '-DCMAKE_C_COMPILER=' + str(wrappers / 'host-cc'), '-DCMAKE_CXX_COMPILER=' + str(wrappers / 'host-cxx'),
        '-DCMAKE_AR=' + str(wrappers / 'ar'), '-DCMAKE_RANLIB=' + str(wrappers / 'ranlib'),
        '-U', 'HAVE_CXX_FLAG_*', '-U', 'ATOMICS_FOUND',
        '-DCMAKE_BUILD_TYPE=Release', '-DTD_GENERATE_SOURCE_FILES=ON', '-DBUILD_TESTING=OFF'])
    run('host-generate', [cmake, '--build', DATA / 'build-host', '--target', 'prepare_cross_compiling', '-j', '8'])
    prefix = DATA / 'prefix'
    openssl = next((DATA / 'deps').glob('openssl-*'))
    run('openssl-configure', ['perl', openssl / 'Configure', 'linux-armv4', 'no-shared', 'no-tests',
        'no-module', 'no-apps', 'no-docs', '--prefix=' + str(prefix), '--libdir=lib'], DATA / 'build-openssl',
        {'CC': str(wrappers / 'arm-cc'), 'AR': str(wrappers / 'ar'), 'RANLIB': str(wrappers / 'ranlib')})
    run('openssl-build', [make, '-j8', 'build_libs'], DATA / 'build-openssl')
    run('openssl-install', [make, 'install_dev'], DATA / 'build-openssl')
    zlib = next((DATA / 'deps').glob('zlib-*'))
    run('zlib-configure', [zlib / 'configure', '--static', '--prefix=' + str(prefix)], DATA / 'build-zlib',
        {'CC': str(wrappers / 'arm-cc'), 'AR': str(wrappers / 'ar'), 'RANLIB': str(wrappers / 'ranlib')})
    run('zlib-build', [make, '-j8'], DATA / 'build-zlib')
    run('zlib-install', [make, 'install'], DATA / 'build-zlib')
    toolchain = DATA / 'arm.cmake'
    toolchain.write_text('\n'.join([
        'set(CMAKE_SYSTEM_NAME Linux)', 'set(CMAKE_SYSTEM_PROCESSOR armv7)',
        f'set(CMAKE_C_COMPILER "{wrappers / "arm-cc"}")',
        f'set(CMAKE_CXX_COMPILER "{wrappers / "arm-cxx"}")',
        f'set(CMAKE_AR "{wrappers / "ar"}")', f'set(CMAKE_RANLIB "{wrappers / "ranlib"}")',
        f'set(CMAKE_FIND_ROOT_PATH "{prefix}")', 'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)', 'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)', '']))
    run('arm-configure', [cmake, '-S', source, '-B', DATA / 'build-arm', '-G', 'Ninja',
        '-DCMAKE_TOOLCHAIN_FILE=' + str(toolchain), '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_C_FLAGS_RELEASE=-O2 -DNDEBUG', '-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG',
        '-DCMAKE_PREFIX_PATH=' + str(prefix), '-DOPENSSL_ROOT_DIR=' + str(prefix),
        '-DOPENSSL_USE_STATIC_LIBS=ON', '-DBUILD_TESTING=OFF', '-DTD_ENABLE_LTO=OFF'])
    run('arm-build', [cmake, '--build', DATA / 'build-arm', '--target', 'tdjson', '-j', '8'])
    run('stage-runtime', [sys.executable, HERE / 'stage-runtime.py'])


if __name__ == '__main__':
    main()
