// netlify/functions/create-checkout-link.js
const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN"; // ה־ID שנתת
const TAX_PERCENT = "8.875"; // אחוז מס בסקוור
const DAILY_LIMIT = 250;     // מקסימום דונאטס ליום

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
 * מחזיר תחום שעות (start_at / end_at) ליום מסוים לפי America/New_York
 */
function buildNYDayRange(dateStr) {
  // dateStr בפורמט YYYY-MM-DD
  const start = `${dateStr}T00:00:00-05:00`;
  const end = `${dateStr}T23:59:59-05:00`;
  return { start, end };
}

/**
 * סופר כמה דונאטס כבר מוזמנים ליום נתון (לפי fulfillment pickup_at)
 */
async function getExistingQtyForDate(pickupDate) {
  if (!pickupDate) return 0;

  const { start, end } = buildNYDayRange(pickupDate);

  const body = {
    location_ids: [LOCATION_ID],
    query: {
      filter: {
        fulfillment_filter: {
          fulfillment_types: ["PICKUP"],
          fulfillment_states: [
            "PROPOSED",
            "RESERVED",
            "PREPARED",
            "COMPLETED",
          ],
        },
        fulfillment_time_filter: {
          fulfillment_at: {
            start_at: start,
            end_at: end,
          },
        },
      },
    },
    limit: 100,
  };

  let cursor = null;
  let totalQty = 0;

  do {
    const res = await callSquare(
      "/v2/orders/search",
      "POST",
      cursor ? { ...body, cursor } : body
    );

    if (res.statusCode >= 400 || res.body.errors) {
      console.error("SearchOrders error:", res.body);
      // במקרה כזה נחזור 0 כדי לא לחסום הזמנה בגלל באג חיצוני
      // אם תרצה אפשר להפוך את זה ל־error חזק
      return 0;
    }

    const orders = res.body.orders || [];
    for (const order of orders) {
      const lineItems = order.line_items || [];
      for (const li of lineItems) {
        // מדלגים על שורת INFO (0 דולר) וסופרים כל מה שיש לו מחיר > 0
        const amount = li.base_price_money?.amount ?? 0;
        if (amount > 0) {
          const q = parseInt(li.quantity || "0", 10);
          if (!isNaN(q)) totalQty += q;
        }
      }
    }

    cursor = res.body.cursor || null;
  } while (cursor);

  return totalQty;
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
      pickupTime,       // "10:00 - 11:00"
      pickupWindow,     // { from: "10:00", to: "11:00" }
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

    // כמות דונאטס בהזמנה הנוכחית
    const currentQty = cartItems.reduce((sum, item) => {
      const q = parseInt(item.quantity || 0, 10);
      return sum + (isNaN(q) ? 0 : q);
    }, 0);

    // אם יש תאריך – בודקים כמה כבר מוזמן ליום הזה
    if (pickupDate) {
      const existing = await getExistingQtyForDate(pickupDate);
      const combined = existing + currentQty;

      if (combined > DAILY_LIMIT) {
        const remaining = Math.max(DAILY_LIMIT - existing, 0);
        const msg =
          remaining > 0
            ? `We only have ${remaining} donuts left for this day. Please reduce your quantity or choose another date.`
            : `We’re fully booked for this day. Please choose another date.`;

        return {
          statusCode: 400,
          body: JSON.stringify({ error: msg }),
        };
      }
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

      pickupLabel = `Pickup: ${weekday}, ${niceDate} (${pickupTime.replace(
        "-",
        "–"
      )})`;

      const fromStr =
        (pickupWindow && pickupWindow.from) ||
        (pickupTime.match(/^(\d{2}:\d{2})/)
          ? pickupTime.match(/^(\d{2}:\d{2})/)[1]
          : "10:00");

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

    /* ---------- שורות מוצרים ---------- */
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: Math.round(item.unitAmountCents), // לפני מס
        currency,
      },
    }));

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
