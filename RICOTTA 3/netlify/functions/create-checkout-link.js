// netlify/functions/create-checkout-link.js
const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

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

    if (postData) req.write(postData);
    req.end();
  });
}

exports.handler = async (event) => {
  // רק POST
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

  try:
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
    } = JSON.parse(event.body || "{}");

    if (
      !cartItems ||
      !Array.isArray(cartItems) ||
      cartItems.length === 0 ||
      !redirectUrlBase
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing required fields",
        }),
      };
    }

    // 1) שולפים מ-Square את ה-location_id התקין
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

    // בוחרים לוקיישן ראשון עם יכולת חיוב
    const selectedLocation =
      locations.find((loc) =>
        (loc.capabilities || []).includes("CREDIT_CARD_PROCESSING")
      ) || locations[0];

    const locationId = selectedLocation.id;

    // 2) בונים הזמנה
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity || 1),
      base_price_money: {
        amount: item.unitAmountCents,
        currency,
      },
    }));

    const order = {
      location_id: locationId,
      line_items: lineItems,
      note: [
        pickupDate && pickupTime
          ? `Pickup: ${pickupDate} ${pickupTime}`
          : null,
        customerName ? `Customer: ${customerName}` : null,
        customerPhone ? `Phone: ${customerPhone}` : null,
        customerEmail ? `Email: ${customerEmail}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
    };

    // 3) יוצרים קישור תשלום
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

    if (checkoutRes.statusCode >= 400 || checkoutRes.body.errors) {
      console.error("Square checkout error:", checkoutRes.body);
      return {
        statusCode: checkoutRes.statusCode || 400,
        body: JSON.stringify(checkoutRes.body),
      };
    }

    // מחזירים ל-frontend את ה-URL של סקוור
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
