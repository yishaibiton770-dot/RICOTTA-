// netlify/functions/create-checkout-link.js
const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

// ====== הגבלת מלאי לפי יום ======
const MAX_DAILY_LIMIT = 250;
const dailyTotals = {};

// קריאה ל־Square
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

      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(data || "{}"),
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: { raw: data, parseError: e.message },
          });
        }
      });
    });

    req.on("error", reject);

    if (postData) req.write(postData);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing SQUARE_ACCESS_TOKEN" }),
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

    if (!cartItems || !cartItems.length || !pickupDate) {
      return { statusCode: 400, body: "Missing required fields" };
    }

    // ===== מגבלת 250 =====
    const requestedQty = cartItems.reduce(
      (s, item) => s + Number(item.quantity || 0),
      0
    );

    const current = dailyTotals[pickupDate] || 0;
    const remaining = MAX_DAILY_LIMIT - current;

    if (requestedQty > remaining) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Stock Limit Exceeded",
          remaining,
        }),
      };
    }

    // ===== שליפת locationId =====
    const locationsRes = await callSquare("/v2/locations", "GET");
    const locations = locationsRes.body.locations || [];
    const locationId = locations.find((l) =>
      (l.capabilities || []).includes("CREDIT_CARD_PROCESSING")
    )?.id;

    if (!locationId) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "No Square location found" }),
      };
    }

    // ===== שורת הערה יפה =====
    const formattedNote = [
      `Pickup: ${pickupDate} ${pickupTime}`,
      customerName ? `Name: ${customerName}` : null,
      customerPhone ? `Phone: ${customerPhone}` : null,
      customerEmail ? `Email: ${customerEmail}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    // ===== בניית שורות המוצרים =====
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: item.unitAmountCents,
        currency,
      },
    }));

    // ===== אין Fulfillment בכלל ====  
    const order = {
      location_id: locationId,
      line_items: lineItems,
      note: formattedNote,
    };

    const checkoutBody = {
      idempotency_key: crypto.randomUUID(),
      order,
      checkout_options: {
        redirect_url: `${redirectUrlBase.replace(/\/$/, "")}/success.html`,
      },
    };

    const checkoutRes = await callSquare(
      "/v2/online-checkout/payment-links",
      "POST",
      checkoutBody
    );

    dailyTotals[pickupDate] = current + requestedQty;

    return {
      statusCode: 200,
      body: JSON.stringify(checkoutRes.body),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal Error",
        details: err.message,
      }),
    };
  }
};
