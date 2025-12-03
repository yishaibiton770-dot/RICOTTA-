// netlify/functions/create-checkout-link.js
const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";
const TAX_PERCENT = "8.875"; // אחוז מס בסקוור

// --- Supabase ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DAILY_LIMIT = 250; // 250 סופגניות ליום

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

// קריאה ל-Supabase
async function getDailyInventory(pickupDate) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Missing Supabase config");
  }

  const url =
    `${SUPABASE_URL}/rest/v1/daily_inventory` +
    `?select=total_donuts&date=eq.${pickupDate}`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("Supabase error (getDailyInventory):", txt);
    throw new Error("Inventory check failed");
  }

  const rows = await res.json();
  if (!rows.length) {
    return 0;
  }
  return rows[0].total_donuts || 0;
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
      customerName,
      customerPhone,
      customerEmail,
      notes,
    } = payload;

    if (!cartItems || !cartItems.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "cartItems is required" }),
      };
    }

    if (!pickupDate) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "pickupDate is required" }),
      };
    }

    // כמה סופגניות הלקוח הזה רוצה
    const donutsRequested = cartItems.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );

    if (!donutsRequested || donutsRequested <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid quantity" }),
      };
    }

    // ✅ בדיקה מול DB – כמה סופגניות **שולמו** כבר ליום הזה
    try {
      const alreadyPaid = await getDailyInventory(pickupDate);
      const remaining = DAILY_LIMIT - alreadyPaid;

      if (remaining <= 0) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "We’re fully booked for this day. Please choose another date.",
          }),
        };
      }

      if (donutsRequested > remaining) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: `Only ${remaining} donuts left for this day. Please reduce quantity or choose another date.`,
          }),
        };
      }
    } catch (e) {
      console.error("Inventory check failed:", e);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error:
            "There was a problem checking availability. Please try again in a minute.",
        }),
      };
    }

    // ---------- תיאור איסוף לטיקט ----------
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

      const fromMatch = pickupTime.match(/^(\d{2}:\d{2})/);
      const fromStr = fromMatch ? fromMatch[1] : "10:00";

      pickupAt = `${pickupDate}T${fromStr}:00-05:00`; // ניו יורק
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

    // ---------- שורות מוצרים ----------
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: Math.round(item.unitAmountCents), // לפני מס
        currency,
      },
    }));

    // שורת מידע באפס דולר שתופיע בטיקט הגדול / ריפאנד
    if (infoText) {
      lineItems.push({
        name: "Pickup Details",
        quantity: "1",
        base_price_money: { amount: 0, currency },
        note: infoText,
      });
    }

    // ---------- Fulfillment לדשבורד ----------
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

    // ---------- TAX אמיתי בסקוור ----------
    const order = {
      location_id: LOCATION_ID,
      line_items: lineItems,
      taxes: [
        {
          uid: "default-tax",
          name: "Sales Tax",
          type: "ADDITIVE",
          scope: "ORDER",
          percentage: TAX_PERCENT, // 8.875%
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
      body: JSON.stringify({ error: err.message || "Unexpected server error" }),
    };
  }
};
