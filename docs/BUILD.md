# Build, test and release

Needs Python 3.10+ and Node.js 20+ (for the tests and the packager's key
encoder). The skill itself targets the robot's Node 6: ES2015, no async/await,
no `Object.entries`.

## Tests

```sh
node --test tests/*.test.mjs
```

They cover the layout rules (safe area, touch sizes, paging), the app key, the
helper launch and supervisor, and the packager's limits and contents. The
helper's own tests are described in [helper/README.md](../helper/README.md).

## The helper

The Telegram helper (`telejibo/bin/telegram-helper` and `libtdjson.so`) is built
from this repository's `helper/` directory: its C++ source, pinned dependencies
and build tooling. The full steps, requirements and timing are in
[helper/README.md](../helper/README.md). In short, from `helper/`:

```sh
python3 tools/setup.py && python3 fetch.py && python3 build-tdlib.py
python3 fetch-media.py && python3 build-media.py
python3 relink-tdlib.py --optimize-generated
python3 stage.py            # writes helper/data/payload/
```

`stage.py` records the SHA-256 of the binaries and of the helper source tree in
`payload/stage.json`. The packager refuses a payload whose binaries differ from
that record, or one built from older helper source than the tree it packages.

## Artwork

```sh
python3 tools/make-art.py            # icon.png, banner.png, telejibo/resources/icons/*.png
```

Deterministic; commit the PNGs it writes.

## Package

```sh
python3 tools/package.py --api-file <private>/api.json
```

The helper payload defaults to `helper/data/payload` (`--helper-payload` overrides
it). `--api-file` is the publisher's Telegram app key from
[my.telegram.org](https://core.telegram.org/api/obtaining_api_id). Keep it
outside this repository; `.gitignore` refuses `api.json`, `telejibo/bin/` and
`telejibo/config/` anyway. Without it the build installs, but each robot then
needs its own `api.override.json`.

The result is `dist/TeleJibo.zip`: store metadata at the root, the skill in
`telejibo/`, the helper in `telejibo/bin/` with its notices and source snapshot
in `telejibo/helper/`. The packager checks BEacon's limits (32 MB compressed,
64 MB expanded, 1,024 entries) and prints the numbers.

## Try it

- **Simulator** (jibo-web-sim with a BE profile and `ROBOT_ARM_ROOT`): BEacon
  **⋮ → Upload Skill ZIP**, or
  `curl -X PUT --data-binary @dist/TeleJibo.zip 'http://127.0.0.1:8123/api/skills/upload?name=TeleJibo.zip'`.
  Turn on the Camera tab for the camera.
- **Robot**: the same upload through the robot's BEacon.

## Release (BEacon Store)

1. Bump `version` in both `manifest.json` and `telejibo/package.json`, and
   `supported` if TeleJibo needs a newer BEam.
2. Tag the commit, publish a GitHub release (not a draft or prerelease) and
   attach `dist/TeleJibo.zip`. The Store prefers the attached ZIP; the tag's
   source ZIP has no helper, so it cannot work.
3. The Store reads `manifest.json`, `README.md` and `banner.png` from the tag.
   Listing in the official storefront is up to its maintainers.
