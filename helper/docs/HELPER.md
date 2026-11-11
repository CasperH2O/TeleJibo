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
| 5 | to helper | camera, one of two record kinds (below) |
| 6 | from helper | received video: `JIVF`, little-endian uint32 width and height, I420 |

The camera pipe carries records, all integers little-endian uint32:

| Record | Layout | Meaning |
| --- | --- | --- |
| `JIWM` | length, stream serial, piece index, then `length` bytes (at most 1 MiB) | a piece of the camera's live WebM (VP8) stream |
| `JICF` | width, height (320, 240), then I420 | a decoded preview frame (the fallback) |

A WebM stream is the records of one serial, index 0 upward with none missing. The
helper reads its VP8 frames (`media/webm-reader.h`) and hands them to the call
already encoded (`CameraEncoder` in `media/platform.cpp`): nothing is decoded or
re-encoded, and the call's own rate control cannot change them. A new serial is a
new stream and starts with a keyframe. The hardware encoder cannot be asked for a
keyframe, so when the far side needs one, or a piece is missing, or the encoder
falls more than about a second behind, the helper emits
`{"event":"camera","state":"restart"}` (at most once per two seconds) and the
skill starts a new stream. While `JIWM` records arrive the robot sends VP8 only.
`JICF` frames are encoded by the stock VP8 encoder; the newest complete frame is
used and the header lets the helper find the next whole record after a partial one.

Calls stay refused until the app sends `{"method":"media.ready","enabled":true}`,
which it does only after its microphone has delivered audio and the camera is
known to be there. The camera starts off for every call. Stale input is discarded
when a call starts or the camera is switched on, queued microphone audio is capped
at about 40 ms, and output queues are bounded and drop rather than block.

`media_stats` (every five seconds during a call) reports what is received and,
for the camera, `camera_mode` (`stream` or `frames`), `camera_sent_frames`,
`camera_waiting_frames`, `camera_restarts`, `camera_overflows`, the stream's size
and `camera_target_bps` (what the call would like to use; the stream is fixed).

`--synthetic-media` instead enables pattern/tone capture and headless receive
sinks for development with a consenting contact; it does not access robot
peripherals and cannot be combined with `--pipe-media`. `--relay-only` disables
direct P2P.

Account state includes an encrypted TDLib database and its local encryption key;
protect the whole directory. Logout removes that directory while preserving the
separate API file. Audio/video is processed in memory without a recording feature.

`--require-heartbeat` closes the helper after five seconds without a `ping`.
