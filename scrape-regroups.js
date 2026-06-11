#!/usr/bin/env node
/**
 * Scrapes the respawn / regroup schedule from avalanche.qd.je.
 *
 * The table is fully server-rendered, so we just fetch the HTML and parse
 * the <table class="regroups-table"> rows. Each countdown cell carries a
 * data-timestamp attribute holding the canonical respawn time (unix seconds),
 * which we use as the source of truth.
 *
 * Scraping uses Node's built-in fetch (Node 18+; this targets 24) and needs
 * no dependencies. Pushing to Firebase uses firebase-admin + a service-account
 * key, which bypasses the database security rules.
 *
 * Usage:
 *   node scrape-regroups.js            # prints the schedule as a table + JSON
 *   node scrape-regroups.js --out f    # also writes the data to f (JSON)
 *   node scrape-regroups.js --push     # also writes the schedule to Firebase
 *
 * Firebase auth (only needed for --push): point at a service-account key via
 *   --key path\to\key.json   or   env GOOGLE_APPLICATION_CREDENTIALS
 * otherwise it defaults to ./serviceAccountKey.json (gitignored).
 */

const URL = "https://avalanche.qd.je/proximos-regroups/";
const DB_URL =
  "https://brokenmirrordb-default-rtdb.europe-west1.firebasedatabase.app";
const DB_NODE = "regroups"; // top-level node the schedule is written to

// --- helpers ---------------------------------------------------------------

/** Strip HTML tags and decode the handful of entities the page uses. */
function text(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Make a Firebase-key-safe slug (no . $ # [ ] / or control chars). */
function slug(s) {
  return s
    .toLowerCase()
    .replace(/[.$#[\]/]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Pull the inner HTML of every <td>…</td> inside a row. */
function cells(rowHtml) {
  const out = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) out.push(m[1]);
  return out;
}

// --- scrape ----------------------------------------------------------------

async function scrape() {
  const res = await fetch(URL, {
    headers: { "User-Agent": "Mozilla/5.0 (regroup-scraper)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${URL}`);
  const html = await res.text();

  // Isolate the schedule table, then its <tbody>.
  const table = html.match(
    /<table[^>]*class="[^"]*regroups-table[^"]*"[^>]*>([\s\S]*?)<\/table>/i
  );
  if (!table) throw new Error("regroups-table not found in page");
  const tbody = table[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const body = tbody ? tbody[1] : table[1];

  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let r;
  while ((r = rowRe.exec(body)) !== null) {
    const rowHtml = r[1];
    const td = cells(rowHtml);
    if (td.length < 7) continue; // skip malformed rows

    // The countdown cell holds the canonical respawn unix timestamp.
    const tsMatch = rowHtml.match(/data-timestamp="(\d+)"/i);
    const ts = tsMatch ? Number(tsMatch[1]) : null;

    rows.push({
      event: text(td[0]),
      respawnTimestamp: ts, // unix seconds, UTC — source of truth
      respawnISO: ts ? new Date(ts * 1000).toISOString() : null, // UTC
    });
  }

  return rows;
}

// --- firebase --------------------------------------------------------------

/**
 * Replace the `regroups` node with the freshly scraped schedule. We .set() the
 * whole node each run so stale/removed events drop out automatically. Shape:
 *   regroups/updatedAt        -> server time (ms)
 *   regroups/events/<slug>    -> { event, respawnTimestamp, respawnISO }
 */
async function pushToFirebase(rows) {
  const fs = await import("node:fs");
  const admin = (await import("firebase-admin")).default;

  // Resolve the service-account key path.
  const keyFlag = process.argv.indexOf("--key");
  const keyPath =
    (keyFlag !== -1 && process.argv[keyFlag + 1]) ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    "serviceAccountKey.json";

  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Service-account key not found at "${keyPath}". Download one from ` +
        `Firebase console → Project settings → Service accounts → ` +
        `Generate new private key, then pass --key <path> or set ` +
        `GOOGLE_APPLICATION_CREDENTIALS.`
    );
  }

  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DB_URL,
  });

  const events = {};
  for (const e of rows) {
    events[slug(e.event)] = {
      event: e.event,
      respawnTimestamp: e.respawnTimestamp,
      respawnISO: e.respawnISO,
    };
  }

  await admin.database().ref(DB_NODE).set({
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    events,
  });

  await admin.app().delete(); // close the connection so the process can exit
  console.log(
    `\nPushed ${rows.length} events to ${DB_URL}/${DB_NODE} (key: ${keyPath})`
  );
}

// --- main ------------------------------------------------------------------

async function main() {
  const rows = await scrape();
  console.log(`Scraped ${rows.length} regroup entries from ${URL}\n`);

  // Compact, readable overview.
  console.table(
    rows.map((e) => ({
      Event: e.event,
      Respawn_UTC: e.respawnISO,
      Timestamp: e.respawnTimestamp,
    }))
  );

  const outFlag = process.argv.indexOf("--out");
  if (outFlag !== -1 && process.argv[outFlag + 1]) {
    const fs = await import("node:fs/promises");
    const path = process.argv[outFlag + 1];
    await fs.writeFile(path, JSON.stringify(rows, null, 2), "utf8");
    console.log(`\nWrote ${rows.length} entries to ${path}`);
  } else {
    console.log("\nJSON:\n" + JSON.stringify(rows, null, 2));
  }

  if (process.argv.includes("--push")) {
    await pushToFirebase(rows);
  }
}

main().catch((err) => {
  console.error("Scrape failed:", err.message);
  process.exit(1);
});
