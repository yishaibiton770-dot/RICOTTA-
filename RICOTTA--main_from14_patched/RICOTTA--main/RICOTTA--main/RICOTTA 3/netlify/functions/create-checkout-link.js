// netlify/functions/create-checkout-link.js
const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";
const SQUARE_ENV = process.env.SQUARE_ENV || "production"; // "sandbox" | "production"

const SQUARE_HOST =
  SQUARE_ENV === "sandbox"
    ? "connect.squareupsandbox.com"
    : "connect.squareup.com";

// מס בסקוור
const TAX_PERCENT = "8.875";

// מקסימום סופגניות ליום
const DAILY_LIMIT = 250;

/* ------------------ עוזר: URL בסיס לאתר ------------------ */
function getSiteBaseUrl(event, redirectUrlBase) {
  if (redirectUrlBase && /^https?:\/\//i.test(redirectUrlBase)) {
    return redirectUrlBase.replace(/\/+$/, "");
  }
  const proto = event.headers["x-forwarded-proto"] || "https";
  const host = event.headers.host;
  return `${proto}://${host}`;
}

/* ------------------ קריאה ל-Square ------------------ */
function callSquare(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const options = {
      hostname: SQUARE_HOST,
      path,
      method,
      headers: {
        "Square-Version": "2025-01-15",
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          json = { raw: data };
        }
        resolve({ statusCode: res.statusCode, body: json });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ------------------ בדיקת מלאי יומי ------------------ */
async function getUsedUnitsForDate(pickupDate) {
  if (!pickupDate) return 0;

  const start_at = `2025-11-01T00:00:00-05:00`;
  const end_at = `2026-01-15T23:59:59-05:00`;

  const body = {
    location_ids: [LOCATION_ID],
    query: {
      filter: {
        state_filter: { states: ["COMPLETED"] },
        date_time_filter: {
          created_at: { start_at, end_at },
        },
      },
    },
  };

  const result = await callSquare("/v2/orders/search", "POST", body);

  if (result.statusCode >= 400 || result.body.errors) {
    console.error("Square inventory error:", result.body);
    throw new Error("Error checking daily inventory from Square");
  }

  const orders = result.body.orders || [];
  let totalUnits = 0;

  for (const order of orders) {
    const fulfill = order.fulfillments?.[0];
    const pickupAt = fulfill?.pickup_details?.pickup_at;
    if (!pickupAt) continue;

    if (pickupAt.slice(0, 10) !== pickupDate) continue;

    let sold = 0;
    for (const li of order.line_items || []) {
      if (li.name === "Pickup Details") continue;
      const q = parseInt(li.quantity || "0", 10);
      if (!isNaN(q)) sold += q;
    }

    let returned = 0;
    for (const ret of order.returns || []) {
      for (const rli of ret.return_line_items || []) {
        if (rli.name === "Pickup Details") continue;
        const rq = parseInt(rli.quantity || "0", 10);
        if (!isNaN(rq)) returned += rq;
      }
    }

    const net = sold - returned;
    if (net > 0) totalUnits += net;
  }

  return totalUnits;
}

/* ------------------ HANDLER ------------------ */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return { statusCode: 500, body: "Missing SQUARE_ACCESS_TOKEN" };
  }

  try {
    const payload = JSON.parse(event.body || "{}");

    const {
      cartItems,
      currency = "USD",
      redirectUrlBase,
      pickupDate,
      pickupTime,
      pickupWindow,
      customerName,
      customerPhone,
      customerEmail,
      notes,
    } = payload;

    if (!cartItems || !cartItems.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "cartItems required" }) };
    }

    if (!pickupDate) {
      return { statusCode: 400, body: JSON.stringify({ error: "pickupDate required" }) };
    }

    const requestedUnits = cartItems.reduce(
      (s, i) => s + parseInt(i.quantity || 0, 10),
      0
    );

    const alreadyUsed = await getUsedUnitsForDate(pickupDate);
    const remaining = DAILY_LIMIT - alreadyUsed;

    if (requestedUnits > remaining) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error:
            remaining > 0
              ? `Only ${remaining} donuts left for this day.`
              : "This day is fully booked.",
        }),
      };
    }

    /* ---------- pickup info ---------- */
    let pickupAt = null;
    let pickupLabel = "";

    if (pickupDate && pickupTime) {
      const d = new Date(pickupDate + "T12:00:00");
      pickupLabel = `Pickup: ${d.toDateString()} (${pickupTime})`;

      const fromStr =
        pickupWindow?.from ||
        pickupTime.match(/^(\d{2}:\d{2})/)?.[1] ||
        "10:00";

      pickupAt = `${pickupDate}T${fromStr}:00-05:00`;
    }

    const infoText = [
      pickupLabel,
      customerName && `Name: ${customerName}`,
      customerPhone && `Phone: ${customerPhone}`,
      customerEmail && `Email: ${customerEmail}`,
      notes && `Notes: ${notes}`,
    ]
      .filter(Boolean)
      .join("\n");

    /* ---------- line items ---------- */
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: Math.round(item.unitAmountCents),
        currency,
      },
    }));

    const order = {
      location_id: LOCATION_ID,
      line_items: lineItems,
      taxes: [
        {
          uid: "default-tax",
          name: "Sales Tax",
          type: "ADDITIVE",
          scope: "ORDER",
          percentage: TAX_PERCENT,
        },
      ],
    };

    if (pickupAt) {
      order.fulfillments = [
        {
          type: "PICKUP",
          state: "PROPOSED",
          pickup_details: {
            schedule_type: "SCHEDULED",
            pickup_at: pickupAt,
            note: infoText,
            recipient: {
              display_name: customerName || "",
              phone_number: customerPhone || "",
              email_address: customerEmail || "",
            },
          },
        },
      ];
    }

    const siteBase = getSiteBaseUrl(event, redirectUrlBase);

    const body = {
      idempotency_key: crypto.randomBytes(16).toString("hex"),
      order,
      checkout_options: {
        redirect_url: `${siteBase}/success.html`,
      },
    };

    const result = await callSquare(
      "/v2/online-checkout/payment-links",
      "POST",
      body
    );

    if (result.statusCode >= 400 || result.body.errors) {
      console.error("Square error:", result.body);
      return {
        statusCode: 400,
        body: JSON.stringify({
          error:
            result.body.errors?.[0]?.detail ||
            "Error creating Square payment link",
        }),
      };
    }

    return { statusCode: 200, body: JSON.stringify(result.body) };
  } catch (err) {
    console.error("Function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Server error" }),
    };
  }
};
