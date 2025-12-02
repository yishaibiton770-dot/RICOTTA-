const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

// הגבלה יומית
const MAX_DAILY_LIMIT = 250;
const dailyTotals = {};

// פונקציה כללית לקריאה ל-Square
function callSquare(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const postData = bodyObj ? JSON.stringify(bodyObj) : null;

    const options = {
      hostname: "connect.squareup.com",
      path,
      method,
      headers: {
        // אם Square יזרוק על התאריך הזה – אפשר להחליף לתאריך קיים, למשל "2023-12-13"
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

    if (postData) req.write(postData);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return { statusCode: 500, body: "Missing Access Token" };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const {
      cartItems,
      redirectUrlBase,
      pickupDate,
      pickupWindow,    // מגיע מהפרונט
      customerName,
      customerPhone,
      customerEmail,
      notes,
    } = body;

    if (!cartItems || !pickupDate || !pickupWindow) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    // בדיקת כמות יומית
    const qty = cartItems.reduce(
      (s, i) => s + Number(i.quantity || 0),
      0
    );
    const used = dailyTotals[pickupDate] || 0;

    if (qty + used > MAX_DAILY_LIMIT) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "soldout",
          remaining: MAX_DAILY_LIMIT - used,
        }),
      };
    }

    // לוקיישן מ-Square
    const locationsRes = await callSquare("/v2/locations", "GET");
    if (
      locationsRes.statusCode >= 400 ||
      !locationsRes.body.locations ||
      !locationsRes.body.locations.length
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "No Square locations found",
          details: locationsRes.body,
        }),
      };
    }

    const locationId = locationsRes.body.locations[0].id;

    // בניית הערת הזמנה
    const windowText = `${pickupWindow.start.slice(
      11,
      16
    )}–${pickupWindow.end.slice(11, 16)}`;

    const orderNote =
      `Pickup ${pickupDate} (${windowText})` +
      ` | Name: ${customerName || ""}` +
      ` | Phone: ${customerPhone || ""}` +
      ` | Email: ${customerEmail || ""}` +
      (notes ? ` | Notes: ${notes}` : "");

    // שורות מוצרים
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: item.unitAmountCents,
        currency: "USD",
      },
    }));

    const order = {
      location_id: locationId,
      line_items: lineItems,
      note: orderNote,
    };

    const bodyReq = {
      idempotency_key: crypto.randomBytes(16).toString("hex"),
      order,
      checkout_options: {
        redirect_url: `${redirectUrlBase}/success.html`,
      },
    };

    const checkoutRes = await callSquare(
      "/v2/online-checkout/payment-links",
      "POST",
      bodyReq
    );

    if (checkoutRes.statusCode >= 400 || checkoutRes.body.errors) {
      return {
        statusCode: 400,
        body: JSON.stringify(checkoutRes.body),
      };
    }

    // עדכון ספירה יומית
    dailyTotals[pickupDate] = used + qty;

    return {
      statusCode: 200,
      body: JSON.stringify(checkoutRes.body),
    };
  } catch (err) {
    console.error("Netlify function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Server error" }),
    };
  }
};
