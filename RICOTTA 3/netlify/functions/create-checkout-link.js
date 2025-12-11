// netlify/functions/create-checkout-link.js
const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";

const TAX_PERCENT = "8.875";    // אחוז מס בסקוור (טקסט)
const DAILY_LIMIT = 250;        // 250 סופגניות ליום

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

/**
 * סופר כמה סופגניות כבר "נתפסו" ליום מסוים,
 * לפי הזמנות COMPLETED בלבד בסקוור.
 */
async function countDonutsForDate(pickupDate, currency = "USD") {
  let allOrders = [];
  let cursor = null;

  do {
    const body = {
      location_ids: [LOCATION_ID],
      query: {
        filter: {
          state_filter: {
            states: ["COMPLETED"],   // רק הזמנות שהושלמו
          },
        },
      },
      cursor: cursor || undefined,
    };

    const result = await callSquare("/v2/orders/search", "POST", body);

    if (result.statusCode >= 400 || result.body.errors) {
      console.error("Square search error:", result.body);
      throw new Error(
        result.body.errors?.[0]?.detail ||
          "Error searching orders from Square"
      );
    }

    const orders = result.body.orders || [];
    allOrders = allOrders.concat(orders);
    cursor = result.body.cursor || null;
  } while (cursor);

  // עוברים על כל ההזמנות שה־pickup שלהן לאותו תאריך
  let totalDonuts = 0;

  for (const order of allOrders) {
    const fulfill = (order.fulfillments && order.fulfillments[0]) || null;
    const pickupAt = fulfill?.pickup_details?.pickup_at || null;
    if (!pickupAt) continue;

    const orderPickupDate = pickupAt.slice(0, 10); // yyyy-mm-dd
    if (orderPickupDate !== pickupDate) continue;

    for (const li of order.line_items || []) {
      if (li.name === "Pickup Details") continue; // שורת מידע
      const q = parseInt(li.quantity || "0", 10);
      if (!isNaN(q)) totalDonuts += q;
    }
  }

  return totalDonuts;
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
      pickupTime,      // "10:00 - 11:00"
      pickupWindow,    // { from: "10:00", to: "11:00" }
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

    if (!pickupDate || !pickupTime) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "pickupDate and pickupTime are required" }),
      };
    }

    // 1) כמה סופגניות הלקוח הזה מבקש בעסקה הזו
    let requestedDonuts = 0;
    for (const item of cartItems) {
      const q = parseInt(item.quantity || 0, 10);
      if (!isNaN(q)) requestedDonuts += q;
    }

    // 2) כמה כבר נתפס באותו יום לפי הזמנות ששולמו (COMPLETED)
    const alreadyUsed = await countDonutsForDate(pickupDate, currency);
    const afterOrder = alreadyUsed + requestedDonuts;

    if (afterOrder > DAILY_LIMIT) {
      const remaining = Math.max(DAILY_LIMIT - alreadyUsed, 0);
      return {
        statusCode: 400,
        body: JSON.stringify({
          error:
            remaining > 0
              ? `We only have ${remaining} donuts left for this day. Please reduce your quantity or choose another date.`
              : `We’re fully booked for this day. Please choose another date.`,
        }),
      };
    }

    /* ---------- תיאור איסוף לטיקט ---------- */
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

      pickupLabel = `Pickup: ${weekday}, ${niceDate} (${pickupTime.replace("-", "–")})`;

      const fromStr =
        (pickupWindow && pickupWindow.from) ||
        (pickupTime.match(/^(\d{2}:\d{2})/)
          ? pickupTime.match(/^(\d{2}:\d{2})/)[1]
          : "10:00");

      pickupAt = `${pickupDate}T${fromStr}:00-05:00`; // America/New_York
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

    /* ---------- שורות מוצרים ---------- */
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: Math.round(item.unitAmountCents), // לפני מס
        currency,
      },
    }));

    // שורת מידע באפס דולר
    if (infoText) {
      lineItems.push({
        name: "Pickup Details",
        quantity: "1",
        base_price_money: { amount: 0, currency },
        note: infoText,
      });
    }

    /* ---------- Fulfillment לדשבורד ---------- */
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

    /* ---------- TAX אמיתי בסקוור ---------- */
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
      body: JSON.stringify({ error: err.message || "Unexpected server error" }),
    };
  }
};
