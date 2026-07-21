// Instant Estimate -> JobTread
// Creates a JobTread customer (account + contact + location + custom fields)
// from the roofing estimate tool. Dedupes by email/phone so repeat submitters
// update their existing customer instead of creating a duplicate.

const ORG_ID = "22PWNQm4MwfM";
const PAVE_URL = "https://api.jobtread.com/pave";

// JobTread custom field IDs (targetType: customer unless noted)
const CF = {
  CONTACT_EMAIL: "22PWNRRPMVk4", // customerContact
  CONTACT_PHONE: "22PWNRRPPj9m", // customerContact
  TELL_US: "22PbFDfMUfzU",
  HOME_TYPE: "22PbJEtVzgn3",
  ROOF_MATERIAL: "22PbJEtX5gy3",
  HOME_SIZE: "22PbJEtY8BZQ",
  TIMELINE: "22PbJEtZ9tM5",
  ESTIMATE_RANGE: "22PbJEtaHNyE",
  SMS_CONSENT: "22PbJEtbLhJQ",
  ATTRIBUTION: "22PbJMZYZU3t",
};

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
  const streetLine = (p.address || "").split(",")[0].trim().slice(0, 30) || "Home";

  const customerFields = {
    [CF.HOME_TYPE]: p.homeType || "",
    [CF.ROOF_MATERIAL]: p.roofMaterial || "",
    [CF.HOME_SIZE]: p.homeSize || "",
    [CF.TIMELINE]: p.timeline || "",
    [CF.ESTIMATE_RANGE]: p.estimateRange || "",
    ...(p.smsConsent !== undefined && { [CF.SMS_CONSENT]: p.smsConsent ? "Yes" : "No" }),
    [CF.TELL_US]: p.note || "",
    [CF.ATTRIBUTION]: p.attribution || "",
  };
  // drop empties so we never blank an existing value on dedup-update
  for (const k of Object.keys(customerFields)) if (!customerFields[k]) delete customerFields[k];

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
            $: { organizationId: ORG_ID, name: acctName, type: "customer", customFieldValues: customerFields },
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

    if (fullAddress) {
      await pave({ createLocation: { $: { accountId, address: fullAddress, name: streetLine }, createdLocation: { id: {} } } });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, result: "created", accountId }) };
  } catch (err) {
    console.error("instant-estimate error:", err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: "jobtread-push-failed" }) };
  }
};
