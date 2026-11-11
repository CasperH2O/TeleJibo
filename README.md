# TeleJibo

Bring a familiar face to Jibo. TeleJibo puts your Telegram video calls on
Jibo's screen, with a swipeable contact list, simple call controls and head
tracking that follows you as you move. Link your account by scanning a code,
then tap a contact to call, ask Jibo to call someone by name, or answer a
friend, even while TeleJibo is closed if you switch that on.

TeleJibo 0.2 needs BEam 3.1.9 or newer.

![TeleJibo contact list and video call, illustrated with fictional demo contacts](banner.png)

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
4. During a call: **Mute**, **Camera**, **Look at me** (Jibo turns to follow
   your face), **End**, and a button for the picture's shape: **Automatic**
   follows the caller's video, **Landscape** and **Portrait** keep one layout.
   Camera and head tracking start on when the call connects. A small picture
   of your own camera sits in a corner; tap it to hide it for that call.
5. **Settings** (top right):
   - **Ring when closed** (off by default): keep Telegram connected while
     TeleJibo is closed, so an incoming call opens TeleJibo and rings.
   - **Orientation**: the same Automatic / Landscape / Portrait choice.
   - **Sign out** signs the robot out of Telegram.

By voice (not yet tested on a robot): "Hey Jibo, video call Anna" finds the
contact and asks **Video call?** before dialling; say yes or no, or tap. While
a call rings you can say "answer" or "decline".

With **Ring when closed** off, calls only come in while TeleJibo is open. With it
on, Jibo rings whenever BEam lets TeleJibo take the screen; a call that could
not be shown (an alarm was going off, say) is noted on the contacts screen.
During a call TeleJibo asks Jibo not to switch to another skill.

Video goes out at Jibo's camera quality, 1280x720, straight from his hardware
encoder without being re-encoded, at about 30 frames a second. It uses a fixed
rate of about 3 Mbit/s; on a weak connection the picture may stutter. If the camera stream is not
available, TeleJibo falls back to slower preview pictures.

## Privacy

TeleJibo runs on the robot and talks only to Telegram. Your session is stored
encrypted in Jibo's private storage
(`/opt/jibo/Knowledge/beacon/custom-skills/telejibo/account`) and is removed by
**Sign out**. Your settings are in `settings.json` in the same folder; TeleJibo
writes nowhere else. Calls are not recorded. The camera, microphone and speaker
are opened only to prepare or run a call, never in the background: with
**Background** on, only the Telegram connection stays up, and nothing is
captured until you answer. Jibo listens for a spoken answer only while a
question is on screen (an incoming call, or "Video call?"). Like every BEacon
custom skill, TeleJibo runs code on your robot; install it only from a source
you trust.
