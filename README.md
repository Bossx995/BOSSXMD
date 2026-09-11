# Boss X WhatsApp Bot v1.5.3

## Important
This version specifically fixes the message listener/command handling.

Commands work both with and without the prefix:
- `ping` or `.ping`
- `menu` or `.menu`

## Commands
- .menu / .help
- .ping
- .owner
- .channel
- .anticall on/off
- .antibot on/off
- .group open / .group close
- .botadd <number>
- .botdel <number>
- .antidelete on/off
- .anticlean on/off
- .antiadmin on/off
- .antilink on/off
- .welcome on/off
- .goodbye
- .goodnight
- .song <name/url>
- .play <name/url>
- .gcstory (reply to a message)
- .de / .del / .delete (reply to a message) — delete the replied message
- .settings
- .settings <feature> on/off

## Setup
1. Extract ZIP.
2. Run `npm install`.
3. Run `npm start`.
4. Pair the WhatsApp number. QR or pairing code can be used.
5. After `BOSS X BOT CONNECTED SUCCESSFULLY` appears, send `ping` or `.ping`.

If your hosting service has no terminal input, set:
`PAIRING_NUMBER=919XXXXXXXXX`

## Notes
- Anti-link deletes detected links immediately when enabled, if the bot is a group admin.
- `.group open` opens the group for all members; `.group close` restricts messaging to admins. Bot must be group admin.
- Anti-admin immediately demotes members who are promoted while anti-admin is ON (except the configured owner). Bot must be group admin.
- Anti-delete/anti-clean can only restore messages that were received and cached while the bot was running.
- Anti-bot uses a manually managed JID list; WhatsApp does not expose a universal "bot" flag.


## v1.2.3 Self-Command Fix
This build intentionally processes `fromMe` messages, so the same paired WhatsApp number can use:
- `ping`
- `.ping`
- `menu`
- `.menu`
- `.settings`
- `.settings <feature> on/off`
and the other bot commands.

The bot ignores its own normal reply messages after handling a command, preventing reply loops.


## v1.2.4 Private Mode
- Bot commands are owner-only by default.
- The paired owner number can run `ping`, `.menu`, `.settings`, etc. from its own WhatsApp chat.
- Other numbers' commands are ignored.
- `PRIVATE_MODE=false` can disable the owner-only command gate if desired.
- Group admin commands still require group admin status for non-owner users; the configured owner always has access.

## v1.2.5 startup fix
Fixed a malformed `config.js` line that could cause:
`SyntaxError: Invalid or unexpected token`
Both `config.js` and `index.js` pass Node syntax checks.

## v1.2.6 WhatsApp send/connection fix
The console screenshot showed `SELF COMMAND: ping` followed by Baileys `408 Request Time-out` and a `failed to decrypt message` notice. This means the command reaches the bot, but the WhatsApp session is failing while sending.
- Baileys is pinned to 6.7.23 for this build.
- Text `ping` replies retry once after a 408 timeout.
- Connection/query timeouts are explicitly configured.
- If 408 continues, the existing `auth_info` session should be removed and the number paired again; this refreshes the WhatsApp encryption/session keys.


## v1.2.7 405 / self-command fix
- Updated legacy Baileys from 6.7.23 to 6.7.24.
- Uses `fetchLatestWaWebVersion()` before connecting, so WhatsApp Web's current client revision is used instead of a stale revision.
- The paired number's own messages (`fromMe=true`) are treated as owner commands, so `ping`, `.ping`, `.menu`, and settings work even if `OWNER_NUMBER` was not set correctly.
- For a clean re-pair after repeated 405 failures, stop the bot and remove the old `auth_info` folder on the server before starting again.


## v1.3.1 B marker + channel footer
- Every normal bot command text reply now ends with `🅱️` and the configured WhatsApp Channel URL.
- The Menu/photo caption also includes the B marker and Channel footer.
- Song commands send the B + Channel footer after the audio.
- Channel URL: https://whatsapp.com/channel/0029VbDqHfKKQuJMRHZzZX11

### Custom welcome/goodbye
- `.welcome on/off` — enable/disable automatic welcome messages.
- `.goodbye on/off` — enable/disable automatic goodbye messages.
- `.setwelcome <message>` — set a custom group welcome message. Use `{user}` where the new member mention should appear.
- `.setgoodbye <message>` — set a custom group goodbye message. Use `{user}` where the leaving member mention should appear.
- `.setwelcome default` / `.setgoodbye default` — restore the default messages.


### Anti-link kick
- `.antilink on` deletes non-admin links.
- `.antilinkkick on` additionally removes the sender from the group (bot must be admin).
- `.menu` includes the WhatsApp Channel link once; command replies no longer append the channel link automatically.
\n\n## Channel ID attribution fix
- The configured `CHANNEL_ID` is now applied to text, photo, audio, and other media messages through WhatsApp's newsletter-forward metadata.
- `CHANNEL_NAME` and `CHANNEL_URL` are configurable environment variables.
- Existing channel values are preserved by default:
  - `CHANNEL_ID=120363412006298804@newsletter`
  - `CHANNEL_URL=https://whatsapp.com/channel/0029VbDqHfKKQuJMRHZzZX11`


## v1.3.2 Private Mode + .lol Full Photo
- Private mode is ON by default: private-chat bot commands are owner-only.
- Set `PRIVATE_MODE=false` only if you intentionally want non-owner private commands enabled.
- `.lol` now sends the replied image as a normal/full photo instead of a view-once photo.
- Use: reply to a photo with `.lol`.


## v1.4 Private/Public Mode + Welcome Allowlist + .lol Owner Profile
- `.mode private` — only the configured owner/paired number can use bot commands.
- `.mode public` — normal bot commands can be used by members; admin commands still require group admin/owner.
- `.welcomegroup on` — enables automatic welcome ONLY in the current group.
- `.welcomegroup off` — disables welcome in the current group.
- `.welcomegroup status` — checks whether the current group is selected.
- Welcome events are ignored in every other group.
- `.lol` when replying to a view-once/full photo downloads the image and sends it as a normal/full photo to `OWNER_NUMBER` private chat. It does not repost the photo into the group.
\n\n## v1.5 Anti-Mention + Owner Card\n- `.antimention on/off` (also `.antitag on/off`) — deletes non-admin messages containing @mentions in groups when enabled; bot must be group admin.\n- Normal text command replies now use the `owner.jpg` photo/card style, including ping, settings, security, group, moderation and tag commands.\n- `.menu` no longer sends a separate Channel URL message underneath the menu.\n

## v1.5.1 Delete + View-once destination fix
- `.de` / `.del` / `.delete` deletes the replied/quoted message.
- `.lol` keeps the converted full photo in the same chat only; it does not send the view-once/full photo to the owner.
- Anti-admin uses fresh group metadata and multiple JID forms to demote newly promoted members, while preserving the configured owner and the bot itself.


## v1.5.2 Developer + Single Active Group Lock
- Developer name shown at the top of the Basic/menu section: `Mr bikramhacker`.
- The first group where the owner/paired number uses the bot becomes the active group and is saved in `bot_data/settings.json`.
- The bot ignores messages, commands, moderation actions, welcome/goodbye events and other bot activity in every other group.
- The active group remains locked across restarts until `settings.json` is changed/cleared.


## v1.5.3 Anti-Admin admin detection fix
- Fixed false `bot admin না থাকায়` warnings when the bot is actually a group admin.
- Bot identity matching now checks `id`, `lid`, `phoneNumber`, device-qualified JIDs and configured `OWNER_NUMBER`.
- Anti-admin refreshes group metadata up to 3 times before reporting that the bot is not admin.
- Promotion handling waits 1.8 seconds before reading fresh participant metadata.
