# Third-party notices

TeleJibo is by CasperH2O. Its skill code is GPL-3.0-or-later.

| Component | Terms / origin |
| --- | --- |
| Telegram helper (`bin/telegram-helper`, `bin/libtdjson.so.*`) | Built from this repository's `helper/` (GPL-3.0-or-later, notices in `helper/THIRD_PARTY.md`). It links TDLib (Boost 1.0), tgcalls (LGPL-3.0), tg_owt/WebRTC (BSD-3-Clause and bundled terms), abseil, crc32c, libsrtp, Opus, libvpx, libyuv, OpenH264, libjpeg-turbo, FFmpeg (LGPL-2.1-or-later configuration), OpenSSL and zlib. Release packages carry the helper's own `THIRD_PARTY.md`, every license text, its build provenance (`BUILD-SOURCES.json`, `ACCOUNT-SOURCES.json`) and its source snapshot in `telejibo/helper/`. |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 | MIT, copyright Kazuhiko Arase; `telejibo/vendor/qrcode.js` is the npm release's `qrcode.js` (SHA-256 `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780`), license in `licenses/qrcode-generator-MIT.txt` |

Icons and artwork are original (`tools/make-art.py`). The UI uses Jibo's own
stock action icons and fonts from the robot at run time; none are included.

This software is based in part on the work of the Independent JPEG Group.

Binary distribution must satisfy the applicable corresponding-source and
relinking requirements, including those of the GPL/LGPL components; the build
tools in `helper/` reproduce and relink the helper binaries. Codec patent
licensing is separate from the source licenses.

TeleJibo is an unofficial client. Jibo, BEam, BEacon and Telegram names
identify compatibility and imply no endorsement. No Jibo firmware is included.
Use of the Telegram API is subject to its [terms](https://core.telegram.org/api/terms).
