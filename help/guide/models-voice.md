## Which model for this?
On the home screen: describe a job and BitBull suggests three models from SayGM's live catalogue,
best value, best quality and the cheapest that will still do it, each with pros and cons, an
estimated cost for the whole task, and how that model has done for you here. **Use this model**
sets it for the chat. Code first keeps only models that can do the job (tools; vision when the
task involves images); the advisor model then chooses from that table with today's prices and
your record, so it never relies on what it remembers about models. The advisor is
`ADVISOR_MODEL` (default: the small model; a cheap one is enough) and **Ask a stronger model** uses
`ADVISOR_STRONG_MODEL` (default: the default model), both in Settings → Configuration.

Your record per model (turns, errors, stopped, cost, tokens, speed, last used) comes from the
turns and replies BitBull already stores: `GET /api/models/usage`, and the "Your use" column and
panel in the model browser.

## Voice
Talk to BitBull and have it talk back: the **mic button** in the message bar (click, talk, click),
**push-to-talk** (hold Ctrl+Shift+Space, or ⌘+Shift+Space on a Mac; from any app in the desktop app),
**hands-free** (the headset button: talk, pause, hear the answer, talk over it to interrupt) and
**read aloud** under any reply. Speech is written down by a Gemini model on SayGM and answered by
the chat's own model; BitBull's own gruff cartoon-dog voice (with his own laugh), plus one UK and seven US voices, is generated in the container by Piper.
Microphone, speaker, voice, speed and pause length are in Settings → Voice and kept per computer.
Details, licences and privacy: [docs/VOICE.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/VOICE.md).
