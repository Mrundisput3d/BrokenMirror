#!/usr/bin/env node
"use strict";

/**
 * BMA OCR Bot — screenshot -> attendance pipeline.
 *
 * Members drop Lineage 2 party-panel screenshots in an enabled channel (or
 * reply `!scan` to an existing screenshot). Gemini Vision reads the character
 * names off the panel, we fuzzy-match them against the known CP roster in
 * Firebase, and the submitter picks which names to keep from dropdown menus.
 * The confirmed list is pushed to `pendingScans` for the web Command Center
 * to turn into attendance for epics / sieges / etc.
 *
 * Node 24+ (uses the built-in global fetch). Configuration via env vars:
 *   DISCORD_TOKEN                  Discord bot token (required)
 *   GEMINI_API_KEY                Google Gemini API key (required)
 *   GOOGLE_APPLICATION_CREDENTIALS  Path to the Firebase service-account key
 *                                 (optional; defaults to serviceAccountKey.json)
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
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} = require("discord.js");
const { GoogleGenAI, Type } = require("@google/genai");

// --- Config ----------------------------------------------------------------

const DB_URL =
  "https://brokenmirrordb-default-rtdb.europe-west1.firebasedatabase.app";
const GEMINI_MODEL = "gemini-2.5-flash";
const IMAGE_EXTS = ["png", "jpg", "jpeg"];

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const KEY_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || "serviceAccountKey.json";

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

const PARTY_SYSTEM_PROMPT = `You are analyzing screenshots from the MMORPG Lineage 2.

The user sends images that contain the in-game Party Panel UI.

How to recognize a party panel:
- A compact panel showing party members, typically anchored to the left side of the screen
- Each row shows: character name, class icon, HP bar (red), MP bar (blue), CP bar (yellow)
- The panel may also show "Party Match" or other party-related labels — ignore those, focus on the rows with character names

Your task: extract ONLY the character names visible in the party panel rows. Ignore everything else in the image (chat log, NPC nameplates, monsters, other players' nameplates, UI buttons, item labels).

Return JSON only — your output is parsed by a program, so no prose or markdown fences:
{"names": ["Name1", "Name2", ...]}

Rules:
- Use the EXACT character names as they appear (case-sensitive; preserve underscores, numbers, and special characters)
- Include ALL party members visible in the panel (leader and members together — no separation needed)
- If the image doesn't contain a party panel, return {"names": []}
- Do not invent names; only include names you can clearly read in the party panel`;

const PARTY_SCHEMA = {
  type: Type.OBJECT,
  properties: { names: { type: Type.ARRAY, items: { type: Type.STRING } } },
  required: ["names"],
};

// Optional one-shot example: if image.png exists next to the script, send it
// (plus its known answer) ahead of the real screenshot to anchor the model.
let EXAMPLE_PART = null;
try {
  const bytes = fs.readFileSync("image.png");
  EXAMPLE_PART = {
    image: bytes.toString("base64"),
    names: [
      "fidempor12",
      "iisushristos",
      "siriusbr",
      "sunnyleone",
      "akvan",
      "grp",
      "mrundisput3d",
    ],
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

/** Ask Gemini for the character names in a single screenshot. */
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
        parts: [{ text: JSON.stringify({ names: EXAMPLE_PART.names }) }],
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
      maxOutputTokens: 1024,
    },
  });

  return JSON.parse(response.text).names || [];
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

/** Keep only OCR'd words that resemble a known roster name. */
function filterToRoster(rawWords, knownNames) {
  const matched = [];
  for (const word of rawWords) {
    const lower = word.toLowerCase();
    if (lower.length < 3 || /^\d+$/.test(lower)) continue;
    for (const kn of knownNames) {
      const allowedDist = kn.length > 5 ? 2 : 1;
      if (
        lower === kn ||
        lower.includes(kn) ||
        kn.includes(lower) ||
        editDistance(lower, kn) <= allowedDist
      ) {
        matched.push(word);
        break;
      }
    }
  }
  return [...new Set(matched)];
}

// --- Discord ---------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Channels where bare screenshots are auto-scanned. Empty on boot; admins
// toggle per channel with !start / !stop. Resets when the process restarts.
const activeChannels = new Set();

const validImages = (message) =>
  message.attachments.filter((att) =>
    IMAGE_EXTS.some((ext) => att.name.toLowerCase().endsWith(ext))
  );

const isAdmin = (member) =>
  Boolean(member?.permissions?.has?.("Administrator"));

/**
 * Reply to `triggerMessage` with the dropdowns + buttons, collect the
 * submitter's picks, and push the confirmed names to `pendingScans`.
 */
async function presentConfirmMenu(triggerMessage, names, userNotes, authorName) {
  // Discord allows 5 action rows per message: up to 4 select menus (25 options
  // each) plus 1 row for the buttons -> 100 names max.
  const capped = names.slice(0, 100);
  const limitMsg =
    names.length > 100
      ? "\n*(⚠️ Found more than 100 names. Showing the first 100.)*"
      : "";

  const rows = [];
  for (let i = 0; i < capped.length; i += 25) {
    const chunk = capped.slice(i, i + 25);
    const listNo = Math.floor(i / 25) + 1;
    const totalLists = Math.ceil(capped.length / 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`names_${listNo}`)
      .setPlaceholder(`Pick names (list ${listNo} of ${totalLists})...`)
      .setMinValues(0)
      .setMaxValues(chunk.length)
      .addOptions(chunk.map((name) => ({ label: name, value: name })));
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

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
  rows.push(new ActionRowBuilder().addComponents(sendBtn, cancelBtn));

  const reply = await triggerMessage.reply({
    content:
      `🎯 **SMART FILTER:** Found **${names.length}** valid name(s)!${limitMsg}\n` +
      `Open the lists below, **select the ones you want to keep**, and hit Send.`,
    components: rows,
  });

  // Track the latest selection of each menu; values arrive per-interaction.
  const selectionByMenu = new Map();
  const collector = reply.createMessageComponentCollector({ time: 600_000 });

  collector.on("collect", async (interaction) => {
    if (interaction.componentType === ComponentType.StringSelect) {
      selectionByMenu.set(interaction.customId, interaction.values);
      await interaction.deferUpdate();
      return;
    }

    if (interaction.customId === "confirm_cancel") {
      collector.stop("cancelled");
      await interaction.update({ content: "❌ Submission cancelled.", components: [] });
      return;
    }

    // confirm_send
    const selected = [...selectionByMenu.values()].flat();
    if (selected.length === 0) {
      await interaction.reply({
        content: "⚠️ **Heads up:** pick at least one name first!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await db.ref("pendingScans").push().set({
      rawText: selected.join(" "),
      userNotes,
      timestamp: Date.now(),
      submittedBy: authorName,
    });

    collector.stop("sent");
    await interaction.update({
      content: `✅ **Success!** Sent **${selected.length} name(s)** to the Command Center.`,
      components: [],
    });
  });

  collector.on("end", async (_collected, reason) => {
    if (reason === "time") {
      await reply.edit({ components: [] }).catch(() => {});
    }
  });
}

/** Run a batch of attachments through Gemini, filter, and prompt for confirmation. */
async function processImages(triggerMessage, images, userNotes, authorName) {
  try {
    const rawWords = [];
    for (const img of images.values()) {
      try {
        const buf = Buffer.from(await (await fetch(img.url)).arrayBuffer());
        const names = await extractPartyNames(
          buf.toString("base64"),
          mediaTypeFromFilename(img.name)
        );
        rawWords.push(...names);
      } catch (err) {
        console.error(`Gemini extraction error for ${img.name}:`, err);
      }
    }

    const knownNames = await loadKnownNames();
    const finalNames = filterToRoster(rawWords, knownNames);

    if (finalNames.length > 0) {
      await presentConfirmMenu(triggerMessage, finalNames, userNotes, authorName);
    } else {
      await triggerMessage.reply(
        "❌ Found **NO** name that exists in your roster (CPs)."
      );
    }
  } catch (err) {
    console.error("Error:", err);
    await triggerMessage.reply(`⚠️ Communication error: ${err.message}`);
  } finally {
    await triggerMessage.reactions
      .resolve("⏳")
      ?.users.remove(client.user.id)
      .catch(() => {});
  }
}

client.once("clientReady", () => {
  console.log("✅ BMA OCR Bot is online but DISABLED everywhere.");
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith("!stop")) {
    if (isAdmin(message.member)) {
      activeChannels.delete(message.channel.id);
      await message.reply("🛑 **Bot DISABLED for this channel.**");
    }
    return;
  }

  if (message.content.startsWith("!start")) {
    if (isAdmin(message.member)) {
      activeChannels.add(message.channel.id);
      await message.reply("✅ **Bot ENABLED for this channel!**");
    }
    return;
  }

  // !scan — scan the replied-to message, else the most recent screenshot above.
  if (message.content.startsWith("!scan")) {
    await message.react("⏳");
    let target = null;

    if (message.reference?.messageId) {
      try {
        const replied = await message.channel.messages.fetch(
          message.reference.messageId
        );
        if (validImages(replied).size > 0) {
          target = replied;
        } else {
          await message.reply("❌ The message you replied to has no valid image.");
          await message.reactions.resolve("⏳")?.users.remove(client.user.id);
          return;
        }
      } catch (err) {
        console.error("Error reading reply:", err);
      }
    }

    if (!target) {
      const history = await message.channel.messages.fetch({ limit: 15 });
      target = history.find(
        (msg) => msg.id !== message.id && validImages(msg).size > 0
      );
    }

    if (target) {
      const notes = target.content.trim() || "No description";
      await processImages(message, validImages(target), notes, target.author.username);
    } else {
      await message.reply("❌ Couldn't find any screenshot.");
      await message.reactions.resolve("⏳")?.users.remove(client.user.id);
    }
    return;
  }

  if (!activeChannels.has(message.channel.id)) return;

  const images = validImages(message);
  if (images.size > 0) {
    await message.react("⏳");
    const notes = message.content.trim() || "No description";
    await processImages(message, images, notes, message.author.username);
  }
});

client.login(DISCORD_TOKEN);
