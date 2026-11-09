# TeleJibo

Bring a familiar face to Jibo. TeleJibo puts your Telegram video calls on
Jibo's screen, with a swipeable contact list, simple call controls and head
tracking that follows you as you move. Link your account by scanning a code,
then tap a contact to call or answer a friend while TeleJibo is open.

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
4. During a call: **Camera**, **Look at me** (Jibo turns to follow your face)
   and **End**. Camera and head tracking start on when the call connects;
   **Mic off** indicates that microphone capture is disabled in this build.
5. **Settings** (top right) signs the robot out of Telegram.

Calls only come in while TeleJibo is open. During a call TeleJibo asks Jibo not
to switch to another skill.

## Privacy

TeleJibo runs on the robot and talks only to Telegram. Your session is stored
encrypted in Jibo's private storage
(`/opt/jibo/Knowledge/beacon/custom-skills/telejibo/account`) and is removed by
**Sign out**. Calls are not recorded. The speaker and camera are
opened only to prepare or run a call; microphone capture stays disabled in this
build. Like every BEacon custom skill, TeleJibo runs code on
your robot; install it only from a source you trust.
