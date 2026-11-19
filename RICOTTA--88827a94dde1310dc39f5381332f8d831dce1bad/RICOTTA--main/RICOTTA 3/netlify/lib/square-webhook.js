// netlify/functions/square-webhook.js

const https = require("https");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// קריאה ל־Square
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

// קריאה ל־Supabase REST
function callSupabase(path, method, bodyObj, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return reject(new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"));
    }

    const url = new URL(path, SUPABASE_URL);
    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const options = {
      method,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    };

    const req = https.request(url, options, (res) => {
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
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    if (!SQUARE_ACCESS_TOKEN) {
      console.error("Missing SQUARE_ACCESS_TOKEN");
      return { statusCode: 500, body: "Square token not configured" };
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error("Missing Supabase env vars");
      return { statusCode: 500, body: "Supabase not configured" };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      console.error("Failed to parse webhook body:", e);
      return { statusCode: 400, body: "Invalid JSON" };
    }

    const eventType = body.type;
    const payment = body.data?.object?.payment;

    // אנחנו עובדים רק על אירועים של תשלום
    if (!payment || !eventType || !eventType.startsWith("payment.")) {
      return { statusCode: 200, body: "Ignored: not a payment event" };
    }

    // סופרים רק תשלום שהושלם
    if (payment.status !== "COMPLETED") {
      return { statusCode: 200, body: "Ignored: payment not completed" };
    }

    const orderId = payment.order_id;
    if (!orderId) {
      console.error("No order_id on payment");
      return { statusCode: 200, body: "No order_id, nothing to do" };
    }

    // 1) מושכים את ההזמנה המלאה מ־Square
    const orderResult = await callSquare(`/v2/orders/${orderId}`, "GET");
    if (orderResult.statusCode >= 400 || !orderResult.body.order) {
      console.error("Error fetching order:", orderResult.body);
      return { statusCode: 200, body: "Could not fetch order" };
    }

    const order = orderResult.body.order;
    const lineItems = order.line_items || [];
    const fulfillments = order.fulfillments || [];

    // 2) מפענחים תאריך איסוף מה־pickup_at שלנו
    let pickupDate = null;
    if (
      fulfillments.length &&
      fulfillments[0].pickup_details &&
      fulfillments[0].pickup_details.pickup_at
    ) {
      const pickupAt = fulfillments[0].pickup_details.pickup_at; // לדוגמה: 2025-12-18T10:00:00-05:00
      pickupDate = pickupAt.substring(0, 10); // "YYYY-MM-DD"
    }

    if (!pickupDate) {
      console.error("No pickupDate found on order", orderId);
      return { statusCode: 200, body: "No pickup date, nothing to update" };
    }

    // 3) מחשבים כמה סופגניות בפועל (מדלגים על שורות אינפו / 0 דולר)
    let totalQty = 0;
    for (const li of lineItems) {
      const amt = li.base_price_money?.amount || 0;
      if (!amt) continue; // שורות $0 כמו Pickup Details – לא נספר

      const q = parseInt(li.quantity || "0", 10);
      if (!isNaN(q) && q > 0) {
        totalQty += q;
      }
    }

    if (!totalQty) {
      console.log("Order has no paid donuts, skipping", orderId);
      return { statusCode: 200, body: "No quantity to add" };
    }

    console.log(`Counting ${totalQty} donuts for date ${pickupDate}`);

    // 4) מושכים את השורה הקיימת ליום הזה מ־daily_inventory
    const selectRes = await callSupabase(
      `/rest/v1/daily_inventory?date=eq.${pickupDate}&select=used_quantity&limit=1`,
      "GET"
    );

    if (selectRes.statusCode >= 400) {
      console.error("Supabase select error:", selectRes.body);
      return { statusCode: 500, body: "Supabase select error" };
    }

    const rows = Array.isArray(selectRes.body) ? selectRes.body : [];
    const currentUsed = rows.length ? rows[0].used_quantity || 0 : 0;
    const newUsed = currentUsed + totalQty;

    // 5) upsert – אם יש שורה מעדכן, אם אין – יוצר
    const upsertBody = {
      date: pickupDate,
      used_quantity: newUsed,
    };

    const upsertRes = await callSupabase(
      "/rest/v1/daily_inventory",
      "POST",
      upsertBody,
      {
        Prefer: "resolution=merge-duplicates",
      }
    );

    if (upsertRes.statusCode >= 400) {
      console.error("Supabase upsert error:", upsertRes.body);
      return { statusCode: 500, body: "Supabase upsert error" };
    }

    console.log(
      `Updated daily_inventory for ${pickupDate}: ${currentUsed} -> ${newUsed}`
    );

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error("Webhook handler error:", err);
    return {
      statusCode: 500,
      body: "Internal error",
    };
  }
};
