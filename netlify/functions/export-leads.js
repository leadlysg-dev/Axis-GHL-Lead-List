const { schedule } = require("@netlify/functions");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

// ─── All config comes from Netlify env vars ─────────────────
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/gm, "\n");
const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

// ─── Fetch all contacts from GHL with pagination ────────────
async function fetchAllContacts() {
  const allContacts = [];
  let startAfter = null;
  let startAfterId = null;
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      locationId: GHL_LOCATION_ID,
      limit: "100",
    });
    if (startAfter) {
      params.set("startAfter", startAfter);
      params.set("startAfterId", startAfterId);
    }

    const res = await fetch(
      `https://services.leadconnectorhq.com/contacts/?${params}`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          "Content-Type": "application/json",
          Version: "2021-07-28",
        },
      }
    );

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GHL API ${res.status}: ${txt}`);
    }

    const data = await res.json();
    const contacts = data.contacts || [];
    const meta = data.meta || {};

    if (!contacts.length) break;

    allContacts.push(...contacts);
    console.log(`Page ${page}: ${contacts.length} contacts (total: ${allContacts.length})`);

    startAfter = meta.startAfter || null;
    startAfterId = meta.startAfterId || null;
    if (!startAfter) break;

    page++;
    await new Promise((r) => setTimeout(r, 200));
  }

  return allContacts;
}

// ─── Write contacts to Google Sheet ─────────────────────────
async function writeToSheet(contacts) {
  const auth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });

  const doc = new GoogleSpreadsheet(GOOGLE_SPREADSHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];

  await sheet.clear();
  await sheet.setHeaderRow([
    "First Name",
    "Last Name",
    "Phone",
    "Email",
    "Tags",
    "Status",
    "Date Added",
    "Last Updated",
  ]);

  const rows = contacts.map((c) => ({
    "First Name": c.firstName || "",
    "Last Name": c.lastName || "",
    Phone: c.phone || "",
    Email: c.email || "",
    Tags: Array.isArray(c.tags) ? c.tags.join(", ") : "",
    Status: c.contactName || c.type || "",
    "Date Added": c.dateAdded || "",
    "Last Updated": c.dateUpdated || "",
  }));

  await sheet.addRows(rows);
  console.log(`Wrote ${rows.length} rows to "${doc.title}"`);
}

// ─── The handler ────────────────────────────────────────────
const myHandler = async (event) => {
  console.log(`=== GHL Export running at ${new Date().toISOString()} ===`);

  const missing = [];
  if (!GHL_API_KEY) missing.push("GHL_API_KEY");
  if (!GHL_LOCATION_ID) missing.push("GHL_LOCATION_ID");
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  if (!GOOGLE_PRIVATE_KEY) missing.push("GOOGLE_PRIVATE_KEY");
  if (!GOOGLE_SPREADSHEET_ID) missing.push("GOOGLE_SPREADSHEET_ID");

  if (missing.length) {
    console.error("Missing env vars:", missing.join(", "));
    return { statusCode: 500, body: `Missing: ${missing.join(", ")}` };
  }

  try {
    const contacts = await fetchAllContacts();
    if (!contacts.length) {
      return { statusCode: 200, body: "No contacts found" };
    }
    await writeToSheet(contacts);
    return { statusCode: 200, body: `Exported ${contacts.length} contacts` };
  } catch (err) {
    console.error("Export failed:", err.message);
    return { statusCode: 500, body: err.message };
  }
};

// ─── Run every Monday at 7AM UTC ────────────────────────────
exports.handler = schedule("0 7 * * 1", myHandler);
