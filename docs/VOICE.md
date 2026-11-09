# Voice

Talk to BitBull and have it talk back, in the chat window or from across the room.

## Using it

| | How | What happens |
| --- | --- | --- |
| **Mic button** | click, talk, click again | your words land in the message box to check or edit; press Enter and the reply is read out |
| **Push-to-talk** | hold **Ctrl+Shift+Space** (**⌘+Shift+Space** on a Mac), talk, let go | sent straight away and the reply is read out. In the desktop app this works from any app; in a browser, while the BitBull tab has focus |
| **Hands-free** | the headset button | BitBull listens; each thing you say is sent when you pause, the reply is spoken, then it listens again. Talk over a reply to interrupt it. Click again to stop listening |
| **Read aloud** | the speaker button under any reply | reads that reply; click again to stop |
| **Stop speaking** | the crossed-out speaker in the message bar | stops whatever is being said |

Replies are spoken while they are still arriving, a sentence or two at a time. Code blocks, tables
and links are on screen, so they are not read out ("code on screen").

## Settings → Voice

Kept on **this computer only** (browser storage), so a laptop and a desktop each keep their own:

- **Microphone** and **Speaker**, with a level meter and a test. Device names appear once the
  page has been allowed the microphone (**Allow microphone**). Choosing the speaker needs a
  Chromium-based browser or the Windows app (WebView2); elsewhere the system default is used.
- **Voice engine**: *BitBull voices* (Piper, generated in the container, nothing leaves your
  machine) or *This computer's* (the operating system's built-in voices).
- **Voice**: BitBull's own cartoon-dog voice (the default), plus one UK and seven US voices, **Speed** and **Speak replies** (read out the answer when you
  asked by voice; always on in hands-free).
- **Hands-free pause**: how long a silence ends what you are saying.
- **Listening model**: shown here, chosen under Configuration → *Voice: listening model*.

## How it works

```
mic ─► browser: 16 kHz mono WAV ─► POST /api/voice/transcribe ─► SayGM, Gemini generateContent (audio)
                                                                     │
                       chat model (whatever the chat uses) ◄── text ─┘
                                 │ streaming reply
browser: sentences ─► POST /api/voice/speak ─► Piper in the container ─► WAV ─► chosen speaker
```

- **Listening (speech to text)**: SayGM has no audio models, but its Gemini models take audio.
  The server sends the recording to `VOICE_STT_MODEL`, or by default the cheapest Gemini *flash* model
  in the catalogue, and asks for a verbatim transcript. Each transcription is logged in activity
  with its cost. Recordings are checked (a real WAV, at most 120 s, 12 MB) and never stored.
- **Speaking (text to speech)**: [Piper](https://github.com/rhasspy/piper) 2023.11.14-2, baked
  into the image at build time with sha256 checks (`voice/piper.sha256`); amd64 and arm64. At most
  two voices are generated at once; each request is capped at 4,000 characters.
- **Hands-free** listens in the browser (voice-activity detection on the level against the room's
  background). While BitBull is talking it needs clearly louder speech to count as you, and echo
  cancellation is on, so its own voice is mostly not mistaken for yours. Headphones help most.
- **Push-to-talk shortcut**: the desktop app registers it as a global shortcut and passes only
  "down"/"up" into the BitBull window as a DOM event (that window has no IPC). If another app
  already owns the combination, the mic button still works.
- On a Mac, macOS asks once for the microphone (`NSMicrophoneUsageDescription` in
  `desktop/src-tauri/Info.plist`).

## BitBull's own voice

The default voice is BitBull himself: an original cartoon-dog character, a big, gruff,
good-natured voice with his own huffing chuckle. It is not modelled on any existing character.
`server/src/dogvoice.ts` has Piper speak a little faster, then lowers pitch and formants together
(so it sounds like a bigger animal rather than a slowed tape), adds gravel (a fast flutter and soft
saturation) and some bass. When a reply laughs ("haha", "lol", 😂, *laughs*), he laughs instead of
reading it out. The laugh is synthesised from scratch (voice source, vowel resonances and breath),
so there is no recording behind it.

## Privacy

What you say is sent to SayGM (and from there to Google's Gemini) to be written down, the same
way your typed messages go to the chat model. BitBull's own voices are generated locally. Nothing
is recorded unless the mic button is red, the shortcut is held, or hands-free is on (the headset
button shows a pulsing dot).

## Voices and licences

| Voice | Source | Licence |
| --- | --- | --- |
| **BitBull** (cartoon dog, the default) | LibriTTS speaker 54, reshaped in `server/src/dogvoice.ts` | CC BY 4.0; the effects and the laugh are BitBull's own |
| Southern English (UK), female | OpenSLR 83 | CC BY-SA 4.0 |
| Warm, Clear, Bright (US), female; Deep, Calm, Steady, Bright (US), male | LibriTTS speakers 0, 30, 53, 42, 97, 16, 54 | CC BY 4.0 |

Piper itself is MIT. Voices whose recordings are non-commercial or unlicensed (lessac, ryan, alan,
amy) are deliberately left out.

## API

- `GET /api/voice`: voices, whether Piper is in the image, the listening model and its price.
- `POST /api/voice/speak` `{text, voice, speed}` → `audio/wav`.
- `POST /api/voice/transcribe` (body: `audio/wav`) → `{text, model, seconds, costUsd}`.
