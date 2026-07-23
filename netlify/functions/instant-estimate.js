// Website forms -> JobTread
// Creates a JobTread customer (account + contact + location) AND a job from
// the instant estimate tool and the beat-any-estimate / hula landing pages.
// Per Carl (7/22, after JobTread's CRM recommendations): jobs are created on
// every form fill, with project answers mapped to job-level custom fields.

const ORG_ID = "22PWNQm4MwfM";
const PAVE_URL = "https://api.jobtread.com/pave";

// JobTread custom field IDs
const CF = {
  CONTACT_EMAIL: "22PWNRRPMVk4", // customerContact
  CONTACT_PHONE: "22PWNRRPPj9m", // customerContact
  LEAD_SOURCE: "22PWNRRPJWZZ", // customer
  SMS_CONSENT: "22PbJEtbLhJQ", // customer
  ATTRIBUTION: "22PbJMZYZU3t", // customer
  JOB_STATUS: "22PWNRRPQrqe", // job
  JOB_TRADE: "22PbMPk2X4Uu", // job
  JOB_DETAILS: "22PbMQCpVRmv", // job (Project Details)
  JOB_SUBTRADE: "22Pb5DsDSgq9", // job (Subtrade Type)
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
const SUBTRADE_MAP = {
  "Architectural Shingles": "Asphalt Roof Replacement",
  "Standing Seam Metal": "Standing Seam Roof Replacement",
};
// Subtrade Type is a REQUIRED job field but only the instant estimate (roof
// material) and a Deck project type give us an honest value. Anything else
// gets no subtrade guess; if JobTread then rejects the job, we fall back to
// customer-only rather than fabricating data or losing the lead.
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

  const customerFields = {
    [CF.LEAD_SOURCE]: LEAD_SOURCE_MAP[p.howHeard] || "",
    ...(p.smsConsent !== undefined && { [CF.SMS_CONSENT]: p.smsConsent ? "Yes" : "No" }),
    [CF.ATTRIBUTION]: p.attribution || "",
  };
  for (const k of Object.keys(customerFields)) if (!customerFields[k]) delete customerFields[k];

  const jobFields = {
    [CF.JOB_STATUS]: "New Lead",
    [CF.JOB_TRADE]: TRADE_MAP[p.trade || p.projectType] || "",
    [CF.JOB_DETAILS]: p.note || "",
    [CF.JOB_SUBTRADE]: SUBTRADE_MAP[p.roofMaterial] || SUBTRADE_BY_PROJECT[p.projectType] || "",
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
        const created = await pave({
          createAccount: {
            $: { organizationId: ORG_ID, name: acctName, type: "customer", ...(Object.keys(customerFields).length && { customFieldValues: customerFields }) },
            createdAccount: { id: {} },
          },
        });
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
    await pave({
      createContact: {
        $: { accountId, name: [firstname, lastname].filter(Boolean).join(" "), ...(Object.keys(contactCfv).length && { customFieldValues: contactCfv }) },
        createdContact: { id: {} },
      },
    });

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
      const job = await pave({
        createJob: {
          $: { locationId, name: streetLine || baseName, ...(Object.keys(jobFields).length && { customFieldValues: jobFields }) },
          createdJob: { id: {} },
        },
      });
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
