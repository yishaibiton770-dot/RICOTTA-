const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

const MAX_DAILY_LIMIT = 250;
const dailyTotals = {};

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
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        let json;
        try { json = JSON.parse(data); }
        catch { json = { raw: data }; }
        resolve({ statusCode: res.statusCode, body: json });
      });
    });

    req.on("error", reject);

    if (postData) req.write(postData);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  if (!SQUARE_ACCESS_TOKEN)
    return { statusCode: 500, body: "Missing Access Token" };

  try {
    const {
      cartItems,
      redirectUrlBase,
      pickupDate,
      pickupWindow,
      customerName,
      customerPhone,
      customerEmail
    } = JSON.parse(event.body || "{}");

    if (!cartItems || !pickupDate || !pickupWindow)
      return { statusCode: 400, body: "Missing required fields" };

    // Stock check
    const qty = cartItems.reduce((s, i) => s + Number(i.quantity || 0), 0);
    const used = dailyTotals[pickupDate] || 0;
    if (qty + used > MAX_DAILY_LIMIT)
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "soldout",
          remaining: MAX_DAILY_LIMIT - used
        })
      };

    // Locations
    const locationsRes = await callSquare("/v2/locations", "GET");
    const locationId = locationsRes.body.locations[0].id;

    // Build order (no fulfillment!)
const orderNote =
  `Pickup Date: ${pickupDate}\n` +
  `Pickup Window: ${pickupTime}\n` +
  `Customer: ${customerName}\n` +
  `Phone: ${customerPhone}\n` +
  `Email: ${customerEmail}`;

    const lineItems = cartItems.map(i => ({
      name: i.name,
      quantity: String(i.quantity),
      base_price_money: { amount: i.unitAmountCents, currency: "USD" }
    }));

    const order = { location_id: locationId, line_items: lineItems, note: orderNote };

    const body = {
      idempotency_key: crypto.randomBytes(16).toString("hex"),
      order,
      checkout_options: {
        redirect_url: `${redirectUrlBase}/success.html`
      }
    };

    const result = await callSquare("/v2/online-checkout/payment-links", "POST", body);

    if (result.statusCode >= 400 || result.body.errors)
      return { statusCode: 400, body: JSON.stringify(result.body) };

    // update stock
    dailyTotals[pickupDate] = used + qty;

    return {
      statusCode: 200,
      body: JSON.stringify(result.body)
    };
  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};

