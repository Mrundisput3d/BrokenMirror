#!/usr/bin/env node
"use strict";

/**
 * BMA Attendance Bot — screenshot -> attendance pipeline.
 *
 * Members post Lineage 2 screenshots, then someone runs `!scan`. The bot scans
 * every screenshot posted since the most recent UPDATED divider, reads the
 * character names off each (party panel / command channel / self bar) with
 * Gemini Vision, fuzzy-matches them against the known CP roster in Firebase,
 * and posts one "<link> <caption>: name1, name2" line per screenshot (the
 * caption is the screenshot message's own text, omitted if it had none) with a
 * Send to Panel button. Pressing it pushes the names to `pendingScans` (for the
 * web Command Center) and posts a fresh UPDATED divider so that batch is never
 * re-scanned.
 *
 * Node 24+ (uses the built-in global fetch). Configuration via env vars:
 *   DISCORD_TOKEN                  Discord bot token (required)
 *   GEMINI_API_KEY                Google Gemini API key (required)
 *   GOOGLE_APPLICATION_CREDENTIALS  Path to the Firebase service-account key
 *                                 (optional; defaults to serviceAccount.json)
 *
 * Run with:  node --env-file=.env discord-bot.js
 */

const fs = require("node:fs");
const admin = require("firebase-admin");
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require("discord.js");
const { GoogleGenAI, Type } = require("@google/genai");

// --- Config ----------------------------------------------------------------

const DB_URL =
  "https://brokenmirrordb-default-rtdb.europe-west1.firebasedatabase.app";
const GEMINI_MODEL = "gemini-2.5-flash";
const IMAGE_EXTS = ["png", "jpg", "jpeg"];
// Only members with this role may run !scan.
const SCAN_ROLE = process.env.SCAN_ROLE || "Alliance Leader";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const KEY_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || "serviceAccount.json";

if (!DISCORD_TOKEN || !GEMINI_API_KEY) {
  console.error(
    "Missing DISCORD_TOKEN and/or GEMINI_API_KEY. Set them in the environment " +
      "(e.g. a .env file passed via `node --env-file=.env discord-bot.js`)."
  );
  process.exit(1);
}

// --- Firebase --------------------------------------------------------------

if (!fs.existsSync(KEY_PATH)) {
  console.error(
    `Service-account key not found at "${KEY_PATH}". Download one from the ` +
      `Firebase console (Project settings -> Service accounts -> Generate new ` +
      `private key) and point GOOGLE_APPLICATION_CREDENTIALS at it.`
  );
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(fs.readFileSync(KEY_PATH, "utf8"))
  ),
  databaseURL: DB_URL,
});
const db = admin.database();

// --- Gemini ----------------------------------------------------------------

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const PARTY_SYSTEM_PROMPT = `You are analyzing screenshots from the MMORPG Lineage 2 to extract character names for attendance tracking.

An image may contain one or more of these UI elements:

1) PARTY PANEL — the in-game party panel, a compact panel usually anchored to the left side of the screen. Each row shows: character name, class icon, and HP (red) / MP (blue) / CP (yellow) bars. It may also show a "Party Match" or similar label — ignore the label, read the name rows. Note: the local player does NOT appear in their own party panel — their name is in the self status bar (element 3).

2) COMMAND CHANNEL INFO window — a larger popup titled "Command Channel Info". It has two sides:
   - Left: a list of party LEADERS in the command channel (one row per party, with kill/death stat columns).
   - Right: the currently SELECTED party shown expanded, with a "Leader" box at the top and a "Party Member" list of full character names below it.
   From this window read ONLY the expanded selected party on the right (the Leader plus every Party Member). IGNORE the left-side leader list and IGNORE all stat columns (K/D, kills, deaths, class icons).

3) SELF / LEADER STATUS BAR — the local player's own character bar (this is the party leader, who is NEVER listed among the party panel members in element 1). It can appear ANYWHERE on screen — bottom-center, top-left, or elsewhere — so do not rely on position. Identify it as a standalone bar (separate from the party panel) showing a level number badge (e.g. "80") next to the character name, with CP, HP, and MP bars and numeric values (e.g. "0/3260"). Read the player's own name from it. Do NOT confuse it with a selected target's nameplate: the self bar is the one showing CP AND HP AND MP bars together with numbers.

Use the EXACT character names as they appear (case-sensitive; preserve underscores, numbers, capitalization). Do not invent names; only include names you can clearly read.

Ignore everything else in the image: chat log, NPC nameplates, monsters, other players' floating nameplates, UI buttons, item labels.

Return JSON only — your output is parsed by a program, so no prose or markdown fences:
{"partyPanel": ["Name1", ...], "selfName": ["Name1", ...], "commandChannelParty": ["Name1", ...]}

- partyPanel: names from UI element 1. Empty array if no party panel is visible.
- selfName: the local player's name from UI element 3 (usually one name). Empty array if no self status bar is visible.
- commandChannelParty: names from the expanded selected party on the right of UI element 2. Empty array if no Command Channel Info window is visible.`;

const PARTY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    partyPanel: { type: Type.ARRAY, items: { type: Type.STRING } },
    selfName: { type: Type.ARRAY, items: { type: Type.STRING } },
    commandChannelParty: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["partyPanel", "selfName", "commandChannelParty"],
};

// Optional one-shot example: if discord-bot-reference.png exists next to the
// script, send it (plus its known answer) ahead of the real screenshot to
// anchor the model.
let EXAMPLE_PART = null;
try {
  const bytes = fs.readFileSync("discord-bot-reference.png");
  EXAMPLE_PART = {
    image: bytes.toString("base64"),
    response: {
      partyPanel: [
        "fidempor12",
        "iisushristos",
        "siriusbr",
        "sunnyleone",
        "akvan",
        "grp",
      ],
      selfName: ["mrundisput3d"],
      commandChannelParty: [],
    },
  };
} catch {
  EXAMPLE_PART = null;
}

function mediaTypeFromFilename(filename) {
  const name = filename.toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "image/png";
}

/**
 * Ask Gemini for the character names in a single screenshot.
 *
 * The local player's own name (self status bar) is always included. For the
 * roster body we use the party panel when one is visible, otherwise fall back
 * to the expanded selected party from a Command Channel Info window. The
 * fallback is per image, so a screenshot showing both still prefers the panel.
 */
async function extractPartyNames(imageB64, mediaType) {
  const contents = [];
  if (EXAMPLE_PART) {
    contents.push(
      {
        role: "user",
        parts: [
          { inlineData: { data: EXAMPLE_PART.image, mimeType: "image/png" } },
        ],
      },
      {
        role: "model",
        parts: [{ text: JSON.stringify(EXAMPLE_PART.response) }],
      }
    );
  }
  contents.push({
    role: "user",
    parts: [{ inlineData: { data: imageB64, mimeType: mediaType } }],
  });

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: PARTY_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: PARTY_SCHEMA,
      // Disable "thinking" — it's unnecessary for this extraction and otherwise
      // eats the output-token budget, truncating the JSON. Then give names room.
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 2048,
    },
  });

  if (!response.text) {
    throw new Error(`empty Gemini response (finishReason: ${
      response.candidates?.[0]?.finishReason ?? "unknown"
    })`);
  }
  const result = JSON.parse(response.text);
  const partyPanel = result.partyPanel || [];
  const selfName = result.selfName || [];
  const commandChannelParty = result.commandChannelParty || [];
  const roster = partyPanel.length > 0 ? partyPanel : commandChannelParty;
  // hasParty is true only when an actual party panel or command-channel party
  // was read (a lone self/leader bar doesn't count). The caller uses it to stop
  // scanning the rest of a multi-image message once one shot shows the party.
  return { names: [...selfName, ...roster], hasParty: roster.length > 0 };
}

// --- Fuzzy matching --------------------------------------------------------

/** Classic Levenshtein edit distance between two strings. */
function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array.from({ length: b.length + 1 }, () =>
    new Array(a.length + 1).fill(0)
  );
  for (let i = 0; i <= b.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] =
        b[i - 1] === a[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(
              matrix[i - 1][j - 1] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j] + 1
            );
    }
  }
  return matrix[b.length][a.length];
}

/** Pull every active CP leader/member name from Firebase, lowercased. */
async function loadKnownNames() {
  const snapshot = await db.ref("cps/").get();
  const cps = snapshot.val() || {};
  const known = new Set();
  for (const cp of Object.values(cps)) {
    if (cp.clan === "history") continue;
    const leader = (cp.leader || "").trim().toLowerCase();
    if (leader) known.add(leader);
    for (const m of (cp.members || "").split(",")) {
      const name = m.trim().toLowerCase();
      if (name) known.add(name);
    }
  }
  return known;
}

/**
 * Split extracted words into ones that resemble a known roster name (`matched`)
 * and ones that were read clearly but match nobody in Firebase (`unmatched`).
 * Junk — words under 3 chars or purely numeric — is dropped from both.
 */
function filterToRoster(rawWords, knownNames) {
  const matched = [];
  const unmatched = [];
  for (const word of rawWords) {
    const lower = word.toLowerCase();
    if (lower.length < 3 || /^\d+$/.test(lower)) continue;
    let hit = false;
    for (const kn of knownNames) {
      const allowedDist = kn.length > 5 ? 2 : 1;
      if (
        lower === kn ||
        lower.includes(kn) ||
        kn.includes(lower) ||
        editDistance(lower, kn) <= allowedDist
      ) {
        matched.push(word);
        hit = true;
        break;
      }
    }
    if (!hit) unmatched.push(word);
  }
  return {
    matched: [...new Set(matched)],
    unmatched: [...new Set(unmatched)],
  };
}

// --- Discord ---------------------------------------------------------------

// Timestamped console logging so the bot's progress is visible in the terminal.
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...args) => console.log(`[${ts()}]`, ...args);
const logErr = (...args) => console.error(`[${ts()}]`, ...args);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const isImageAttachment = (att) =>
  IMAGE_EXTS.some((ext) => att.name.toLowerCase().endsWith(ext));

// Image screenshots in a message, INCLUDING forwarded ones. A forward keeps its
// image in message.messageSnapshots rather than message.attachments, so we scan
// both. Each entry carries the attachment plus the caption that accompanied it
// (the forwarded snapshot's own text for forwards, otherwise the message text).
function screenshotsIn(message) {
  const shots = [];
  for (const att of message.attachments.values()) {
    if (isImageAttachment(att)) shots.push({ att, caption: message.content.trim() });
  }
  for (const snap of message.messageSnapshots?.values() ?? []) {
    for (const att of snap.attachments.values()) {
      if (isImageAttachment(att)) {
        shots.push({ att, caption: (snap.content || message.content).trim() });
      }
    }
  }
  return shots;
}

// Posted to the channel after a batch is submitted; also acts as the boundary
// `!scan` reads up to, so an already-submitted batch is never re-scanned.
const DIVIDER =
  "========================================================UPDATED✅ ✅ ✅===========================================================================================";

// A divider is any message with a long "===" run and the word UPDATED, from
// anyone (members post them by hand too). We deliberately ignore the emoji and
// spacing so "UPDATED✅✅✅" and "UPDATED ✅ ✅ ✅" both count.
const isDivider = (message) => {
  const text = message.content.toUpperCase();
  return /={10,}/.test(text) && text.includes("UPDATED");
};

/**
 * Turn the live status `message` into the result: `content` (one
 * "<link> <caption>: name1, name2" line per screenshot) plus a Send to Panel
 * button. Pressing it pushes `names` to `pendingScans` and posts the UPDATED
 * divider to the channel; Cancel discards.
 */
async function postResult(triggerMessage, message, content, names, userNotes, authorName) {
  const sendBtn = new ButtonBuilder()
    .setCustomId("confirm_send")
    .setLabel("Send to Panel")
    .setStyle(ButtonStyle.Success)
    .setEmoji("✅");
  const cancelBtn = new ButtonBuilder()
    .setCustomId("confirm_cancel")
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger)
    .setEmoji("❌");
  const row = new ActionRowBuilder().addComponents(sendBtn, cancelBtn);

  await message.edit({ content, components: [row] });

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 600_000,
  });

  const channel = `#${triggerMessage.channel.name ?? "dm"}`;

  collector.on("collect", async (interaction) => {
    if (interaction.customId === "confirm_cancel") {
      collector.stop("cancelled");
      log(`${interaction.user.username} cancelled the scan in ${channel}`);
      await interaction.update({ content: `${content}\n❌ Cancelled.`, components: [] });
      return;
    }

    // confirm_send
    await db.ref("pendingScans").push().set({
      rawText: names.join(" "),
      userNotes,
      timestamp: Date.now(),
      submittedBy: authorName,
      channel: triggerMessage.channel.name ?? null,
    });

    collector.stop("sent");
    log(`${interaction.user.username} sent ${names.length} name(s) to pendingScans from ${channel}`);
    await interaction.update({
      content: `${content}\n✅ Sent **${names.length} name(s)** to the Command Center.`,
      components: [],
    });
    await triggerMessage.channel.send(DIVIDER);
  });

  collector.on("end", async (_collected, reason) => {
    if (reason === "time") {
      log(`scan result in ${channel} timed out without a choice`);
      await message.edit({ components: [] }).catch(() => {});
    }
  });
}

/**
 * Scan every screenshot in `sourceMessages` through Gemini, filter each to the
 * roster, and post one "<link> screenshot: names" line per screenshot.
 */
async function processImages(triggerMessage, sourceMessages) {
  // A live status message the channel can watch; it becomes the final result.
  let status;
  try {
    status = await triggerMessage.reply("🔍 Starting scan…");
    const knownNames = await loadKnownNames();
    const shots = sourceMessages.flatMap((src) =>
      screenshotsIn(src).map(({ att, caption }) => ({ src, att, caption }))
    );
    log(`scanning ${shots.length} screenshot(s) against ${knownNames.size} roster names`);
    await status.edit(`🔍 Found **${shots.length}** screenshot(s). Scanning…`).catch(() => {});

    const lines = [];
    const allNames = new Set(); // unique roster names across the batch (orig case)
    const seen = new Set(); // matched names lowercased, for cross-shot dedup
    const seenNotFound = new Set(); // not-found names lowercased, for dedup
    // Message IDs whose party we've already read. Once a message yields a party
    // from one of its images, its remaining images are skipped entirely.
    const resolvedMessages = new Set();
    let i = 0;

    for (const { src, att, caption } of shots) {
      i += 1;
      if (resolvedMessages.has(src.id)) {
        log(`  [${i}/${shots.length}] skipping ${att.name} — its message already showed a party`);
        continue;
      }
      await status
        .edit(`🔍 Scanning **${i}/${shots.length}** — \`${att.name}\` · ${allNames.size} name(s) so far`)
        .catch(() => {});
      let names = [];
      let notFound = [];
      try {
        log(`  [${i}/${shots.length}] scanning ${att.name}...`);
        const buf = Buffer.from(await (await fetch(att.url)).arrayBuffer());
        const { names: raw, hasParty } = await extractPartyNames(
          buf.toString("base64"),
          mediaTypeFromFilename(att.name)
        );
        // A party panel / command channel was read off this image — don't scan
        // any other image from the same message.
        if (hasParty) resolvedMessages.add(src.id);
        const filtered = filterToRoster(raw, knownNames);
        names = filtered.matched;
        notFound = filtered.unmatched;
        log(`  [${i}/${shots.length}] ${att.name}: ${raw.length} read, ${names.length} matched roster, ${notFound.length} not found${hasParty ? " (party found)" : ""}`);
      } catch (err) {
        logErr(`  [${i}/${shots.length}] ${att.name} failed:`, err.message);
        continue;
      }
      // Drop names already captured by an earlier screenshot in this batch, so
      // the same party shown twice (e.g. the party panel in one shot and the
      // command channel in the next) is only counted and printed once.
      const fresh = names.filter((n) => !seen.has(n.toLowerCase()));
      // Not-found names read off this shot that we haven't already reported (and
      // that didn't match the roster under any spelling).
      const freshNotFound = notFound.filter(
        (n) => !seen.has(n.toLowerCase()) && !seenNotFound.has(n.toLowerCase())
      );
      if (fresh.length === 0 && freshNotFound.length === 0) {
        if (names.length > 0) {
          log(`  [${i}/${shots.length}] ${att.name}: all ${names.length} name(s) already seen — skipping`);
        }
        continue;
      }
      for (const n of fresh) {
        seen.add(n.toLowerCase());
        allNames.add(n);
      }
      for (const n of freshNotFound) seenNotFound.add(n.toLowerCase());

      // One line per screenshot: its caption (if any), the matched names with a
      // count, then any names read but not in the roster (shown for review only
      // — they are NOT sent to the panel).
      const label = caption ? `${caption}: ` : "";
      let line = `${src.url} ${label}`.trimEnd();
      if (fresh.length > 0) {
        const count = `(${fresh.length} ${fresh.length === 1 ? "person" : "people"})`;
        line += ` ${fresh.join(", ")} ${count}`;
      }
      if (freshNotFound.length > 0) {
        line += ` — ❓ not in roster: ${freshNotFound.join(", ")}`;
      }
      lines.push(line);
    }

    log(`scan complete: ${allNames.size} unique name(s) across ${lines.length} screenshot(s)`);

    if (allNames.size > 0) {
      const notes = triggerMessage.content.replace(/^!scan/i, "").trim() || "No description";
      await postResult(
        triggerMessage,
        status,
        lines.join("\n"),
        [...allNames],
        notes,
        triggerMessage.author.username
      );
    } else if (lines.length > 0) {
      // Names were read but none matched the roster — nothing to send, but show
      // what was read so a misspelling or a missing roster entry is visible.
      await status.edit(
        `❌ Found **NO** name that exists in your roster (CPs).\n${lines.join("\n")}`
      );
    } else {
      await status.edit("❌ Found **NO** name that exists in your roster (CPs).");
    }
  } catch (err) {
    logErr("scan failed:", err);
    const msg = `⚠️ Communication error: ${err.message}`;
    if (status) await status.edit(msg).catch(() => {});
    else await triggerMessage.reply(msg).catch(() => {});
  } finally {
    await triggerMessage.reactions
      .resolve("⏳")
      ?.users.remove(client.user.id)
      .catch(() => {});
  }
}

client.once("clientReady", () => {
  log("✅ BMA Attendance Bot is online. Write !scan in a channel to scan all screenshots since the last update.");
});

// !scan — scan every screenshot posted since the most recent UPDATED divider.
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!scan")) return;

  // Restrict to members carrying the configured role.
  if (!message.member?.roles.cache.some((r) => r.name === SCAN_ROLE)) {
    log(`!scan from ${message.author.username} ignored — missing "${SCAN_ROLE}" role`);
    await message.reply(`⛔ Only members with the **${SCAN_ROLE}** role can run \`!scan\`.`);
    return;
  }

  const channel = `#${message.channel.name ?? "dm"}`;
  log(`!scan from ${message.author.username} in ${channel} — collecting screenshots...`);
  await message.react("⏳");

  const history = await message.channel.messages.fetch({ limit: 100 });
  const ordered = [...history.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  // Walk oldest -> newest, resetting at each divider so only screenshots after
  // the LAST divider remain.
  let sources = [];
  for (const msg of ordered) {
    if (msg.id === message.id) continue; // skip the !scan command itself
    if (isDivider(msg)) sources = [];
    else if (screenshotsIn(msg).length > 0) sources.push(msg);
  }

  if (sources.length > 0) {
    await processImages(message, sources);
  } else {
    log(`no screenshots since last divider in ${channel} — nothing to scan`);
    await message.reply("❌ No screenshots found since the last update.");
    await message.reactions.resolve("⏳")?.users.remove(client.user.id);
  }
});

client.login(DISCORD_TOKEN);
