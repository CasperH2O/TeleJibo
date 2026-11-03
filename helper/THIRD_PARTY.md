# Third-party notices

The Telegram helper is by CasperH2O, part of TeleJibo. Original code is GPL-3.0-or-later.
Dependency revisions and download checksums are in `pins.json`,
`media-pins.json` and `tools/*-lock.json`. Dependencies are downloaded during
setup and retain their upstream terms and notices.

| Component | Observed terms / origin |
| --- | --- |
| [TDLib](https://github.com/tdlib/td) | Boost Software License 1.0, `LICENSE_1_0.txt`; its bundled sources have additional notices |
| [tgcalls](https://github.com/TelegramMessenger/tgcalls) | LGPL-3.0; see `LICENSE` and the GPL text it incorporates |
| json11 in tgcalls | MIT, copyright Dropbox, Inc.; notice in `tgcalls/third-party/json11.hpp` and `.cpp`, reproduced in `licenses/json11-MIT.txt` |
| [tg_owt](https://github.com/desktop-app/tg_owt) / WebRTC | BSD-3-Clause at root; bundled third-party trees have additional terms/notices |
| abseil | Apache-2.0 (`LICENSE`) |
| crc32c | BSD-3-Clause (`LICENSE`) |
| libsrtp | BSD-style, Cisco and other contributors (`LICENSE`) |
| Opus | BSD-style plus patent grants/conditions (`COPYING`, `LICENSE_PLEASE_READ.txt`) |
| libvpx, libyuv | BSD-style plus `PATENTS` and contributor notices |
| OpenH264 | BSD-2-Clause source license; patent licensing is a separate question |
| libjpeg-turbo | IJG, BSD-3-Clause and zlib; preserve `LICENSE.md` and `README.ijg` |
| FFmpeg | LGPL-2.1-or-later default configuration, with optional GPL/version-3 components; see its `LICENSE.md` and actual configuration |
| OpenSSL | Apache-2.0 and bundled-source notices |
| zlib | zlib license (`LICENSE`) |
| Zig and bundled compiler/runtime | MIT plus bundled LLVM/libc/runtime component terms |
| CMake, Ninja, gperf, GNU make, Linaro GCC/binutils | Upstream tools under their individual BSD/Apache/GPL/runtime-exception terms; downloaded locally, not shipped |

This software is based in part on the work of the Independent JPEG Group.
The json11 MIT notice and the GPL/LGPL texts are in `licenses/`.
Dependency notices are retained with the fetched sources and copied into the
helper payload and the TeleJibo package.

Binary distribution must satisfy the applicable corresponding-source and
relinking requirements, including those of GPL/LGPL dependencies. Codec patent
licensing is separate from the source licenses. Build/download instructions
alone do not fulfill all binary distribution obligations.

Jibo, BEam and Telegram names identify compatibility and imply no endorsement.
No Jibo firmware is included. Use of the Telegram API is subject to its
[terms](https://core.telegram.org/api/terms).
