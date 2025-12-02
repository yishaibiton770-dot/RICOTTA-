// netlify/functions/create-checkout-link.js

const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || ""; // שים פה ידנית אם אין env

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
      pickupTime, // למשל "10:00 - 11:00"
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

    /* -----------------------------
       בניית תיאור איסוף
    ------------------------------ */
    let windowText = "";
    let pickupAt = null;

    if (pickupDate && pickupTime) {
      windowText = `${pickupDate} (${pickupTime})`;

      // נחלץ את שעת ההתחלה (לדוגמה "10:00")
      const fromMatch = pickupTime.match(/^(\d{2}:\d{2})/);
      if (fromMatch) {
        const from = fromMatch[1]; // HH:MM
        // אזור זמן ניו יורק –5 שעות
        pickupAt = `${pickupDate}T${from}:00-05:00`;
      }
    } else if (pickupDate) {
      windowText = pickupDate;
    }

    const infoParts = [
      customerName ? `Name: ${customerName}` : "",
      customerPhone ? `Phone: ${customerPhone}` : "",
      customerEmail ? `Email: ${customerEmail}` : "",
      notes ? `Notes: ${notes}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    /* -----------------------------
       שורות מוצרים
    ------------------------------ */
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: Math.round(item.unitAmountCents),
        currency,
      },
    }));

    // שורת INFO ב־$0 שתופיע על הטיקט הקטן
    if (windowText || infoParts) {
      lineItems.push({
        name: `Pickup ${windowText}`,
        quantity: "1",
        base_price_money: { amount: 0, currency },
        note: infoParts,
      });
    }

    /* -----------------------------
       Fulfillment (כדי שיראו בדשבורד)
    ------------------------------ */
    const fulfillments = pickupAt
      ? [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickup_details: {
              schedule_type: "SCHEDULED",
              pickup_at: pickupAt,
              note: `Pickup ${windowText}${infoParts ? " | " + infoParts : ""}`,
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
    };

    if (fulfillments) {
      order.fulfillments = fulfillments;
    }

    const body = {
      idempotency_key: crypto.randomBytes(16).toString("hex"),
      order,
      checkout_options: {
        redirect_url: `${redirectUrlBase || ""}/thanks.html`,
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
