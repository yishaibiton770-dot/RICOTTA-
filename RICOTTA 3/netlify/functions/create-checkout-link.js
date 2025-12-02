// netlify/functions/create-checkout-link.js
const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

// ====== הגבלת מלאי לפי יום ======
const MAX_DAILY_LIMIT = 250;
// זיכרון זמני לפי תאריך: { '2025-12-15': 120, ... }
const dailyTotals = {};

// קריאה כללית ל־Square
function callSquare(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const postData = bodyObj ? JSON.stringify(bodyObj) : null;

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

    if (postData) {
      options.headers["Content-Length"] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        let json;
        try {
          json = data ? JSON.parse(data) : {};
        } catch (e) {
          json = { raw: data, parseError: e.message };
        }

        resolve({
          statusCode: res.statusCode,
          body: json,
        });
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

exports.handler = async (event) => {
  // מאפשרים רק POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  if (!SQUARE_ACCESS_TOKEN) {
    console.error("Missing SQUARE_ACCESS_TOKEN env var");
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server configuration error",
        detail: "Missing Square access token",
      }),
    };
  }

  try {
    const {
      cartItems,
      currency = "USD",
      redirectUrlBase,
      pickupDate,
      pickupTime,
      customerName,
      customerPhone,
      customerEmail,
      subtotalCents,
      taxCents,
      totalCents,
    } = JSON.parse(event.body || "{}");

    // ---- ולידציה בסיסית ----
    if (
      !cartItems ||
      !Array.isArray(cartItems) ||
      cartItems.length === 0 ||
      !redirectUrlBase ||
      !pickupDate
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing required fields",
        }),
      };
    }

    // ====== ❶ בדיקת מגבלת 250 סופגניות ליום ======
    const requestedQty = cartItems.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );

    const currentForDay = dailyTotals[pickupDate] || 0;
    const remaining = MAX_DAILY_LIMIT - currentForDay;

    if (requestedQty > remaining) {
      // אין מספיק מלאי ליום הזה
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Stock Limit Exceeded",
          message:
            remaining > 0
              ? `We are almost sold out for ${pickupDate}. Only ${remaining} donuts left for that day.`
              : `We are fully sold out for ${pickupDate}. Please choose another day.`,
          remaining,
        }),
      };
    }

    // ---- ❷ שליפת locationId מ-Square ----
    const locationsRes = await callSquare("/v2/locations", "GET");
    if (locationsRes.statusCode >= 400 || locationsRes.body.errors) {
      console.error("Square locations error:", locationsRes.body);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to fetch Square locations",
          details: locationsRes.body,
        }),
      };
    }

    const locations = locationsRes.body.locations || [];
    if (!locations.length) {
      console.error("No locations found on Square account");
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "No locations configured in Square",
        }),
      };
    }

    const selectedLocation =
      locations.find((loc) =>
        (loc.capabilities || []).includes("CREDIT_CARD_PROCESSING")
      ) || locations[0];

    const locationId = selectedLocation.id;
    const locationTz = selectedLocation.timezone || "America/New_York";

    // ---- ❸ בניית pickup_at בפורמט ש-Square אוהב ----
    function parseStartTimeWindow(t) {
      if (!t) return "10:00"; // ברירת מחדל
      const part = String(t).split("-")[0] || t;
      return part.trim(); // "10:00"
    }

    function buildPickupIso(dateStr, timeWindow) {
      const hhmm = parseStartTimeWindow(timeWindow); // "10:00"
      // Square מצפה ל-YYYY-MM-DDTHH:MM:SS (ללא offset, timezone לפי location)
      return `${dateStr}T${hhmm.padStart(5, "0")}:00`;
    }

    const pickupAt = buildPickupIso(pickupDate, pickupTime);

    // ---- ❹ בניית line items ----
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity || 1),
      base_price_money: {
        amount: item.unitAmountCents,
        currency,
      },
      note:
        pickupDate && pickupTime
          ? `Pickup ${pickupDate} ${pickupTime}`
          : undefined,
    }));

    const orderNote = [
      pickupDate && pickupTime ? `Pickup: ${pickupDate} ${pickupTime}` : null,
      customerName ? `Customer: ${customerName}` : null,
      customerPhone ? `Phone: ${customerPhone}` : null,
      customerEmail ? `Email: ${customerEmail}` : null,
      subtotalCents != null ? `Subtotal: ${(subtotalCents / 100).toFixed(2)}` : null,
      taxCents != null ? `Tax: ${(taxCents / 100).toFixed(2)}` : null,
      totalCents != null ? `Total: ${(totalCents / 100).toFixed(2)}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    // ---- ❺ בניית ההזמנה עם Fulfillment PICKUP ----
    const order = {
      location_id: locationId,
      line_items: lineItems,
      note: orderNote,
      ticket_name:
        pickupDate && pickupTime
          ? `${pickupDate} ${pickupTime}`
          : undefined,
      metadata: {
        pickup_date: pickupDate || "",
        pickup_time: pickupTime || "",
        customer_name: customerName || "",
        customer_phone: customerPhone || "",
        customer_email: customerEmail || "",
      },
      fulfillments: [
        {
          type: "PICKUP",
          state: "PROPOSED",
          pickup_details: {
            schedule_type: "SCHEDULED",
            pickup_at: pickupAt, // YYYY-MM-DDTHH:MM:SS
            // חלון של שעה – אופציונלי:
            pickup_window_duration: "PT1H",
            note: `Pickup window: ${pickupTime}`,
            recipient: {
              display_name: customerName || "",
              email_address: customerEmail || "",
              phone_number: customerPhone || "",
            },
          },
        },
      ],
    };

    // idempotency key בטוח
    const idempotencyKey = crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");

    const checkoutBody = {
      idempotency_key: idempotencyKey,
      order,
      checkout_options: {
        redirect_url: `${redirectUrlBase.replace(/\/$/, "")}/success.html`,
      },
    };

    // ---- ❻ יצירת לינק לתשלום ב-Square ----
    const checkoutRes = await callSquare(
      "/v2/online-checkout/payment-links",
      "POST",
      checkoutBody
    );

    if (checkoutRes.statusCode >= 400 || checkoutRes.body.errors) {
      console.error("Square checkout error:", checkoutRes.body);
      return {
        statusCode: checkoutRes.statusCode || 400,
        body: JSON.stringify(checkoutRes.body),
      };
    }

    // ====== ❼ עדכון המונה ליום רק אחרי שהלינק נוצר בהצלחה ======
    dailyTotals[pickupDate] = currentForDay + requestedQty;
    console.log(
      `Updated total for ${pickupDate}: ${dailyTotals[pickupDate]}/${MAX_DAILY_LIMIT} (tz: ${locationTz})`
    );

    return {
      statusCode: 200,
      body: JSON.stringify(checkoutRes.body),
    };
  } catch (err) {
    console.error("Handler error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        message: err.message,
      }),
    };
  }
};
