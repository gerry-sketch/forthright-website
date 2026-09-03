// Marlie (AI phone answering service) -> JobTread
// Called by the "Marlie Zap" in Zapier: Marlie AI "Call Ended" trigger ->
// spam filter -> webhook POST here. Replaces the retired HubSpot steps
// (Sep 2026, per Gerry: phone leads land in JobTread like website leads).
//
// Creates a JobTread customer (account + contact + location) and a job with
// the call summary in Project Details. Callers often give no email/address —
// the lead is captured with whatever they did give, nothing is dropped.
// Per Gerry (9/2): assigned to Carl, Lead Source "Phone Call".

const ORG_ID = "22PWNQm4MwfM";
const PAVE_URL = "https://api.jobtread.com/pave";
// Same backup sheet as the website forms, fire-and-forget.
const SHEET_WEBHOOK =
  process.env.SHEET_WEBHOOK_URL ||
  "https://script.google.com/macros/s/AKfycbzugtzFawSWelo3-uDHsYYrWfSPOrIlJxv09inPh-dmOBGhGVrAR3yH5dWrSsgbXJOFRg/exec";

// JobTread custom field IDs (see instant-estimate.js for provenance)
const CF = {
  CONTACT_EMAIL: "22PWNRRPMVk4", // customerContact
  CONTACT_PHONE: "22PWNRRPPj9m", // customerContact
  LEAD_SOURCE: "22PWNRRPJWZZ", // customer
  JOB_STATUS: "22PWNRRPQrqe", // job
  JOB_TRADE: "22PbMPk2X4Uu", // job
  JOB_DETAILS: "22PbMQCpVRmv", // job (Project Details)
  JOB_SALES_REP: "22PbFE4kMzTE", // job (Sales Rep, required picklist)
  JOB_TYPE: "22PbMQ8G6wMy", // job
  JOB_LEAD_SOURCE: "22PbsL2APXu5", // job (Lead Source picklist)
};

// Marlie's project-type answer is free speech, so map generously onto the
// Trade option list and fall back to "Other" — a phone lead with an unknown
// trade still needs its job (the call summary lives there).
const TRADE_MAP = {
  roof: "Roofing",
  roofing: "Roofing",
  shingle: "Roofing",
  siding: "Siding",
  deck: "Decks",
  decks: "Decks",
  porch: "Decks",
};
// Marlie's Category field classifies call intent (lead_or_booking, ...), not
// the trade, so scan the call summary too — it reliably names the project
// ("The caller asked about replacing the siding...").
function mapTrade(projectType, summary) {
  for (const text of [projectType, summary]) {
    const t = (text || "").toLowerCase();
    for (const k of Object.keys(TRADE_MAP)) if (t.includes(k)) return TRADE_MAP[k];
  }
  return "Other";
}

async function backupToSheet(p, fullAddress) {
  try {
    await fetch(SHEET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({
        form: "Marlie Call",
        firstname: p.name || "",
        lastname: "",
        email: p.email || "",
        phone: p.phone || "",
        address: fullAddress,
        howHeard: "Phone Call",
        attribution: p.conversationId || "",
      }),
    });
  } catch (err) {
    console.error("marlie-lead: sheet backup failed:", err.message);
  }
}

async function pave(query) {
  const grantKey = process.env.JOBTREAD_GRANT;
  if (!grantKey) throw new Error("JOBTREAD_GRANT not configured");
  const res = await fetch(PAVE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: { $: { grantKey }, ...query } }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  if (!res.ok) throw new Error(`Pave ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

// Same self-healing as instant-estimate.js: drop dead field IDs and invalid
// option values rather than losing the lead.
const DEAD_FIELD_RE = /Could not find custom field with ID or name "([^"]+)"/;
const BAD_OPTION_RE = /"([^"]+)" is not a valid option for the "([^"]+)" custom field/;
async function paveDroppingDeadFields(buildQuery, fields) {
  const cfv = { ...fields };
  for (let i = 0; i <= Object.keys(fields).length; i++) {
    try {
      return await pave(buildQuery(cfv));
    } catch (err) {
      const dead = err.message.match(DEAD_FIELD_RE);
      if (dead && dead[1] in cfv) {
        console.error(`marlie-lead: dropping dead custom field ${dead[1]} and retrying`);
        delete cfv[dead[1]];
        continue;
      }
      const bad = err.message.match(BAD_OPTION_RE);
      if (bad) {
        const key = Object.keys(cfv).find((k) => cfv[k] === bad[1]);
        if (key) {
          console.error(`marlie-lead: dropping invalid option "${bad[1]}" for "${bad[2]}" and retrying`);
          delete cfv[key];
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error("custom field retries exhausted");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let p;
  try { p = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Bad JSON" }; }

  // The Zap's filter already blocks spam; this is belt and suspenders in case
  // the filter is ever edited out.
  if (p.isSpam === true || String(p.isSpam).toLowerCase() === "true") {
    return { statusCode: 200, body: JSON.stringify({ ok: true, result: "skipped-spam" }) };
  }

  const name = (p.name || "").trim();
  const phone = (p.phone || "").trim();
  const email = (p.email || "").trim();
  if (!name && !phone && !email) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "no caller identity" }) };
  }

  const fullAddress = (p.address || "").trim();
  const streetLine = fullAddress.split(",")[0].trim().slice(0, 30);

  // Backup first, so the sheet catches the call even if JobTread rejects it.
  await backupToSheet(p, fullAddress);

  const detailsParts = [];
  if (p.summary) detailsParts.push(String(p.summary).trim());
  if (p.notes && p.notes !== p.summary) detailsParts.push(String(p.notes).trim());
  detailsParts.push(`Source: Marlie phone call${phone ? ` from ${phone}` : ""}${p.conversationId ? ` (${p.conversationId})` : ""}`);
  const details = detailsParts.join("\n\n");

  const customerFields = { [CF.LEAD_SOURCE]: "Phone Call" };
  const jobFields = {
    [CF.JOB_STATUS]: "New Lead",
    [CF.JOB_TRADE]: mapTrade(p.projectType, p.summary),
    [CF.JOB_DETAILS]: details,
    [CF.JOB_SALES_REP]: "Carl Grumbine",
    [CF.JOB_TYPE]: "Residential",
    [CF.JOB_LEAD_SOURCE]: "Phone Call",
  };

  try {
    // Same convention as website leads: always a new customer, name collisions
    // get a (2), (3), ... suffix so no call is ever silently merged or lost.
    const baseName = name || `Phone Lead ${phone || email}`;
    let accountId = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const acctName = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
      try {
        const buildCreate = (cfv) => ({
          createAccount: {
            $: { organizationId: ORG_ID, name: acctName, type: "customer", ...(Object.keys(cfv).length && { customFieldValues: cfv }) },
            createdAccount: { id: {} },
          },
        });
        let created;
        try {
          created = await paveDroppingDeadFields(buildCreate, customerFields);
        } catch (err) {
          if (/already exists/i.test(err.message)) throw err;
          console.error("marlie-lead: createAccount failed with custom fields, retrying bare:", err.message.slice(0, 200));
          created = await pave(buildCreate({}));
        }
        accountId = created.createAccount.createdAccount.id;
        break;
      } catch (err) {
        if (!/already exists/i.test(err.message)) throw err;
      }
    }
    if (!accountId) throw new Error("could not create customer after name retries");

    const contactCfv = {};
    if (email) contactCfv[CF.CONTACT_EMAIL] = email;
    if (phone) contactCfv[CF.CONTACT_PHONE] = phone;
    await paveDroppingDeadFields((cfv) => ({
      createContact: {
        $: { accountId, name: baseName, ...(Object.keys(cfv).length && { customFieldValues: cfv }) },
        createdContact: { id: {} },
      },
    }), contactCfv);

    const loc = await pave({
      createLocation: {
        $: { accountId, address: fullAddress || "Address not provided", name: streetLine || "Home" },
        createdLocation: { id: {} },
      },
    });
    const locationId = loc.createLocation.createdLocation.id;

    let jobId = null;
    try {
      const job = await paveDroppingDeadFields((cfv) => ({
        createJob: {
          $: { locationId, name: streetLine || baseName, ...(Object.keys(cfv).length && { customFieldValues: cfv }) },
          createdJob: { id: {} },
        },
      }), jobFields);
      jobId = job.createJob.createdJob.id;
    } catch (err) {
      console.error("marlie-lead: job creation skipped:", err.message);
    }

    console.log(`marlie-lead: created account ${accountId}, job ${jobId || "none"}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, result: "created", accountId, jobId }) };
  } catch (err) {
    console.error("marlie-lead error:", err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: "jobtread-push-failed" }) };
  }
};
