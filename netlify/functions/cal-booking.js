// Called from roofing-estimate.html when a Cal.com site-visit booking succeeds.
// Flips the JobTread job (created moments earlier by instant-estimate) to
// "Appointment Set" and appends the visit time to Project Details.
//
// Best-effort by design: the visitor already sees the booking confirmation
// before this runs, so any failure here is logged and returns 200 — it must
// never surface as a broken booking. The booking itself lives in Cal.com
// regardless of what happens to the JobTread record.

const PAVE_URL = "https://api.jobtread.com/pave";
const CF = {
  JOB_STATUS: "22PWNRRPQrqe",
  JOB_DETAILS: "22PbMQCpVRmv", // Project Details
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
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "POST only" }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "bad JSON" }) };
  }

  const { jobId, name, start, title } = payload;
  if (!jobId) {
    // No job to update (submitForm response wasn't captured) — nothing to do.
    console.log("cal-booking: no jobId in payload", JSON.stringify(payload).slice(0, 300));
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: "no jobId" }) };
  }

  try {
    // Read current Project Details so the appointment note appends, not clobbers.
    let existingDetails = "";
    try {
      const jobRead = await pave({
        job: { $: { id: jobId }, id: {}, customFieldValues: { nodes: { customField: { id: {} }, value: {} } } },
      });
      const nodes = (((jobRead.job || {}).customFieldValues || {}).nodes) || [];
      const detailsNode = nodes.find((n) => n.customField && n.customField.id === CF.JOB_DETAILS);
      if (detailsNode && detailsNode.value) existingDetails = String(detailsNode.value);
    } catch (e) {
      console.log("cal-booking: details read failed, appending blind:", e.message);
    }

    const when = start ? new Date(start).toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    }) : "(time not captured)";
    const note = `Site visit booked via Cal.com: ${when}${title ? ` (${title})` : ""}${name ? ` — ${name}` : ""}`;
    const details = existingDetails ? `${existingDetails}\n${note}` : note;

    await pave({
      updateJob: {
        $: {
          id: jobId,
          customFieldValues: { [CF.JOB_STATUS]: "Appointment Set", [CF.JOB_DETAILS]: details },
        },
      },
    });

    console.log(`cal-booking: job ${jobId} -> Appointment Set (${when})`);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("cal-booking failed:", err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
