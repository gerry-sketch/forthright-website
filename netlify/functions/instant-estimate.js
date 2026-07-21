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

const digits = (s) => (s || "").replace(/\D/g, "");

// Find an existing customer by contact email or phone.
async function findExistingCustomer(email, phone) {
  const wantEmail = (email || "").trim().toLowerCase();
  const wantPhone = digits(phone);
  let page = null;
  while (true) {
    const sel = { size: 25, ...(page && { page }) }; // >25 with nested contacts trips Pave's 413 limit
    const r = await pave({
      organization: {
        $: { id: ORG_ID },
        accounts: {
          $: sel,
          nextPage: {},
          nodes: {
            id: {}, name: {}, type: {},
            contacts: { nodes: { id: {}, name: {}, customFieldValues: { nodes: { value: {}, customField: { id: {} } } } } },
          },
        },
      },
    });
    const accounts = r.organization.accounts;
    for (const acct of accounts.nodes) {
      if (acct.type !== "customer") continue;
      for (const contact of (acct.contacts?.nodes || [])) {
        for (const cfv of (contact.customFieldValues?.nodes || [])) {
          const v = String(cfv.value || "");
          if (cfv.customField.id === CF.CONTACT_EMAIL && wantEmail && v.trim().toLowerCase() === wantEmail) return acct;
          if (cfv.customField.id === CF.CONTACT_PHONE && wantPhone && digits(v) === wantPhone) return acct;
        }
      }
    }
    page = accounts.nextPage;
    if (!page) break;
  }
  return null;
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
    const existing = await findExistingCustomer(email, phone);

    if (existing) {
      // Update estimate fields on the existing customer; add location (JT dedupes by address).
      await pave({ updateAccount: { $: { id: existing.id, customFieldValues: customerFields } } });
      if (fullAddress) {
        try {
          await pave({ createLocation: { $: { accountId: existing.id, address: fullAddress, name: streetLine }, createdLocation: { id: {} } } });
        } catch (e) { /* duplicate address is fine */ }
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, result: "updated-existing", accountId: existing.id }) };
    }

    // New customer
    const acctName = lastname ? `${lastname} Household` : `${firstname} Household`;
    const created = await pave({
      createAccount: {
        $: { organizationId: ORG_ID, name: acctName, type: "customer", customFieldValues: customerFields },
        createdAccount: { id: {} },
      },
    });
    const accountId = created.createAccount.createdAccount.id;

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
