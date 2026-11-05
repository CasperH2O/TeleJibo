# Helper setup

The helper uses private stdin/stdout JSON-line pipes for account and call control.
The skill starts and supervises it automatically. For helper development on
compatible ARM Linux, place the built helper and TDLib library together and run:

```sh
./telegram-helper --api-file /path/to/private/api.json --state-dir /path/to/private/account
```

Create `api.json` with your own integer `api_id` and string `api_hash` from
[Telegram application registration](https://core.telegram.org/api/obtaining_api_id).
Use file mode 0600 and private directory mode 0700. The state directory's parent
must exist. Keep the API file outside the account directory and outside Git.
The TeleJibo skill keeps the file at `<dataRoot>/api.json`.

Commands are JSON lines such as `{"method":"status"}`, `{"method":"contacts","offset":0}`,
`{"method":"logout"}` and `{"method":"close"}`. Authorization events carry the
current QR link or password-required state. Contacts are ordered by your main chat
list (most recent conversation first), then the rest. For each contact shown, an
`avatar` event carries its small profile photo (JPEG, base64, at most 64 KB) once;
only files inside TDLib's own photo and file directories are read. Lines are at
most 128 KB. Keep QR links, passwords, contact and avatar events out of logs. See
`media/account.h` for the command and event definitions.

The helper refuses calls by default. The TeleJibo skill always starts it with
`--pipe-media`; calls are then gated by `media.ready` (below), which the skill
sends only while it holds the camera, microphone and speaker. Media flows over
private inherited pipes, never files:

| fd | Direction | Format |
| --- | --- | --- |
| 3 | to helper | microphone, S16LE stereo 48 kHz, 10 ms frames |
| 4 | from helper | decoded call audio, same format |
| 5 | to helper | camera: `JICF`, little-endian uint32 width and height (320, 240), I420 |
| 6 | from helper | received video: `JIVF`, little-endian uint32 width and height, I420 |

Calls stay refused until the app sends `{"method":"media.ready","enabled":true}`,
which it does only after its microphone and camera have delivered data. The camera
starts off for every call. Stale input is discarded when a call starts, queued
microphone audio is capped at about 50 ms, and output queues are bounded and drop
rather than block. The camera header lets the helper find the next whole frame
after a partial one (a frame cut short when a call ended), so camera framing never
drifts; only the newest complete frame is used.

`--synthetic-media` instead enables pattern/tone capture and headless receive
sinks for development with a consenting contact; it does not access robot
peripherals and cannot be combined with `--pipe-media`. `--relay-only` disables
direct P2P.

Account state includes an encrypted TDLib database and its local encryption key;
protect the whole directory. Logout removes that directory while preserving the
separate API file. Audio/video is processed in memory without a recording feature.

`--require-heartbeat` closes the helper after five seconds without a `ping`.
