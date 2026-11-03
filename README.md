# TeleJibo

One-to-one Telegram video calls on Jibo, in Jibo's own classic look. Link your Telegram account once by scanning a code, then tap a contact to call, or answer when someone calls while TeleJibo is open. Swipe down to exit.

TeleJibo is an unofficial Telegram client for BE robots (BEam 3.1.7 or newer).
It is a development release. It has been exercised in the Jibo web simulator,
not yet on a physical Jibo.

## Using it

1. Install **TeleJibo** from BEacon's **Store → Skills** (or **⋮ → Upload Skill
   ZIP** with a release's `TeleJibo.zip`). It becomes the first button in the
   main menu. A voice launch rule ("Hey Jibo, open TeleJibo") is included but
   not yet tested.
2. Open it. Jibo shows a code: on your phone open Telegram, go to **Settings →
   Devices → Link Desktop Device** and scan it. Accounts with a two-step
   password are asked for it on Jibo's keyboard.
3. Your contacts appear, most recent conversations first. Swipe sideways for
   more. Tap someone to call them.
4. During a call: **Mute**, **Camera** (each call starts with Jibo's camera
   off), **Look at me** (Jibo turns to follow your face) and **End**.
5. **Settings** (top right) signs the robot out of Telegram.

Calls only come in while TeleJibo is open. During a call TeleJibo asks Jibo not
to switch to another skill.

## Privacy

TeleJibo runs on the robot and talks only to Telegram. Your session is stored
encrypted in Jibo's private storage
(`/opt/jibo/Knowledge/beacon/custom-skills/telejibo/account`) and is removed by
**Sign out**. Calls are not recorded. The microphone, speaker and camera are
held only during a call. Like every BEacon custom skill, TeleJibo runs code on
your robot; install it only from a source you trust.

Telegram identifies apps by an API id. Releases carry the publisher's id in a
scrambled form; it is not a secret and gives no access to anyone's account.
To use your own, place `{"api_id": 123, "api_hash": "…"}` in
`api.override.json` beside the account folder.

## How it works

- `telejibo/`: the BEam asset-pack skill. `lib/screen.js` is the face UI, built
  from the SDK's stock Labels and ActionButtons (`lib/layout.js` holds the
  classic design tokens and geometry); `lib/helper.js` supervises the Telegram
  helper over private JSON-line pipes; `lib/media.js` connects the microphone
  (ALSA `MediaIn`) and speaker (`MediaOut`) through GStreamer and the camera
  through the LPS media service's preview.
- `helper/`: the Telegram helper (`bin/telegram-helper`), an ARMv7 program built
  with TDLib and tgcalls: its C++ source (`helper/media/`), pinned dependencies
  and the complete build tooling. See [helper/README.md](helper/README.md).
- `tools/package.py`: builds the store ZIP; `tools/make-art.py`: the icons.

See [docs/BUILD.md](docs/BUILD.md) to build, test and release.

## License

[GPL-3.0-or-later](LICENSE.md). Third-party components keep their own terms:
[THIRD_PARTY.md](THIRD_PARTY.md).
