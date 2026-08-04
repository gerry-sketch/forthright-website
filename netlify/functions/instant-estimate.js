// Website forms -> JobTread
// Creates a JobTread customer (account + contact + location) AND a job from
// the instant estimate tool and the beat-any-estimate / hula landing pages.
// Per Carl (7/22, after JobTread's CRM recommendations): jobs are created on
// every form fill, with project answers mapped to job-level custom fields.

const ORG_ID = "22PWNQm4MwfM";
const PAVE_URL = "https://api.jobtread.com/pave";
// Per Carl (8/4): every form fill also appends a row to the backup Google
// Sheet ("Forthright Website Leads - Backup") via an Apps Script webhook,
// independent of JobTread, so a lead is always recoverable even when the
// CRM push breaks. Fire-and-forget: a webhook failure must never block or
// fail the lead.
const SHEET_WEBHOOK =
  process.env.SHEET_WEBHOOK_URL ||
  "https://script.google.com/macros/s/AKfycbzugtzFawSWelo3-uDHsYYrWfSPOrIlJxv09inPh-dmOBGhGVrAR3yH5dWrSsgbXJOFRg/exec";

function formName(note) {
  const n = note || "";
  if (n.startsWith("Source: Roofing Estimate Tool")) return "Instant Estimate";
  if (n.startsWith("Beat-Any-Estimate")) return "5% Off";
  if (n.startsWith("Hula")) return "HULA";
  return "Website";
}

async function backupToSheet(p, fullAddress) {
  try {
    await fetch(SHEET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "manual", // Apps Script 302s after executing; no need to follow
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({
        form: formName(p.note),
        firstname: p.firstname || "",
        lastname: p.lastname || "",
        email: p.email || "",
        phone: p.phone || "",
        address: fullAddress,
        howHeard: p.howHeard || "",
        attribution: p.attribution || "",
      }),
    });
  } catch (err) {
    console.error("instant-estimate: sheet backup failed:", err.message);
  }
}

// JobTread custom field IDs
const CF = {
  CONTACT_EMAIL: "22PWNRRPMVk4", // customerContact
  CONTACT_PHONE: "22PWNRRPPj9m", // customerContact
  LEAD_SOURCE: "22PWNRRPJWZZ", // customer
  // SMS_CONSENT (was 22PbJEtbLhJQ) removed 2026-07-29: the field was deleted
  // in JobTread, which made createAccount 400 and destroy every instant
  // estimate lead. SMS consent still reaches JobTread inside the note ->
  // Project Details. Only restore with a verified live field ID.
  ATTRIBUTION: "22PbJMZYZU3t", // customer
  JOB_STATUS: "22PWNRRPQrqe", // job
  JOB_TRADE: "22PbMPk2X4Uu", // job
  JOB_DETAILS: "22PbMQCpVRmv", // job (Project Details)
  JOB_SUBTRADE: "22Pb5DsDSgq9", // job (Subtrade Type)
  JOB_SALES_REP: "22PbFE4kMzTE", // job (Sales Rep, required picklist)
  JOB_TYPE: "22PbMQ8G6wMy", // job (Job Type picklist: Residential/Commercial/Property Management)
  JOB_LEAD_SOURCE: "22PbsL2APXu5", // job (Lead Source picklist)
  JOB_ATTRIBUTION: "22PbsQTCbbmz", // job (Attribution, free text)
};

// Dropdown custom fields reject values that aren't configured options, so map
// form values onto the live option lists and omit anything that doesn't match.
const TRADE_MAP = {
  Roofing: "Roofing",
  Siding: "Siding",
  Deck: "Decks",
  Decks: "Decks",
  Gutters: "Other",
  Other: "Other",
};
const LEAD_SOURCE_MAP = {
  "Google Search": "Google",
  Referral: "Referral",
};
// Job-level Lead Source has its own option list (Google, Social Media,
// Front Porch Forum, Trucks/Signs, Event, Referral, Other). Per Carl (8/4):
// Lead Source is the customer's own how-did-you-hear answer ONLY — the
// technical click ID belongs in Attribution, never inferred into Lead Source.
const JOB_LEAD_SOURCE_MAP = {
  "Google Search": "Google",
  Referral: "Referral",
  Radio: "Other",
  HULA: "Other",
  Other: "Other",
};
function jobLeadSource(p) {
  return JOB_LEAD_SOURCE_MAP[p.howHeard] || "";
}
// Verified against JobTread Settings > Custom Fields > Subtrade Type on
// 2026-08-03. Full live option list:
//   Asphalt Roofing, Standing Seam Roofing, EPDM Roofing, Vinyl Siding,
//   LP Siding, Hardie Siding, Window/Door Replacement, Deck,
//   Construction/Addition, Maintenance / Repair
// The previous values ("Asphalt Roof Replacement" / "Standing Seam Roof
// Replacement") were never valid options, so JobTread rejected createJob and
// every instant estimate landed as a customer with no job.
const SUBTRADE_MAP = {
  "Architectural Shingles": "Asphalt Roofing",
  "Standing Seam Metal": "Standing Seam Roofing",
};
// Subtrade Type is NOT required in JobTread ("Require a value" is off), so
// omitting it is always safe. Only set it where the form gives an honest
// answer; never guess.
const SUBTRADE_BY_PROJECT = { Deck: "Deck", Decks: "Deck" };

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

// JobTread custom fields get deleted/renamed without notice (3 breaks in 8
// days as of 2026-07-29), and a single dead field ID in a create call used to
// destroy the whole lead. When Pave rejects a call naming a field it can't
// find (or a value that's no longer a valid option), drop that field and
// retry with the rest.
const DEAD_FIELD_RE = /Could not find custom field with ID or name "([^"]+)"/;
// JobTread also rejects dropdown values that aren't configured options. This
// killed every asphalt-shingle job from the instant estimate until 8/3, because
// the message wording differs from the missing-field one above and fell through
// to the job-skip catch.
const BAD_OPTION_RE = /"([^"]+)" is not a valid option for the "([^"]+)" custom field/;
async function paveDroppingDeadFields(buildQuery, fields) {
  const cfv = { ...fields };
  for (let i = 0; i <= Object.keys(fields).length; i++) {
    try {
      return await pave(buildQuery(cfv));
    } catch (err) {
      const dead = err.message.match(DEAD_FIELD_RE);
      if (dead && dead[1] in cfv) {
        console.error(`instant-estimate: dropping dead custom field ${dead[1]} and retrying`);
        delete cfv[dead[1]];
        continue;
      }
      // The error names the rejected VALUE and the field's DISPLAY name, not
      // the field ID, so match on the value to work out which key to drop.
      const bad = err.message.match(BAD_OPTION_RE);
      if (bad) {
        const key = Object.keys(cfv).find((k) => cfv[k] === bad[1]);
        if (key) {
          console.error(`instant-estimate: dropping invalid option "${bad[1]}" for field "${bad[2]}" (${key}) and retrying`);
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

  const firstname = (p.firstname || "").trim();
  const lastname = (p.lastname || "").trim();
  const email = (p.email || "").trim();
  const phone = (p.phone || "").trim();
  if (!lastname || (!email && !phone)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "missing required fields" }) };
  }

  const fullAddress = [p.address, p.city, p.state, p.zip].filter(Boolean).join(", ");
  const streetLine = (p.address || "").split(",")[0].trim().slice(0, 30);

  // Backup first, so the sheet catches the lead even if JobTread rejects it.
  await backupToSheet(p, fullAddress);

  const customerFields = {
    [CF.LEAD_SOURCE]: LEAD_SOURCE_MAP[p.howHeard] || "",
    [CF.ATTRIBUTION]: p.attribution || "",
  };
  for (const k of Object.keys(customerFields)) if (!customerFields[k]) delete customerFields[k];

  const jobFields = {
    [CF.JOB_STATUS]: "New Lead",
    [CF.JOB_TRADE]: TRADE_MAP[p.trade || p.projectType] || "",
    [CF.JOB_DETAILS]: p.note || "",
    [CF.JOB_SUBTRADE]: SUBTRADE_MAP[p.roofMaterial] || SUBTRADE_BY_PROJECT[p.projectType] || "",
    [CF.JOB_SALES_REP]: "Carl Grumbine",
    [CF.JOB_TYPE]: "Residential",
    [CF.JOB_LEAD_SOURCE]: jobLeadSource(p),
    [CF.JOB_ATTRIBUTION]: p.attribution || "",
  };
  for (const k of Object.keys(jobFields)) if (!jobFields[k]) delete jobFields[k];

  try {
    // Per Carl (7/21): always create a new customer (no dedup), named "Firstname Lastname".
    // JobTread rejects duplicate customer names, so on collision append (2), (3), ... —
    // duplicates stay visible for the team to handle internally, but no lead is ever lost.
    const baseName = [firstname, lastname].filter(Boolean).join(" ") || "Website Lead";
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
          // Last resort: a customer with core contact data only still beats a
          // destroyed lead. (Not for name collisions — those need a new name.)
          if (/already exists/i.test(err.message)) throw err;
          console.error("instant-estimate: createAccount failed with custom fields, retrying bare:", err.message.slice(0, 200));
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
        $: { accountId, name: [firstname, lastname].filter(Boolean).join(" "), ...(Object.keys(cfv).length && { customFieldValues: cfv }) },
        createdContact: { id: {} },
      },
    }), contactCfv);

    // Job creation needs a location, so create one even when no address was
    // given rather than dropping the job.
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
      // Job-level required fields (Trade / Subtrade Type) can be unsatisfiable
      // for forms that don't collect them. The customer is already in
      // JobTread at this point — keep the lead, skip the job.
      console.error("instant-estimate: job creation skipped:", err.message);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, result: "created", accountId, jobId }) };
  } catch (err) {
    console.error("instant-estimate error:", err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: "jobtread-push-failed" }) };
  }
};
