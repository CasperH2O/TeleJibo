#!/usr/bin/env python3
"""Relink separate TDLib copies with only its documented public C ABI exported.

Uses the existing verified ARM object/archive build. Does not replace the
baseline runtime, active guest, firmware, compiler flags or protocol sources.
"""
import argparse
import concurrent.futures
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
    parser.add_argument('--optimize-json', action='store_true', help='Recompile only the generated JSON adapter at -Oz into a separate archive')
    parser.add_argument('--optimize-api', action='store_true', help='Also size-optimize generated TDLib API classes in a separate archive')
    parser.add_argument('--optimize-generated', action='store_true', help='Also size-optimize one generated MTProto API shard; source remains unchanged')
    options = parser.parse_args()
    pins = json.loads((HERE / 'pins.json').read_text())
    strip = REPO / pins['tools']['strip']['path']
    with strip.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != pins['tools']['strip']['sha256']:
            raise SystemExit('Strip tool checksum mismatch')
    build = DATA / 'build-arm'
    commands = subprocess.check_output([str(DATA / 'tools/ninja'), '-C', str(build), '-t', 'commands', 'tdjson'], text=True)
    link = next(line for line in reversed(commands.splitlines()) if '-shared' in line and 'libtdjson.so' in line)
    args = shlex.split(link)
    # CMake's generated rule is ': && compiler ... && :'. Never run this via a
    # shell: extract the one compiler command, retaining argument boundaries.
    if args[:2] != [':', '&&'] or args[-2:] != ['&&', ':'] or args[2:-2].count('&&'):
        raise SystemExit('Unexpected generated link rule')
    command = args[2:-2]
    if Path(command[0]) != DATA / 'wrappers/arm-cxx':
        raise SystemExit('Unexpected link compiler')
    destination = DATA / 'release-runtime'
    destination.mkdir(exist_ok=True)
    name = command[command.index('-o') + 1]
    unstripped = destination / (Path(name).name + '.unstripped')
    output = destination / Path(name).name
    command[command.index('-o') + 1] = str(unstripped)
    command += ['-Wl,--version-script,' + str(HERE / 'tdjson.exports'), '-Wl,--gc-sections']
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(DATA / 'build-home'), 'LANG': 'C',
           'ZIG_GLOBAL_CACHE_DIR': str(DATA / 'zig-cache')}
    started = time.monotonic()
    if options.optimize_json or options.optimize_api or options.optimize_generated:
        objects = destination / 'json-objects'
        objects.mkdir(exist_ok=True)

        def compile_one(line):
            args = shlex.split(line)
            original = args[args.index('-o') + 1]
            output = objects / Path(original).name
            args[args.index('-o') + 1] = str(output)
            clean = []
            index = 0
            while index < len(args):
                if args[index] in ['-MT', '-MF']:
                    index += 2
                elif args[index] == '-MD':
                    index += 1
                else:
                    clean.append('-Oz' if args[index] == '-O2' else args[index])
                    index += 1
            result = subprocess.run(clean, cwd=build, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
            if result.returncode:
                raise RuntimeError(result.stdout.decode(errors='replace')[-4000:])
            return output

        targets = ['tdjson_private'] + (['tdapi'] if options.optimize_api or options.optimize_generated else [])
        if options.optimize_generated:
            targets.append('tdcore')
        for target in targets:
            compile_commands = [line for line in commands.splitlines() if target + '.dir/' in line and ' -c ' in line]
            if target == 'tdcore':
                compile_commands = [line for line in compile_commands if line.endswith('/td/generate/auto/td/telegram/telegram_api_0.cpp')]
            if not compile_commands:
                raise SystemExit('No adapter compile rules found: ' + target)
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
                rebuilt = list(executor.map(compile_one, compile_commands))
            archive = destination / ('lib' + target + '.size.a')
            original = 'lib' + target + '.a'
            shutil.copy2(build / original, archive)
            subprocess.run([str(DATA / 'wrappers/ar'), 'rcs', str(archive), *map(str, rebuilt)], check=True, timeout=60)
            command = [str(archive) if item == original else item for item in command]
    with (destination / 'link.log').open('w') as log:
        result = subprocess.run(command, cwd=build, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    if result.returncode:
        print((destination / 'link.log').read_text()[-4000:])
        raise SystemExit(result.returncode)
    subprocess.run([str(strip), '--strip-unneeded', '-o', str(output), str(unstripped)], check=True, timeout=60)
    readelf = subprocess.check_output(['readelf', '--dyn-syms', '--wide', str(output)], text=True)
    exports = [line.split()[-1] for line in readelf.splitlines() if ' GLOBAL ' in line and ' UND ' not in line]
    expected = [line.strip().removesuffix(';') for line in (HERE / 'tdjson.exports').read_text().splitlines() if line.strip().startswith('td_')]
    checks = {'public_c_exports_exact': sorted(exports) == sorted(expected),
              'within_size_limit': output.stat().st_size <= 33554432}
    report = {'checks': checks, 'bytes': output.stat().st_size, 'baseline_bytes': (DATA / 'runtime' / output.name).stat().st_size,
              'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'exports': sorted(exports),
              'seconds': round(time.monotonic() - started, 2),
              'adapter_optimization': ('-Oz JSON + API classes + generated MTProto shard 0' if options.optimize_generated else '-Oz JSON + API classes' if options.optimize_api else '-Oz JSON' if options.optimize_json else 'baseline -O2'),
              'target': 'ARMv7 / glibc 2.17; restricted TDLib C ABI'}
    (destination / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if all(checks.values()) else 1)


if __name__ == '__main__':
    main()
