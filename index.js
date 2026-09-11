const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  Browsers,
  fetchLatestWaWebVersion
} = require("@whiskeysockets/baileys");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const yts = require("yt-search");
const ytdl = require("@distube/ytdl-core");

const logger = P({ level: process.env.LOG_LEVEL || "info" });
const DATA_DIR = "./bot_data";
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const OWNER_PHOTO = "./owner.jpg";
const messageStore = new Map();
const MAX_STORED_MESSAGES = 500;

const DEFAULT_SETTINGS = {
  anticall: false,
  antibot: false,
  antidelete: false,
  anticClean: false,
  antiadmin: false,
  antimention: false,
  antilink: false,
  antilinkKick: true,
  welcome: true,
  goodbye: true,
  welcomeMessage: "╭─「 WELCOME 」\n│ 🎉 Welcome {user}\n│ 👑 BOSS X Group\n╰────────────",
  goodbyeMessage: "👋 Goodbye {user}\nTake care!",
  autoGoodNight: true,
  autoGoodbye: true,
  song: true,
  botJids: [],
  // Command access mode: private = owner-only, public = commands can be used by members
  // (admin-only commands still require admin/owner).
  mode: "private",
  // Welcome allowlist: only these group JIDs receive automatic welcome messages.
  welcomeGroups: [],
  // Only the first group where the owner starts/uses the bot is allowed to receive bot activity.
  activeGroup: ""
};

let settings = loadSettings();
if (!settings.mode) {
  settings.mode = config.MODE === "public" ? "public" : "private";
  saveSettings();
}
if (!Array.isArray(settings.welcomeGroups)) {
  settings.welcomeGroups = [];
  saveSettings();
}
if (typeof settings.activeGroup !== "string") {
  settings.activeGroup = "";
  saveSettings();
}
let pairingAsked = false;

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadSettings() {
  ensureData();
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  ensureData();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
function formatGroupMessage(template, participants, groupName = "") {
  const users = Array.from(new Set((participants || []).filter(Boolean)));
  const list = users.map(p => `@${baseNumber(p)}`).join(" ");
  return String(template || "")
    .replace(/\{user\}/gi, list || "everyone")
    .replace(/\{count\}/gi, String(users.length))
    .replace(/\{group\}/gi, groupName || "this group");
}

function cleanCustomMessage(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function saveCustomGroupMessage(key, value) {
  const cleaned = cleanCustomMessage(value);
  if (!cleaned) return { ok: false, error: "empty" };
  if (cleaned.length > 4000) return { ok: false, error: "long" };
  settings[key] = cleaned;
  saveSettings();
  return { ok: true, value: cleaned };
}
function isGroup(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}
function isActiveGroup(jid) {
  return isGroup(jid) && settings.activeGroup === jid;
}

function bindActiveGroup(jid) {
  if (!isGroup(jid)) return false;
  if (!settings.activeGroup) {
    settings.activeGroup = jid;
    saveSettings();
    return true;
  }
  return settings.activeGroup === jid;
}
function baseNumber(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}
function normalizeJid(value) {
  if (!value) return "";
  if (String(value).includes("@")) return String(value);
  const digits = String(value).replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : "";
}
function unwrapMessage(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else break;
  }
  return m || {};
}
function getText(msg) {
  const m = unwrapMessage(msg?.message);
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    "";
}
function getContextInfo(msg) {
  const m = unwrapMessage(msg?.message);
  return m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.buttonsResponseMessage?.contextInfo ||
    m.listResponseMessage?.contextInfo ||
    {};
}
function rememberMessage(msg) {
  if (!msg?.key?.id || msg.key.fromMe || !msg.message) return;
  messageStore.set(msg.key.id, msg);
  while (messageStore.size > MAX_STORED_MESSAGES) {
    messageStore.delete(messageStore.keys().next().value);
  }
}

function participantMatchesJid(participant, who) {
  if (!participant || !who) return false;
  const target = String(who);
  const targetBase = baseNumber(target);
  return [participant.id, participant.lid, participant.phoneNumber]
    .filter(Boolean)
    .some(value => String(value) === target || baseNumber(value) === targetBase);
}

async function getGroupMetadataSafe(sock, jid) {
  try { return await sock.groupMetadata(jid); } catch { return null; }
}

async function getGroupParticipant(sock, jid, who) {
  if (!isGroup(jid) || !who) return null;
  const metadata = await getGroupMetadataSafe(sock, jid);
  if (!metadata) return null;
  return (metadata.participants || []).find(p => participantMatchesJid(p, who)) || null;
}

function participantIsAdmin(participant) {
  return Boolean(participant?.admin === "admin" || participant?.admin === "superadmin" || participant?.isAdmin || participant?.isSuperAdmin);
}

async function getGroupAdmin(sock, jid, sender, senderPn) {
  const metadata = await getGroupMetadataSafe(sock, jid);
  if (!metadata) return false;
  const candidates = [sender, senderPn].filter(Boolean).map(String);
  const participant = (metadata.participants || []).find(p => candidates.some(c => participantMatchesJid(p, c)));
  return participantIsAdmin(participant);
}

async function getBotParticipant(sock, jid) {
  if (!isGroup(jid)) return null;
  try {
    const metadata = await sock.groupMetadata(jid);
    if (!metadata) return null;

    // WhatsApp/Baileys can expose the same account as id, lid, phoneNumber,
    // or a device-qualified JID. Match all known forms, including OWNER_NUMBER
    // which is normally the paired bot number in this project.
    const botCandidates = new Set([
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
      sock.user?.jid,
      config.OWNER_NUMBER,
      normalizeJid(config.OWNER_NUMBER)
    ].filter(Boolean).map(String));

    const botNumbers = new Set();
    for (const c of botCandidates) {
      const n = baseNumber(c);
      if (/^\d+$/.test(n)) botNumbers.add(n);
    }

    for (const participant of (metadata.participants || [])) {
      const values = [
        participant?.id,
        participant?.lid,
        participant?.phoneNumber,
        participant?.jid
      ].filter(Boolean).map(String);

      if (values.some(v => botCandidates.has(v) || botNumbers.has(baseNumber(v)))) {
        return participant;
      }
    }
    return null;
  } catch (err) {
    logger.error({ err, jid }, "bot participant lookup failed");
    return null;
  }
}

async function isBotAdmin(sock, jid) {
  // Refresh group metadata a few times because a promote/demotion event can
  // arrive before the local metadata cache reflects the bot's current role.
  for (let attempt = 0; attempt < 3; attempt++) {
    const participant = await getBotParticipant(sock, jid);
    if (participantIsAdmin(participant)) return true;
    if (attempt < 2) await new Promise(r => setTimeout(r, 700));
  }
  return false;
}

async function resolveParticipantJid(sock, jid, who) {
  const p = await getGroupParticipant(sock, jid, who);
  // Prefer the participant id currently advertised by groupMetadata.
  // Newer WhatsApp groups can expose LID + phoneNumber together, so keep
  // both as fallbacks for hosts/Baileys versions that expect one or the other.
  return p?.id || p?.phoneNumber || p?.lid || who;
}

async function removeParticipantRobust(sock, jid, who) {
  const p = await getGroupParticipant(sock, jid, who);
  const candidates = Array.from(new Set([p?.id, p?.phoneNumber, p?.lid, who].filter(Boolean).map(String)));
  let lastError = null;
  for (const target of candidates) {
    try {
      const result = await sock.groupParticipantsUpdate(jid, [target], "remove");
      const ok = !Array.isArray(result) || result.some(r => ["200", "207", 200, 207].includes(r?.status));
      if (ok) return { ok: true, target, result };
      lastError = new Error(String(result?.[0]?.status || "WhatsApp rejected removal"));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Participant removal failed");
}

function containsLink(text) {
  const value = String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[()[\]{}<>]/g, " ");
  // Covers normal URLs, WhatsApp/Telegram/Discord invites, social links,
  // shorteners, and bare domains such as google.com without http://.
  return /(?:https?:\/\/|ftp:\/\/|www\.|(?:chat\.)?whatsapp\.com(?:\/|\b)|wa\.me(?:\/|\b)|whatsapp\.com(?:\/|\b)|t\.me(?:\/|\b)|telegram\.me(?:\/|\b)|discord(?:\.gg|\.com\/invite)(?:\/|\b)|instagram\.com(?:\/|\b)|facebook\.com(?:\/|\b)|m\.facebook\.com(?:\/|\b)|youtube\.com(?:\/|\b)|youtu\.be(?:\/|\b)|x\.com(?:\/|\b)|twitter\.com(?:\/|\b)|bit\.ly(?:\/|\b)|tinyurl\.com(?:\/|\b)|(?:[a-z0-9-]+\.)+(?:com|net|org|info|biz|xyz|online|site|app|dev|io|co|in|me|ly|gg|tv|live)(?:\/[^\s]*)?)/i.test(value);
}

function getQuotedMessage(msg) {
  const ctx = getContextInfo(msg);
  if (!ctx?.quotedMessage) return null;
  return {
    key: {
      remoteJid: msg.key.remoteJid,
      id: ctx.stanzaId,
      participant: ctx.participant,
      fromMe: false
    },
    message: ctx.quotedMessage
  };
}

async function sendFullImage(sock, jid, quoted) {
  if (!quoted?.message) throw new Error("কোনো quoted photo পাওয়া যায়নি।");
  const qm = unwrapMessage(quoted.message);
  if (!qm.imageMessage) throw new Error(".lol শুধু photo/image message-এ reply করে ব্যবহার করুন।");
  const buffer = await downloadMediaMessage(
    quoted, "buffer", {}, { logger: P({ level: "silent" }) }
  );
  return await sock.sendMessage(jid, {
    image: buffer,
    caption: qm.imageMessage.caption || "",
  });
}

function isOwner(sender) {
  return baseNumber(sender) === baseNumber(normalizeJid(config.OWNER_NUMBER));
}

async function requireAdmin(sock, jid, sender, senderPn) {
  // Owner can always use admin commands, including in the owner's private/self chat.
  if (isOwner(sender) || isOwner(senderPn)) return true;
  if (!isGroup(jid)) return false;
  return getGroupAdmin(sock, jid, sender, senderPn);
}

function getChannelContextInfo(existing = {}) {
  return {
    ...existing,
    isForwarded: true,
    forwardingScore: Math.max(Number(existing.forwardingScore || 0), 1),
    forwardedNewsletterMessageInfo: {
      ...(existing.forwardedNewsletterMessageInfo || {}),
      newsletterJid: config.CHANNEL_ID || "120363412006298804@newsletter",
      newsletterName: config.CHANNEL_NAME || config.OWNER_NAME || "BOSS X",
      serverMessageId: Number(existing.forwardedNewsletterMessageInfo?.serverMessageId || 1),
      contentType: existing.forwardedNewsletterMessageInfo?.contentType || "UPDATE"
    }
  };
}

async function sendBotReply(sock, jid, text, options = {}) {
  // Owner photo/card is disabled for all command replies.
  const result = await sendTextSafe(sock, jid, text, options);
  try {
    if (result?.key) {
      await sock.sendMessage(jid, {
        react: { text: "🅱️", key: result.key }
      });
    }
  } catch (e) {
    console.warn("⚠️ Could not add B reaction:", e.message || e);
  }
  return result;
}

async function sendTextSafe(sock, jid, text, options = {}) {
  // Attach the configured WhatsApp Channel as forwarded newsletter metadata.
  // Baileys uses the correct field name: forwardedNewsletterMessageInfo.
  const contextInfo = getChannelContextInfo(options.contextInfo || {});
  const messageOptions = { text, ...options, contextInfo };
  try {
    return await sock.sendMessage(jid, messageOptions);
  } catch (e) {
    const code = e?.output?.statusCode || e?.statusCode;
    if (code === 408 || /timed out|request time-out/i.test(e?.message || "")) {
      console.warn("⚠️ WhatsApp send timed out (408). Retrying once...");
      await new Promise(r => setTimeout(r, 3000));
      return await sock.sendMessage(jid, messageOptions);
    }
    throw e;
  }
}

async function sendOwnerPhoto(sock, jid, caption, options = {}) {
  // Owner photo/card is intentionally disabled. Keep only the owner name/text.
  return await sendTextSafe(sock, jid, caption, options);
}

async function sendOwnerPhotoReply(sock, jid, caption, options = {}) {
  // Owner photo/card is intentionally disabled; send the owner name/text only.
  const result = await sendTextSafe(sock, jid, caption, options);
  try {
    if (result?.key) {
      await sock.sendMessage(jid, {
        react: { text: "🅱️", key: result.key }
      });
    }
  } catch (e) {
    console.warn("⚠️ Could not add B reaction:", e.message || e);
  }
  return result;
}

async function deleteMessage(sock, jid, key) {
  if (await isBotAdmin(sock, jid)) {
    await sock.sendMessage(jid, { delete: key });
    return true;
  }
  return false;
}

async function restoreDeleted(sock, update, label) {
  const protocol = update?.update?.message?.protocolMessage;
  if (!protocol || protocol.type !== 0) return;
  const originalId = protocol.key?.id;
  const original = messageStore.get(originalId);
  if (!original) return;
  const jid = update?.key?.remoteJid || original.key.remoteJid;
  try {
    const text = getText(original);
    if (text) {
      await sock.sendMessage(jid, { text: `${label}\n\n${text}` });
      return;
    }
    const m = unwrapMessage(original.message);
    if (m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage) {
      const buffer = await downloadMediaMessage(
        original, "buffer", {}, { logger: P({ level: "silent" }) }
      );
      if (m.imageMessage) await sock.sendMessage(jid, { image: buffer, caption: `${label}\n${m.imageMessage.caption || ""}` });
      else if (m.videoMessage) await sock.sendMessage(jid, { video: buffer, caption: `${label}\n${m.videoMessage.caption || ""}` });
      else if (m.audioMessage) await sock.sendMessage(jid, { audio: buffer, mimetype: m.audioMessage.mimetype || "audio/mpeg" });
      else await sock.sendMessage(jid, { document: buffer, mimetype: m.documentMessage.mimetype || "application/octet-stream", fileName: m.documentMessage.fileName || "deleted-file" });
    }
  } catch (e) {
    logger.error({ err: e }, "restore deleted message failed");
  }
}

async function sendOwnerCommandCard(sock, jid, title, extra = "") {
  const lines = [title, `👑 ${config.OWNER_NAME}`];
  if (extra) lines.push(extra);
  return await sendOwnerPhotoReply(sock, jid, lines.join("\n"));
}

async function sendSong(sock, jid, query) {
  if (!query) throw new Error("Usage: .song <song name or YouTube URL>");
  let url = query.trim();
  let title = "Song";

  if (!ytdl.validateURL(url)) {
    const result = await yts(query);
    const video = result?.videos?.[0];
    if (!video) throw new Error("Song পাওয়া যায়নি।");
    url = video.url;
    title = video.title;
  } else {
    const result = await yts({ videoId: ytdl.getVideoID(url) });
    title = result?.title || title;
  }

  const stream = ytdl(url, {
    filter: "audioonly",
    quality: "highestaudio",
    highWaterMark: 1 << 25
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error("Song file is larger than 16 MB.");
    chunks.push(chunk);
  }
  await sock.sendMessage(jid, {
    audio: Buffer.concat(chunks),
    mimetype: "audio/mpeg",
    fileName: `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.mp3`,
    contextInfo: getChannelContextInfo()
  });
}

function settingsText() {
  const on = v => v ? "ON ✅" : "OFF ❌";
  const mode = settings.mode === "public" ? "PUBLIC 🌐" : "PRIVATE 🔐";
  const welcomeGroups = Array.isArray(settings.welcomeGroups) ? settings.welcomeGroups.length : 0;
  return `⚙️ BOSS X SETTINGS
📌 Mode: ${mode}
👨‍💻 Developer: Mr bikramhacker
🔒 Active group: ${settings.activeGroup ? "LOCKED ✅" : "NOT SET ❌"}
👋 Welcome groups: ${welcomeGroups} selected

📞 Anti-call: ${on(settings.anticall)}
🤖 Anti-bot: ${on(settings.antibot)}
♻️ Anti-delete: ${on(settings.antidelete)}
🧹 Anti-clean: ${on(settings.anticClean)}
🛡️ Anti-admin: ${on(settings.antiadmin)}
🏷️ Anti-mention: ${on(settings.antimention)}
🔗 Anti-link: ${on(settings.antilink)}
🥾 Anti-link kick: ${on(settings.antilinkKick)}
👋 Welcome: ${on(settings.welcome)}
🚪 Goodbye: ${on(settings.goodbye)}
🌙 Good night auto: ${on(settings.autoGoodNight)}
🎵 Song: ${on(settings.song)}

Use: .settings <feature> on/off`;
}
function changeSetting(name, value) {
  const map = {
    anticall:"anticall", antibot:"antibot", antidelete:"antidelete",
    anticlean:"anticClean", "anti-clean":"anticClean",
    antiadmin:"antiadmin", "anti-admin":"antiadmin",
    antimention:"antimention", "anti-mention":"antimention", antitag:"antimention", "anti-tag":"antimention",
    antilink:"antilink", "anti-link":"antilink",
    antilinkkick:"antilinkKick", "anti-link-kick":"antilinkKick", "antilink-kick":"antilinkKick",
    welcome:"welcome", goodbye:"goodbye", goodnight:"autoGoodNight",
    autogoodnight:"autoGoodNight", autogoodbye:"autoGoodbye", song:"song"
  };
  const key = map[name];
  if (!key || !["on","off"].includes(value)) return null;
  settings[key] = value === "on";
  saveSettings();
  return key;
}

function getBotMode() {
  return settings.mode === "public" ? "public" : "private";
}
function setBotMode(mode) {
  settings.mode = mode === "public" ? "public" : "private";
  saveSettings();
  return settings.mode;
}
function isWelcomeGroup(jid) {
  return isGroup(jid) && Array.isArray(settings.welcomeGroups) && settings.welcomeGroups.includes(jid);
}
function setWelcomeGroup(jid, enabled) {
  if (!isGroup(jid)) return false;
  if (!Array.isArray(settings.welcomeGroups)) settings.welcomeGroups = [];
  if (enabled) {
    if (!settings.welcomeGroups.includes(jid)) settings.welcomeGroups.push(jid);
  } else {
    settings.welcomeGroups = settings.welcomeGroups.filter(x => x !== jid);
  }
  saveSettings();
  return true;
}

const adminCommands = new Set([
  "anticall","antibot","antidelete","anticlean","antiadmin","antimention","antitag","anti-link","antilink","antilinkkick",
  "botadd","botdel","de","del","delete","kick","kickall","htag","tagall","totag","gcstory","story","settings","welcome","goodbye","setwelcome","setgoodbye","group","open","close","link","grouplink","linkreset","resetlink","mode","welcomegroup","welcomeonly"
]);

async function handleMessage(sock, msg) {
  if (!msg?.message) return;

  // IMPORTANT: Commands from the same WhatsApp number (fromMe=true)
  // are intentionally processed. This allows self-command usage such as
  // ping, .menu and .settings from the paired bot number.
  const isSelfMessage = Boolean(msg.key?.fromMe);

  const jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;

  // GROUP LOCK: only the group where the owner first starts/uses the bot is active.
  // All messages, commands, moderation and automatic replies in other groups are ignored.
  if (isGroup(jid)) {
    if (!settings.activeGroup) {
      if (Boolean(msg.key?.fromMe) || isOwner(msg.key?.participant) || isOwner(msg.key?.participantPn)) {
        bindActiveGroup(jid);
      } else {
        return;
      }
    }
    if (!isActiveGroup(jid)) return;
  }
  // In LID-addressed groups, participant can be a @lid JID while
  // participantPn contains the normal phone-number JID.
  const sender = msg.key.participant || msg.key.participantPn || jid;
  const senderPn = msg.key.participantPn || msg.key.participant || jid;
  const text = getText(msg).trim();
  if (!text) return;

  // Cache only incoming messages for anti-delete; self messages are commands/replies.
  if (!isSelfMessage) rememberMessage(msg);

  // ANTI-MENTION: delete messages that contain @mentions in groups.
  // Admins and owner are exempt. Bot must be a group admin to delete.
  if (!isSelfMessage && settings.antimention && isGroup(jid)) {
    try {
      const ctx = getContextInfo(msg);
      const mentioned = Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid.filter(Boolean) : [];
      const hasGroupMention = Boolean(
        mentioned.length ||
        unwrapMessage(msg.message)?.groupStatusMentionMessage ||
        unwrapMessage(msg.message)?.groupMentionedMessage
      );
      if (hasGroupMention) {
        const senderIsAdmin = await requireAdmin(sock, jid, sender, senderPn);
        if (!senderIsAdmin) {
          if (!(await isBotAdmin(sock, jid))) {
            await sock.sendMessage(jid, { text: "⚠️ ANTI-MENTION ON আছে, কিন্তু BOSS X admin না থাকায় mention message delete করা যাচ্ছে না।" });
            return;
          }
          const deleted = await deleteMessage(sock, jid, msg.key);
          if (deleted) {
            await sendOwnerPhotoReply(sock, jid, `🚫 ANTI-MENTION\n@${baseNumber(sender)}-এর mention message delete করা হয়েছে।`, { mentions: [sender] });
          }
          return;
        }
      }
    } catch (e) {
      logger.error({ err: e, sender, senderPn }, "anti-mention handler failed");
    }
  }

  // ANTI-LINK: run before command handling so a link is moderated immediately.
  // Admins and owner are exempt. Bot MUST be admin to delete/kick.
  if (!isSelfMessage && settings.antilink && isGroup(jid) && containsLink(text)) {
    try {
      const senderIsAdmin = await requireAdmin(sock, jid, sender, senderPn);
      if (!senderIsAdmin) {
        if (!(await isBotAdmin(sock, jid))) {
          await new Promise(r => setTimeout(r, 300));
          if (!(await isBotAdmin(sock, jid))) {
            await sock.sendMessage(jid, {
              text: "⚠️ ANTI-LINK ON আছে, কিন্তু BOSS X-এর admin status পাওয়া যাচ্ছে না। Group info refresh করে আবার চেষ্টা করুন।"
            });
            return;
          }
        }

        const deleted = await deleteMessage(sock, jid, msg.key);
        let kicked = false;
        if (settings.antilinkKick && !isOwner(sender) && !isOwner(senderPn)) {
          try {
            const removal = await removeParticipantRobust(sock, jid, sender);
            kicked = Boolean(removal?.ok);
          } catch (kickErr) {
            logger.error({ err: kickErr, sender, senderPn }, "anti-link kick failed");
          }
        }

        // Only send moderation feedback after the original message has been deleted.
        await sock.sendMessage(jid, {
          text: kicked
            ? `🚫 ANTI-LINK\n@${baseNumber(sender)}-এর link delete করে তাকে group থেকে KICK করা হয়েছে।`
            : deleted
              ? `🚫 ANTI-LINK\n@${baseNumber(sender)}-এর link message delete করা হয়েছে।`
              : `🚫 ANTI-LINK\n@${baseNumber(sender)} link পাঠাতে পারবে না।`,
          mentions: [sender]
        });
      }
    } catch (e) {
      logger.error({ err: e, sender, senderPn }, "anti-link handler failed");
    }
    return;
  }

  // Managed anti-bot list (never apply to the paired number itself)
  if (!isSelfMessage && settings.antibot && settings.botJids.some(j => baseNumber(j) === baseNumber(sender))) {
    try { await deleteMessage(sock, jid, msg.key); } catch {}
    return;
  }

  // Accept both .ping and ping.
  if (isSelfMessage) {
    console.log(`🤖 SELF COMMAND: ${text}`);
  } else {
    console.log(`📩 MESSAGE: ${text}`);
  }

  // COMMAND MODE:
  // PRIVATE = only the configured owner/paired number may run commands.
  // PUBLIC = normal commands are available to everyone; admin commands still
  // require group admin/owner, and self-messages always remain allowed.
  const raw = text;
  const mode = getBotMode();
  if (mode === "private" && !isOwner(sender) && !isOwner(senderPn) && !isSelfMessage) {
    return;
  }
  const commandText = raw.startsWith(config.PREFIX)
    ? raw.slice(config.PREFIX.length).trim()
    : raw.trim();
  const commandMatch = commandText.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const command = (commandMatch?.[1] || "").toLowerCase();
  const argsRaw = commandMatch?.[2] || "";
  const args = argsRaw ? argsRaw.trim().split(/\s+/) : [];
  const isAdmin = adminCommands.has(command);

  if (isAdmin && !isSelfMessage && !(await requireAdmin(sock, jid, sender, senderPn))) {
    await sock.sendMessage(jid, { text: "❌ এই command শুধু group admin/owner ব্যবহার করতে পারবেন।" });
    return;
  }

  try {
    if (command === "ping") {
      await sendOwnerPhotoReply(sock, jid, `🏓 PONG! ⚡Sp099
👑 ${config.OWNER_NAME}`);
    } else if (command === "menu" || command === "help") {
      await sendOwnerPhotoReply(sock, jid,
`╭─「 BOSS X BOT 」╮
│ 👨‍💻 Developer: Mr bikramhacker
│ 👑 ${config.OWNER_NAME}
│
│ 🧰 BASIC
│ 🏓 .ping
│ 📋 .menu
│ 👑 .owner
│
│ 🛡️ SECURITY
│ 📞 .anticall on/off
│ 🤖 .antibot on/off
│ ♻️ .antidelete on/off
│ 🧹 .anticlean on/off
│ 👮 .antiadmin on/off
│ 🏷️ .antimention on/off
│ 🔗 .antilink on/off
│ 🥾 .antilinkkick on/off
│ 🤖 .botadd <number>
│ 🗑️ .botdel <number>
│ 👢 .kick @user / reply .kick
│ 💥 .kickall
│ 📢 .htag
│ 🏷️ .tagall
│ 🏷️ .totag (reply)
│ 👁️ .lol (reply to photo)
│ 🗑️ .de (reply to message)
│
│ 👥 GROUP
│ 👋 .welcome on/off
│ 🚪 .goodbye on/off
│ ✍️ .setwelcome <message>
│ ✍️ .setgoodbye <message>
│ 🔓 .group open
│ 🔒 .group close
│ 🔗 .link
│ ♻️ .linkreset
│ 🌙 .goodnight
│
│ 🎵 MUSIC
│ 🎧 .song <name/url>
│ ▶️ .play <name/url>
│
│ 📚 OTHER
│ 📖 .gcstory / .story (reply/quote)
│ ⚙️ .settings
│ ⚙️ .settings <feature> on/off
│ 🔐 .mode private/public
│ 👋 .welcomegroup on/off
╰────────────`, {
        templateButtons: config.CHANNEL_URL ? [{
          index: 1,
          urlButton: { displayText: "📢 View channel", url: config.CHANNEL_URL }
        }] : []
      });

    } else if (command === "owner") {
      await sendOwnerPhotoReply(sock, jid, `👑 Owner: ${config.OWNER_NAME}\n📱 ${config.OWNER_NUMBER}`);
    } else if (command === "channel") {
      await sendOwnerPhotoReply(sock, jid, `📢 CHANNEL
👑 ${config.OWNER_NAME}

নিচের View channel button-এ চাপুন।`, {
        templateButtons: config.CHANNEL_URL ? [{
          index: 1,
          urlButton: { displayText: "📢 View channel", url: config.CHANNEL_URL }
        }] : []
      });
    } else if (command === "mode") {
      const requested = args[0]?.toLowerCase();
      if (!["private", "public"].includes(requested)) {
        await sendBotReply(sock, jid, `🔐 BOT MODE: ${getBotMode().toUpperCase()}\n\nUsage:\n.mode private\n.mode public`);
      } else {
        const selected = setBotMode(requested);
        await sendBotReply(sock, jid, selected === "private"
          ? "🔐 PRIVATE MODE ON\nশুধু Owner/paired number bot commands ব্যবহার করতে পারবে।"
          : "🌐 PUBLIC MODE ON\nসাধারণ bot commands সবাই ব্যবহার করতে পারবে। Admin commands এখনও group admin/owner-এর জন্য।");
      }
    } else if (command === "welcomegroup" || command === "welcomeonly") {
      if (!isGroup(jid)) {
        await sendBotReply(sock, jid, "❌ এই command শুধু group-এ ব্যবহার করুন।");
      } else {
        const value = args[0]?.toLowerCase();
        if (!["on", "off", "status"].includes(value)) {
          await sendBotReply(sock, jid, "Usage:\n.welcomegroup on — এই group-এ welcome চালু\n.welcomegroup off — এই group-এ welcome বন্ধ\n.welcomegroup status");
        } else if (value === "status") {
          await sendBotReply(sock, jid, isWelcomeGroup(jid)
            ? "👋 Welcome এই group-এ ACTIVE ✅"
            : "👋 Welcome এই group-এ ACTIVE নয় ❌");
        } else {
          setWelcomeGroup(jid, value === "on");
          await sendBotReply(sock, jid, value === "on"
            ? "👋 Welcome এই group-এ চালু হয়েছে ✅\nঅন্য group-এ welcome হবে না।"
            : "👋 Welcome এই group-এ বন্ধ হয়েছে ❌");
        }
      }
    } else if (command === "settings") {
      if (!args.length) await sendBotReply(sock, jid, settingsText());
      else {
        const changed = changeSetting(args[0].toLowerCase(), args[1]?.toLowerCase());
        if (!changed) await sendBotReply(sock, jid, "Usage: .settings <feature> on/off");
        else await sendBotReply(sock, jid, `⚙️ ${changed} ${settings[changed] ? "ON ✅" : "OFF ❌"}`);
      }
    } else if (["anticall","antibot","antidelete","anticlean","antiadmin","antimention","antitag","antilink","antilinkkick"].includes(command) && !(command === "antilink" && args[0]?.toLowerCase() === "kick")) {
      const value = args[0]?.toLowerCase();
      if (!["on", "off"].includes(value)) {
        await sendBotReply(sock, jid, `Usage: .${command} on/off`);
      } else if (command === "antilink") {
        // .antilink on is the full protection mode requested by the owner:
        // delete the link immediately AND kick the sender.
        settings.antilink = value === "on";
        settings.antilinkKick = value === "on";
        saveSettings();
        await sendBotReply(sock, jid, `🔗 ANTI-LINK ${settings.antilink ? "ON ✅ (DELETE + KICK)" : "OFF ❌"}`);
      } else {
        const changed = changeSetting(command, value);
        if (!changed) await sendBotReply(sock, jid, `Usage: .${command} on/off`);
        else await sendBotReply(sock, jid, `⚙️ ${command.toUpperCase()} ${settings[changed] ? "ON ✅" : "OFF ❌"}`);
      }
    } else if (command === "antilink" && args[0]?.toLowerCase() === "kick") {
      const value = args[1]?.toLowerCase();
      const changed = changeSetting("antilinkkick", value);
      if (!changed) await sendBotReply(sock, jid, "Usage: .antilink kick on/off");
      else await sendBotReply(sock, jid, `⚙️ ANTI-LINK KICK ${settings[changed] ? "ON ✅" : "OFF ❌"}`);
    } else if (command === "botadd") {
      const botJid = normalizeJid(args[0]);
      if (!botJid) await sendBotReply(sock, jid, "Usage: .botadd 919XXXXXXXXX");
      else {
        if (!settings.botJids.some(j => baseNumber(j) === baseNumber(botJid))) settings.botJids.push(botJid);
        saveSettings();
        await sendBotReply(sock, jid, `🤖 Added: ${botJid}`);
      }
    } else if (command === "botdel") {
      const botJid = normalizeJid(args[0]);
      settings.botJids = settings.botJids.filter(j => baseNumber(j) !== baseNumber(botJid));
      saveSettings();
      await sendBotReply(sock, jid, `🤖 Removed: ${botJid}`);
    } else if (["de", "del", "delete"].includes(command)) {
      const quoted = getQuotedMessage(msg);
      if (!quoted?.key?.id) {
        await sendBotReply(sock, jid, "🗑️ যে message delete করতে চান, সেটাতে reply করে .de দিন।");
      } else {
        try {
          // Delete the replied/quoted message. For group chats this requires
          // the bot to be an admin when deleting another member's message.
          await sock.sendMessage(jid, { delete: quoted.key });
          await sendBotReply(sock, jid, "🗑️ Message deleted successfully ✅");
        } catch (e) {
          await sendBotReply(sock, jid, `❌ Message delete করা যায়নি: ${e.message || "Bot-কে admin করুন বা message-এ reply করে চেষ্টা করুন।"}`);
        }
      }
    } else if (command === "lol") {
      const quoted = getQuotedMessage(msg);
      if (!quoted) {
        await sendBotReply(sock, jid, "🖼️ আগে একটি view-once/photo-তে reply করে .lol দিন।");
      } else {
        try {
          // .lol converts a quoted view-once image into a normal/full image
          // and sends it back only to the same chat where .lol was used; never to OWNER_NUMBER.
          const qm = unwrapMessage(quoted.message);
          if (!qm.imageMessage) throw new Error(".lol শুধু photo/image message-এ কাজ করে।");
          const buffer = await downloadMediaMessage(
            quoted, "buffer", {}, { logger: P({ level: "silent" }) }
          );
          await sock.sendMessage(jid, {
            image: buffer,
            caption: qm.imageMessage.caption || "🖼️ Full photo • BOSS X .lol"
          });
          await sendBotReply(sock, jid, "🖼️ View-once photo → Full photo করা হয়েছে এবং এই chat-এই পাঠানো হয়েছে ✅");
        } catch (e) {
          await sendBotReply(sock, jid, `❌ .lol failed: ${e.message || "photo পাওয়া যায়নি"}`);
        }
      }
    } else if (command === "kick") {
      if (!isGroup(jid)) {
        await sendBotReply(sock, jid, "❌ এই command শুধু group-এ ব্যবহার করা যাবে।");
      } else if (!(await isBotAdmin(sock, jid))) {
        await sendBotReply(sock, jid, "❌ Kick করতে bot-কে admin করতে হবে।");
      } else {
        const ctx = getContextInfo(msg);
        const quoted = ctx?.participant || null;
        const mentioned = Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid[0] : null;
        const rawTarget = mentioned || quoted || args[0];
        const target = normalizeJid(rawTarget);
        const participant = target ? await getGroupParticipant(sock, jid, target) : null;
        const targetJid = participant?.id || participant?.phoneNumber || participant?.lid || target;
        if (!targetJid) {
          await sendBotReply(sock, jid, "Usage: .kick @user অথবা কারও message-এ reply করে .kick");
        } else if (participantIsAdmin(participant)) {
          await sendBotReply(sock, jid, "❌ Admin-কে kick করা যাবে না।");
        } else if (isOwner(targetJid) || isOwner(participant?.phoneNumber) || baseNumber(targetJid) === baseNumber(sock.user?.id)) {
          await sendBotReply(sock, jid, "❌ Owner/bot-কে kick করা যাবে না।");
        } else {
          try {
            const removal = await removeParticipantRobust(sock, jid, targetJid);
            const mentionJid = removal.target || targetJid;
            await sendBotReply(sock, jid, `🥾 @${baseNumber(mentionJid)} group থেকে kick করা হয়েছে।`, { mentions: [mentionJid] });
          } catch (e) {
            logger.error({ err: e, jid, rawTarget, targetJid }, "manual kick failed");
            await sendBotReply(sock, jid, `❌ Kick করা যায়নি: ${e.message || "WhatsApp request rejected"}`);
          }
        }
      }
    } else if (["htag", "tagall", "totag"].includes(command)) {
      if (!isGroup(jid)) {
        await sendBotReply(sock, jid, "❌ এই command শুধু group-এ ব্যবহার করা যাবে।");
      } else {
        const metadata = await sock.groupMetadata(jid);
        const participants = (metadata.participants || []).map(p => p.id).filter(Boolean);
        if (!participants.length) return;
        const mentions = participants;
        let body = "📢 TAG ALL\n\n" + mentions.map(p => `@${baseNumber(p)}`).join(" ");
        if (command === "htag") body = "🔔 H-TAG\n\n" + mentions.map(p => `@${baseNumber(p)}`).join(" ");
        if (command === "totag") {
          const ctx = getContextInfo(msg);
          if (!ctx?.quotedMessage) {
            await sendBotReply(sock, jid, "❌ আগে কোনো message reply/quote করে .totag দিন।");
            return;
          }
          const quoted = { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: ctx.quotedMessage };
          const quotedText = getText(quoted);
          body = (quotedText ? `💬 ${quotedText}\n\n` : "💬 Message\n\n") + mentions.map(p => `@${baseNumber(p)}`).join(" ");
          await sendBotReply(sock, jid, body, { mentions });
          return;
        }
        await sendBotReply(sock, jid, body, { mentions });
      }
    } else if (command === "kickall") {
      if (!isGroup(jid)) {
        await sendBotReply(sock, jid, "❌ এই command শুধু group-এ ব্যবহার করা যাবে।");
      } else if (!(await isBotAdmin(sock, jid))) {
        await sendBotReply(sock, jid, "❌ Kickall করতে bot-কে admin করতে হবে।");
      } else {
        try {
          const metadata = await sock.groupMetadata(jid);
          const targets = metadata.participants
            .filter(p => !p.admin && baseNumber(p.id) !== baseNumber(sock.user?.id) && !isOwner(p.id))
            .map(p => p.id);
          if (!targets.length) {
            await sendBotReply(sock, jid, "ℹ️ Kick করার মতো কোনো non-admin member নেই।");
          } else {
            // Send the whole target list in one participant-update request so Kickall
            // starts immediately instead of waiting 5 members at a time.
            let result;
            try {
              result = await sock.groupParticipantsUpdate(jid, targets, "remove");
            } catch (bulkErr) {
              // If WhatsApp/Baileys rejects an oversized bulk request, fall back to
              // small concurrent batches rather than stopping the whole command.
              logger.warn({ err: bulkErr, jid, count: targets.length }, "bulk kickall failed; falling back to concurrent batches");
              const batches = [];
              for (let i = 0; i < targets.length; i += 5) batches.push(targets.slice(i, i + 5));
              result = (await Promise.allSettled(
                batches.map(batch => sock.groupParticipantsUpdate(jid, batch, "remove"))
              )).flatMap(r => r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []);
            }
            const kicked = Array.isArray(result)
              ? result.filter(r => ["200", "207", 200, 207].includes(r?.status)).length
              : targets.length;
            await sendBotReply(sock, jid, `🥾 KICKALL COMPLETE ⚡
👤 ${kicked} জন member remove হয়েছে/হওয়ার সফল response এসেছে।
📋 মোট target: ${targets.length}`);
          }
        } catch (e) {
          await sendBotReply(sock, jid, `❌ Kickall failed: ${e.message || "unknown error"}`);
        }
      }
    } else if (command === "linkreset" || command === "resetlink") {
      if (!isGroup(jid)) {
        await sendBotReply(sock, jid, "❌ এই command শুধু group-এ ব্যবহার করা যাবে।");
      } else if (!(await isBotAdmin(sock, jid))) {
        await sendBotReply(sock, jid, "❌ Link reset করতে bot-কে admin করতে হবে।");
      } else {
        try {
          await sock.groupRevokeInvite(jid);
          const code = await sock.groupInviteCode(jid);
          await sendBotReply(sock, jid, `♻️ GROUP LINK RESET
নতুন link:
https://chat.whatsapp.com/${code}`);
        } catch (e) {
          await sendBotReply(sock, jid, `❌ Group link reset করা যায়নি: ${e.message || "unknown error"}`);
        }
      }
    } else if (command === "link" || command === "grouplink") {
      if (!isGroup(jid)) {
        await sendBotReply(sock, jid, "❌ এই command শুধু group-এ ব্যবহার করা যাবে।");
      } else if (!(await isBotAdmin(sock, jid))) {
        await sendBotReply(sock, jid, "❌ Group link দিতে bot-কে admin করতে হবে।");
      } else {
        try {
          const code = await sock.groupInviteCode(jid);
          if (!code) throw new Error("Invite code পাওয়া যায়নি।");
          await sendBotReply(sock, jid, `🔗 GROUP LINK\nhttps://chat.whatsapp.com/${code}`);
        } catch (e) {
          await sendBotReply(sock, jid, `❌ Group link পাওয়া যায়নি: ${e.message || "unknown error"}`);
        }
      }
    } else if (command === "group" || command === "open" || command === "close") {
      if (!isGroup(jid)) {
        await sendBotReply(sock, jid, "❌ এই command শুধু group-এ ব্যবহার করা যাবে।");
      } else {
        let action = command;
        if (command === "group") action = args[0]?.toLowerCase();
        if (!["open", "close"].includes(action)) {
          await sendBotReply(sock, jid, "Usage: .group open\n       .group close");
        } else if (!(await isBotAdmin(sock, jid))) {
          await sendBotReply(sock, jid, "❌ Group open/close করতে bot-কে admin করতে হবে।");
        } else {
          await sock.groupSettingUpdate(jid, action === "open" ? "not_announcement" : "announcement");
          await sendOwnerCommandCard(
            sock,
            jid,
            action === "open"
              ? "🔓 GROUP OPEN"
              : "🔒 GROUP CLOSE",
            action === "open"
              ? "সবাই এখন message পাঠাতে পারবে।"
              : "এখন শুধু admins message পাঠাতে পারবে।"
          );
        }
      }
    } else if (command === "welcome") {
      const changed = changeSetting("welcome", args[0]?.toLowerCase());
      if (!changed) await sendBotReply(sock, jid, "Usage: .welcome on/off");
      else await sendBotReply(sock, jid, `👋 WELCOME ${settings.welcome ? "ON ✅" : "OFF ❌"}`);
    } else if (command === "goodbye") {
      if (!args.length) {
        await sendBotReply(sock, jid, "👋 Goodbye! Take care ❤️");
      } else {
        const changed = changeSetting("goodbye", args[0]?.toLowerCase());
        if (!changed) await sendBotReply(sock, jid, "Usage: .goodbye on/off");
        else await sendBotReply(sock, jid, `🚪 GOODBYE ${settings.goodbye ? "ON ✅" : "OFF ❌"}`);
      }
    } else if (command === "setwelcome") {
      const value = cleanCustomMessage(argsRaw);
      if (!value) {
        await sendBotReply(sock, jid, "Usage: .setwelcome <message>\n\nPlaceholders: {user} = mention new member, {group} = group name, {count} = member count in the event.\nReset: .setwelcome default");
      } else if (value.toLowerCase() === "default") {
        settings.welcomeMessage = DEFAULT_SETTINGS.welcomeMessage;
        saveSettings();
        await sendBotReply(sock, jid, "👋 Welcome message reset to default ✅");
      } else {
        const saved = saveCustomGroupMessage("welcomeMessage", value);
        if (!saved.ok) {
          await sendBotReply(sock, jid, saved.error === "long" ? "❌ Welcome message is too long. Keep it under 4000 characters." : "❌ Welcome message cannot be empty.");
        } else {
          await sendBotReply(sock, jid, `👋 Welcome message saved ✅\n\n${saved.value}`);
        }
      }
    } else if (command === "setgoodbye") {
      const value = cleanCustomMessage(argsRaw);
      if (!value) {
        await sendBotReply(sock, jid, "Usage: .setgoodbye <message>\n\nPlaceholders: {user} = leaving member mention, {group} = group name, {count} = member count in the event.\nReset: .setgoodbye default");
      } else if (value.toLowerCase() === "default") {
        settings.goodbyeMessage = DEFAULT_SETTINGS.goodbyeMessage;
        saveSettings();
        await sendBotReply(sock, jid, "🚪 Goodbye message reset to default ✅");
      } else {
        const saved = saveCustomGroupMessage("goodbyeMessage", value);
        if (!saved.ok) {
          await sendBotReply(sock, jid, saved.error === "long" ? "❌ Goodbye message is too long. Keep it under 4000 characters." : "❌ Goodbye message cannot be empty.");
        } else {
          await sendBotReply(sock, jid, `🚪 Goodbye message saved ✅\n\n${saved.value}`);
        }
      }
    } else if (command === "goodnight" || command === "gn") {
      await sendBotReply(sock, jid, "🌙 Good night everyone! Sweet dreams 😴✨");
    } else if (command === "goodbye" || command === "bye") {
      await sendBotReply(sock, jid, "👋 Goodbye! Take care ❤️");
    } else if (command === "song" || command === "play") {
      if (!settings.song) return void await sendBotReply(sock, jid, "🎵 Song command is OFF.");
      await sendOwnerCommandCard(sock, jid, command === "play" ? "▶️ PLAY" : "🎧 SONG", "⏳ Song খোঁজা হচ্ছে...");
      await sendSong(sock, jid, args.join(" "));
    } else if (command === "gcstory" || command === "story") {
      const ctx = getContextInfo(msg);
      if (!ctx.quotedMessage) return void await sendBotReply(sock, jid, "❌ আগে একটি message reply/quote করে .gcstory দিন।");
      const quoted = {
        key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant },
        message: ctx.quotedMessage
      };
      const metadata = await sock.groupMetadata(jid);
      const statusJidList = metadata.participants.map(p => p.id).filter(Boolean);
      const qm = unwrapMessage(quoted.message);
      let content;
      if (qm.imageMessage || qm.videoMessage || qm.audioMessage || qm.documentMessage) {
        const buffer = await downloadMediaMessage(quoted, "buffer", {}, { logger: P({ level: "silent" }) });
        if (qm.imageMessage) content = { image: buffer, caption: qm.imageMessage.caption || "" };
        else if (qm.videoMessage) content = { video: buffer, caption: qm.videoMessage.caption || "" };
        else if (qm.audioMessage) content = { audio: buffer, mimetype: qm.audioMessage.mimetype || "audio/mpeg" };
        else content = { document: buffer, mimetype: qm.documentMessage.mimetype || "application/octet-stream", fileName: qm.documentMessage.fileName || "GCSTORY" };
      } else {
        const qt = getText(quoted);
        if (!qt) return void await sendBotReply(sock, jid, "❌ Quoted message-এ text/media নেই।");
        content = { text: qt };
      }
      await sock.sendMessage(jid, content, { broadcast: true, statusJidList });
      await sendOwnerCommandCard(sock, jid, "📖 GCSTORY", "Story sent successfully.");
    }
  } catch (e) {
    logger.error({ err:e, command, jid }, "command failed");
    await sendBotReply(sock, jid, `❌ Command error: ${e.message || "unknown error"}`).catch(() => {});
  }

  // Automatic plain-text replies
  if (isSelfMessage) return;

  const lower = text.toLowerCase();
  if (settings.autoGoodNight && /(^|\s)(good\s*night)(\s|$)/i.test(lower) && !["goodnight","gn"].includes(command)) {
    await sock.sendMessage(jid, { text: "🌙 Good night! Sweet dreams 😴" }).catch(() => {});
  }
  if (settings.autoGoodbye && /(^|\s)(good\s*bye|goodbye)(\s|$)/i.test(lower) && !["goodbye","bye"].includes(command)) {
    await sock.sendMessage(jid, { text: "👋 Goodbye! Take care ❤️" }).catch(() => {});
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  // Do not depend on fetchLatestBaileysVersion; it can prevent startup when
  // a hosting environment cannot reach the version endpoint.
  // WhatsApp periodically changes the Web client revision. A stale
  // hard-coded revision can cause WebSocket 405 / client_too_old loops.
  let waVersion;
  try {
    const latest = await fetchLatestWaWebVersion();
    if (latest?.version?.length === 3) {
      waVersion = latest.version;
      console.log(`🌐 WhatsApp Web version: ${waVersion.join(".")}`);
    }
  } catch (e) {
    console.warn("⚠️ Could not fetch live WhatsApp Web version; using Baileys default.", e.message);
  }

  const sock = makeWASocket({
    auth: state,
    logger,
    ...(waVersion ? { version: waVersion } : {}),
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 2000
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n===== BOSS X QR CODE =====\n");
      qrcode.generate(qr, { small: true });
      console.log("\n==========================\n");
    }
    if (connection === "connecting") console.log("🔄 Connecting to WhatsApp...");
    if (connection === "open") {
      console.log("====================================");
      console.log("✅ BOSS X BOT CONNECTED SUCCESSFULLY");
      console.log(`👑 Owner: ${config.OWNER_NAME}`);
      console.log(`🔐 BOT MODE: ${getBotMode().toUpperCase()}`);
      console.log("📡 Outgoing message timeout protection: ON");
      console.log("📩 Send from owner number: ping / menu / settings");
      console.log("====================================");
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      console.log(`❌ Connection closed. code=${code ?? "unknown"}`);
      if (reconnect) setTimeout(startBot, 3000);
      else console.log("🔒 Logged out. Delete auth_info and pair again.");
    }
  });

  // Pairing code for environments where QR is inconvenient.
  if (!state.creds.registered && !pairingAsked) {
    pairingAsked = true;
    let number = process.env.PAIRING_NUMBER;
    if (!number && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      number = await new Promise(resolve => rl.question("Enter WhatsApp number (country code, digits only): ", resolve));
      rl.close();
    }
    if (number) {
      number = String(number).replace(/\D/g, "");
      try {
        await new Promise(r => setTimeout(r, 2000));
        const code = await sock.requestPairingCode(number);
        console.log(`\n🔐 PAIRING CODE: ${code}\n`);
      } catch (e) {
        console.error("❌ Pairing code error:", e.message);
      }
    }
  }

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log(`📨 messages.upsert: ${type || "unknown"} (${messages?.length || 0})`);
    for (const msg of messages || []) {
      try {
        await handleMessage(sock, msg);
      } catch (e) {
        logger.error({ err:e }, "message handler crashed");
      }
    }
  });

  sock.ev.on("messages.update", async updates => {
    for (const update of updates || []) {
      if (settings.antidelete) await restoreDeleted(sock, update, "♻️ ANTI-DELETE");
      if (settings.anticClean) await restoreDeleted(sock, update, "🧹 ANTI-CLEAN");
    }
  });

  sock.ev.on("call", async calls => {
    if (!settings.anticall) return;
    for (const call of calls || []) {
      try {
        await sock.rejectCall(call.id, call.from);
        await sock.sendMessage(call.from, { text: "🚫 ANTI-CALL: এই bot call গ্রহণ করে না।" });
      } catch (e) { logger.error({ err:e }, "anti-call failed"); }
    }
  });

  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (!isGroup(id) || !isActiveGroup(id)) return;
    try {
      if (action === "add" && settings.welcome && isWelcomeGroup(id)) {
        const mentions = Array.from(new Set(participants || []));
        const metadata = await sock.groupMetadata(id);
        const text = formatGroupMessage(settings.welcomeMessage, mentions, metadata.subject);
        await sock.sendMessage(id, { text, mentions });
      }
      if (action === "remove" && settings.goodbye) {
        const mentions = Array.from(new Set(participants || []));
        const metadata = await sock.groupMetadata(id);
        const text = formatGroupMessage(settings.goodbyeMessage, mentions, metadata.subject);
        await sock.sendMessage(id, { text, mentions });
      }
      if (action === "promote" && settings.antiadmin) {
        // WhatsApp can emit LID JIDs in group-participant events. Resolve the
        // promoted member from fresh group metadata and try every supported JID
        // form, because Baileys 6.7.x may require id, phoneNumber, or lid.
        await new Promise(r => setTimeout(r, 1800));
        const metadata = await getGroupMetadataSafe(sock, id);
        const ownerNumber = baseNumber(normalizeJid(config.OWNER_NUMBER));
        const botNumber = baseNumber(sock.user?.id || sock.user?.phoneNumber || "");
        const promoted = Array.from(new Set(participants || []));
        const targets = [];

        for (const who of promoted) {
          const p = (metadata?.participants || []).find(x => participantMatchesJid(x, who));
          const values = [p?.id, p?.phoneNumber, p?.lid, who].filter(Boolean).map(String);
          const numbers = values.map(baseNumber);
          // Never remove the configured owner or the bot itself.
          if (numbers.includes(ownerNumber) || (botNumber && numbers.includes(botNumber))) continue;
          targets.push({ who, candidates: Array.from(new Set(values)) });
        }

        if (targets.length) {
          if (!(await isBotAdmin(sock, id))) {
            await sock.sendMessage(id, { text: "⚠️ ANTI-ADMIN ON আছে, কিন্তু bot admin না থাকায় promoted member-কে demote করা যাবে না।" });
          } else {
            let success = 0;
            const successMentions = [];
            for (const target of targets) {
              let done = false;
              let lastErr = null;
              for (const candidate of target.candidates) {
                try {
                  const result = await sock.groupParticipantsUpdate(id, [candidate], "demote");
                  const statuses = Array.isArray(result) ? result.map(r => String(r?.status ?? "")) : [];
                  if (!statuses.length || statuses.some(st => ["200", "207"].includes(st))) {
                    done = true;
                    break;
                  }
                  lastErr = new Error(`demote status ${statuses.join(",")}`);
                } catch (err) {
                  lastErr = err;
                }
              }
              if (done) {
                success++;
                successMentions.push(target.who);
              } else {
                logger.error({ err: lastErr, id, candidates: target.candidates }, "anti-admin demote failed for promoted member");
              }
            }

            if (success > 0) {
              await sock.sendMessage(id, {
                text: `🛡️ ANTI-ADMIN: ${success} জনকে demote করা হয়েছে।`,
                mentions: successMentions
              });
            } else {
              await sock.sendMessage(id, { text: "⚠️ ANTI-ADMIN ON আছে, কিন্তু promoted member-কে demote করা যায়নি। Bot-কে group admin করে আবার চেষ্টা করুন।" });
            }
          }
        }
      }
    } catch (e) { logger.error({ err:e }, "group participant handler failed"); }
  });
}

startBot().catch(err => {
  console.error("❌ FATAL:", err);
  process.exit(1);
});
