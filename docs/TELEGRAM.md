# Telegram

Message BitBull from your phone, and get scheduled results there, through a Telegram bot that is
yours alone. The code is `server/src/telegram.ts`; the tests are `server/src/telegram.test.ts`.

**Private and personal.** One bot, one BitBull, one Telegram account: the account holder's. The
bot answers that account's private chat and nothing else. Other people, group chats, channels
and other bots are ignored without a reply, so someone who finds the bot learns nothing from it.
There is no shared, team or public mode.

## Set it up

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot` and follow it. It
   gives you a token that looks like `123456789:AA…`.
2. In BitBull: **Settings → Integrations → Telegram**. Paste the token in **Bot token**, Save.
3. Press **Pair my Telegram**. BitBull shows a button that opens your bot (press **Start** in
   Telegram) and a one-time code you can send to the bot instead. Either pairs your account.

That is all. Nothing has to reach your computer from the internet: BitBull calls out to Telegram
and waits for messages (long polling), so there is no port to open, no tunnel and no public
address.

## Use it

| You send | What happens |
|---|---|
| any text | BitBull runs it as a turn in the **Telegram** chat and replies when it has finished |
| `/new` | starts a fresh chat (the old one stays in BitBull) |
| `/stop` | stops what it is doing |
| `/model` | says which model this chat uses |
| `/model deepseek flash` | changes it: a few words of the name are enough; if several models match, it lists them and changes nothing |
| `/models claude` | lists the models matching a word |
| `/help` | the list above |

The Telegram chat is an ordinary chat in BitBull's sidebar: what you say from the phone and what
it answers are both there, with the tool calls and costs, and you can carry on from either side.
A Telegram chat starts on your default engine and model (Settings → Configuration), not on
whichever model you last picked in a chat on screen. Change it from the phone with `/model`, or
in BitBull like any other chat; `/new` keeps the model you chose.

**Schedules:** tick **Send each result to my Telegram** on a schedule and the summary of every
run arrives on your phone. The run itself still lands in the schedule's own chat.

### What it won't do from the phone

- **Anything that can't be undone.** Nobody is at the BitBull screen when a message arrives by
  phone, and the turn is told so: anything that publishes, sends, posts, deletes or spends is
  prepared and reported as waiting for your approval in BitBull.
- **Approvals.** A request that needs a click in BitBull (network access to a new site, for
  one) can't be answered from Telegram. The reply says what is waiting.
- **Photos, voice notes, files.** Text only for now.
- **Old messages.** A message that reaches BitBull more than 15 minutes after you sent it
  (BitBull was off or offline) is not run; the bot says so and you can send it again.

Replies are plain text. Long ones are split into several messages, and a very long one is cut
with a note that the rest is in BitBull.

## How it is kept private

- **Who may talk to it** is one Telegram account id, set only by pairing. A message is acted on
  only if it comes from that account, from a person (not a bot), in the one-to-one chat with the
  bot. Everything else is dropped unanswered and counted; Activity gets one line an hour per sender.
- **The pairing code** is 8 characters from a 32-character alphabet, lives in memory only, works
  once, lasts 10 minutes, and is cancelled after 5 wrong tries. Wrong tries get no reply.
- **The pairing can't be planted.** It is stored in BitBull's database, which lives in the data
  folder the agent's shell can write. So the record carries a signature made with the bot token,
  which the agent is not given: a record that was added or edited by anything else doesn't
  verify and counts as not paired. For the same reason a new token unpairs: pair again.
- **The token** is a secret like BitBull's other keys: it goes in the vault when the vault is
  on, it is never returned by the API or shown in full, it is removed from the agent's
  environment and redacted from its output and from the Activity log. It is only ever sent to
  Telegram's API. Where that is (`TELEGRAM_API_URL`) can be set in `.env` only, never from the UI
  or the data folder.
- **Unpair** in Settings and the bot answers nobody. To cut it off completely, also revoke the
  token in @BotFather (`/revoke`) and clear it in Settings.

### What to know

- **Telegram can read it.** Bot chats are not end-to-end encrypted: your messages and BitBull's
  replies pass through, and are stored on, Telegram's servers. Don't send secrets through it,
  and think about what a scheduled result contains before sending it there.
- **Your Telegram account is the key.** Whoever can use your Telegram account can talk to your
  BitBull. Turn on Telegram's two-step verification and a passcode lock on the app.
- **The network opening.** In the sandbox, `api.telegram.org` is reachable only while a bot
  token is set (it is not on the static allowlist). The proxy can't tell BitBull's own calls from
  the agent's shell, so while Telegram is on, the agent can reach that host too. It can't use
  your bot (it doesn't have the token), but a prompt-injected agent could send data out through
  a bot of the attacker's. That is the same kind of risk as every other allowed domain; it is
  listed in `docs/THREAT-MODEL.md` (R10). Leave the token empty if you don't use Telegram.
- **One reader per bot.** A bot's messages can be read from one place. If another BitBull, or
  another program, uses the same token, Settings says so; give each BitBull its own bot.

## Settings

| Key | Where | What |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Settings or `.env` | The bot's token from @BotFather. Empty: Telegram is off. |
| `TELEGRAM_API_URL` | `.env` only | Bot API address, for a self-hosted Bot API server. Default `https://api.telegram.org`. If you change it, add its host to `egress/allowlist.txt`. |

## API

All under the app token, like the rest of `/api`. None returns the bot token.

| Method | Path | |
|---|---|---|
| `GET` | `/api/telegram` | State: connected bot, who is paired, a live pairing code |
| `POST` / `DELETE` | `/api/telegram/pair` | Make a pairing code / cancel it |
| `POST` | `/api/telegram/unpair` | Forget the paired account |
| `POST` | `/api/telegram/test` | Send a test message to the paired account |

## Not in this version

WhatsApp (parked), photos and files in either direction, voice notes, approving waiting actions
from the phone, more than one account, group chats.
