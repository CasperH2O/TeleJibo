# The Telegram helper

`telegram-helper` is the native ARMv7 program TeleJibo's skill runs on the robot. It
links TDLib (Telegram's client library) and tgcalls/tg_owt (its call engine), talks to
the skill over private JSON-line pipes, and carries the call's audio and video over
inherited pipes. The protocol is described in [docs/HELPER.md](docs/HELPER.md).

This directory is everything needed to build it: the C++ source (`media/`), pinned
dependency sources (`pins.json`, `media-pins.json`), pinned build tools
(`tools/*-lock.json`) and the scripts. Nothing outside this repository is needed.

## Requirements

An x86-64 Linux host (Ubuntu 24.04 or WSL2 tested) with Python 3.12+, Bash, Perl,
coreutils, `dpkg-deb` and binutils (`readelf`). Allow about 7 GB of disk, several GB
of RAM and a few hours for the first build (eight parallel C++ jobs). Use a checkout
path without whitespace. Scripts need no sudo and install nothing system-wide: all
downloads and outputs go under the ignored `helper/data/`, every download is checked
against a pinned SHA-256, and the compiler (Zig), GNU make and ARM binutils are
downloaded into `data/prerequisites/`.

The target is ARMv7 hard-float (Cortex-A15), glibc 2.17 or newer. The binaries may
contain absolute source paths and can differ between hosts, so they are not compared
against fixed checksums; `stage.py` records what you built instead (below).

## Build

From this directory:

```sh
python3 tools/setup.py                      # build tools
python3 fetch.py                            # TDLib, OpenSSL, zlib sources
python3 build-tdlib.py
python3 fetch-media.py                      # tgcalls, tg_owt and codec sources
python3 build-media.py
python3 relink-tdlib.py --optimize-generated   # size-optimised TDLib runtime
python3 stage.py                            # data/payload/ for the packager
```

`build-media.py --dependencies-only` builds only the codecs; `--engine-only` rebuilds
just the helper from existing codec outputs. Keep generated CMake directories where
they were created: they contain absolute paths. `python3 verify-media-sources.py`
checks the downloaded sources and the FFmpeg patch in `media/patches/`.

## Tests

Neither suite needs an ARM build or a Telegram account:

```sh
python3 tools/test-account.py    # account/call controller against synthetic TDLib updates
python3 tools/test-media.py      # pipe framing, stale-input discard and cleanup
```

They need the downloads from `fetch.py`/`fetch-media.py` and the Zig compiler from
`tools/setup.py`.

## Staging and packaging

`stage.py` writes `data/payload/`: the stripped binaries in `bin/`, dependency
license texts, build provenance (`BUILD-SOURCES.json`, `ACCOUNT-SOURCES.json`), a
snapshot of this directory as `source/` (the corresponding source the GPL/LGPL
components require) and `stage.json`, the SHA-256 of each binary and of the source
snapshot. From the repository root, `tools/package.py` picks that payload up
(`--helper-payload` overrides the path) and refuses it if a binary differs from
`stage.json`, or if this directory changed after the binaries were built. Edit the
source, rebuild, run `stage.py` again.

## Running it by hand

On compatible ARM Linux, put `telegram-helper` and `libtdjson.so.*` together and see
[docs/HELPER.md](docs/HELPER.md) (`--api-file`, `--state-dir`, the media pipes,
`--synthetic-media` for development).

## Licenses

GPL-3.0-or-later like the rest of the repository ([LICENSE.md](../LICENSE.md)).
Dependencies keep their own terms; see [THIRD_PARTY.md](THIRD_PARTY.md).
