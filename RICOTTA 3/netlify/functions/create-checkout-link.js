const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

// מגבלה יומית
const MAX_DAILY_LIMIT = 250;
const dailyTotals = {}; // { '2025-12-18': 35, ... }

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

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return jsonResponse(500, { error: "Missing Square access token" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { error: "invalid_json", message: "Bad JSON body" });
  }

  const {
    cartItems,
    redirectUrlBase,
    pickupDate,
    pickupWindow,
    customerName,
    customerPhone,
    customerEmail,
    notes,
  } = payload;

  // בדיקות בסיסיות
  if (!cartItems || !Array.isArray(cartItems) || !cartItems.length) {
    return jsonResponse(400, { error: "no_items", message: "Cart is empty" });
  }
  if (!pickupDate || !pickupWindow || !pickupWindow.start || !pickupWindow.end) {
    return jsonResponse(400, {
      error: "missing_pickup",
      message: "Pickup date and time are required",
    });
  }

  const dateStr = String(pickupDate);

  // חסימת 17/12 ושבת בצד השרת (ביטחון נוסף)
  if (dateStr === "2025-12-17") {
    return jsonResponse(400, {
      error: "not_available",
      message: "Pickup is not available on this date.",
    });
  }
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getUTCDay(); // 6 = Saturday
  if (day === 6) {
    return jsonResponse(400, {
      error: "not_available",
      message: "Pickup is not available on Saturday.",
    });
  }

  // מגבלת 250 סופגניות ליום
  const qty = cartItems.reduce((sum, i) => sum + Number(i.quantity || 0), 0);
  const used = dailyTotals[dateStr] || 0;
  if (qty + used > MAX_DAILY_LIMIT) {
    return jsonResponse(400, {
      error: "soldout",
      remaining: Math.max(0, MAX_DAILY_LIMIT - used),
      message: "Daily limit reached for this pickup date.",
    });
  }

  try {
    // לוקח לוקיישן פעיל ראשון
    const locationsRes = await callSquare("/v2/locations", "GET");
    if (locationsRes.statusCode >= 400 || !locationsRes.body.locations?.length) {
      return jsonResponse(500, {
        error: "locations_error",
        details: locationsRes.body,
      });
    }

    const locationId = locationsRes.body.locations[0].id;

    // שורות ההזמנה
    const lineItems = cartItems.map((i) => ({
      name: i.name,
      quantity: String(i.quantity),
      base_price_money: {
        amount: Number(i.unitAmountCents),
        currency: "USD",
      },
    }));

    const cleanNotes = (notes || "").trim();

    // זה יופיע כהערה בהזמנה / בקבלה הגדולה
    const pickupStartTime = pickupWindow.start.slice(11, 16);
    const pickupEndTime = pickupWindow.end.slice(11, 16);

    const noteParts = [
      `Pickup ${dateStr} (${pickupStartTime}–${pickupEndTime})`,
      `Name: ${customerName || ""}`,
      `Phone: ${customerPhone || ""}`,
      `Email: ${customerEmail || ""}`,
    ];
    if (cleanNotes) noteParts.push(`Notes: ${cleanNotes}`);

    const order = {
      location_id: locationId,
      line_items: lineItems,
      note: noteParts.join(" | "),
    };

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
      return jsonResponse(400, {
        error: "square_error",
        details: result.body,
      });
    }

    // מעדכן ספירה יומית
    dailyTotals[dateStr] = used + qty;

    return jsonResponse(200, result.body);
  } catch (err) {
    console.error("Square checkout error:", err);
    return jsonResponse(500, {
      error: "server_error",
      message: "Unexpected server error",
    });
  }
};
