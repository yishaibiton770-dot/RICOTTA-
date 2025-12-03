// netlify/functions/create-checkout-link.js
const https = require("https");
const crypto = require("crypto");

// ----- SQUARE -----
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";
const TAX_PERCENT = "8.875"; // אחוז מס בסקוור

// ----- SUPABASE (קריאה בלבד למלאי) -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// כמה סופגניות מותר ביום
const DAILY_LIMIT = 250;

function callSquare(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const options = {
      hostname: "connect.squareup.com",
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

// ----- כמה כבר "נצרך" ליום מסוים (סופגניות ששולמו) -----
async function getUsedQuantityForDate(dateStr) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("Supabase env not set, skipping availability check");
    return 0;
  }

  const url = `${SUPABASE_URL}/rest/v1/daily_inventory?date=eq.${dateStr}&select=used_quantity`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });

  const data = await res.json().catch(() => []);

  if (!res.ok) {
    console.error("Supabase error:", data);
    // אם יש בעיה ב־Supabase – לא לחסום לקוח, רק להחזיר 0
    return 0;
  }

  if (!Array.isArray(data) || data.length === 0) return 0;
  const row = data[0];
  return typeof row.used_quantity === "number" ? row.used_quantity : 0;
}

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
      pickupTime, // "10:00 - 11:00"
      pickupWindow, // אופציונלי לעתיד
      customerName,
      customerPhone,
      customerEmail,
      notes,
    } = payload;

    if (!cartItems || !cartItems.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Your box is empty." }),
      };
    }

    if (!pickupDate) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Pickup date is required." }),
      };
    }

    // ====== בדיקת מלאי יומי ב־Supabase ======
    const requestedQty = cartItems.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );

    const alreadyUsed = await getUsedQuantityForDate(pickupDate);
    const remaining = DAILY_LIMIT - alreadyUsed;

    if (remaining <= 0) {
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: "SOLD_OUT",
          message:
            "We’re fully booked for this day. Please choose another date.",
        }),
      };
    }

    if (requestedQty > remaining) {
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: "LIMIT_EXCEEDED",
          message: `We only have ${remaining} donuts left for this day. Please reduce the quantity or choose another date.`,
        }),
      };
    }

    // ====== מפה – אותו לוגיקה ישנה שעבדה לך ======
    let pickupLabel = "";
    let pickupAt = null;

    if (pickupDate && pickupTime) {
      const d = new Date(pickupDate + "T12:00:00");
      const weekday = d.toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: "America/New_York",
      });
      const niceDate = d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      });

      pickupLabel = `Pickup: ${weekday}, ${niceDate} (${pickupTime.replace(
        "-",
        "–"
      )})`;

      const fromStr =
        (pickupWindow && pickupWindow.from) ||
        (pickupTime.match(/^(\d{2}:\d{2})/)
          ? pickupTime.match(/^(\d{2}:\d{2})/)[1]
          : "10:00");

      pickupAt = `${pickupDate}T${fromStr}:00-05:00`;
    } else if (pickupDate) {
      pickupLabel = `Pickup: ${pickupDate}`;
    }

    const infoLines = [
      pickupLabel,
      customerName ? `Name: ${customerName}` : "",
      customerPhone ? `Phone: ${customerPhone}` : "",
      customerEmail ? `Email: ${customerEmail}` : "",
      notes ? `Notes: ${notes}` : "",
    ].filter(Boolean);

    const infoText = infoLines.join("\n");

    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: Math.round(item.unitAmountCents),
        currency,
      },
    }));

    const fulfillments = pickupAt
      ? [
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
        ]
      : undefined;

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

    if (fulfillments) {
      order.fulfillments = fulfillments;
    }

    const body = {
      idempotency_key: crypto.randomBytes(16).toString("hex"),
      order,
      checkout_options: {
        redirect_url: `${redirectUrlBase || ""}/success.html`,
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

    return {
      statusCode: 200,
      body: JSON.stringify(result.body),
    };
  } catch (err) {
    console.error("Function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message || "Unexpected server error",
      }),
    };
  }
};

