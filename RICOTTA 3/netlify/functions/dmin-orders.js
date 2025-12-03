// netlify/functions/admin-orders.js
const https = require("https");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";
const DAILY_LIMIT = 250;

// חנוכה – כמו באתר
const HANUKKAH_DAYS = [
  "2025-12-15",
  "2025-12-16",
  "2025-12-17",
  "2025-12-18",
  "2025-12-19",
  "2025-12-20",
  "2025-12-21",
  "2025-12-22",
];

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
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing SQUARE_ACCESS_TOKEN" }),
    };
  }

  try {
    // נטען הזמנות מ־Orders API
    const searchBody = {
      location_ids: [LOCATION_ID],
      query: {
        filter: {
          state_filter: {
            states: ["COMPLETED"], // רק הזמנות ששולמו
          },
          date_time_filter: {
            created_at: {
              start_at: "2025-12-14T00:00:00-05:00",
              end_at: "2025-12-23T23:59:59-05:00",
            },
          },
        },
      },
    };

    const result = await callSquare("/v2/orders/search", "POST", searchBody);

    if (result.statusCode >= 400 || result.body.errors) {
      console.error("Square orders error:", result.body);
      return {
        statusCode: 400,
        body: JSON.stringify({
          error:
            result.body.errors?.[0]?.detail ||
            "Error loading orders from Square",
        }),
      };
    }

    const orders = result.body.orders || [];

    // סיכום לפי יום איסוף + רשימת הזמנות
    const dayCounts = {};
    const ordersOut = [];

    for (const order of orders) {
      const fulfill = (order.fulfillments && order.fulfillments[0]) || null;
      const pickupAt = fulfill?.pickup_details?.pickup_at || null;

      let pickupDate = null;
      let pickupTime = null;

      if (pickupAt) {
        pickupDate = pickupAt.slice(0, 10); // YYYY-MM-DD
        pickupTime = pickupAt.slice(11, 16); // HH:MM
      }

      let donutsInOrder = 0;
      for (const li of order.line_items || []) {
        if (li.name === "Pickup Details") continue;
        const q = parseInt(li.quantity || "0", 10);
        if (!isNaN(q)) donutsInOrder += q;
      }

      if (pickupDate) {
        if (!dayCounts[pickupDate]) dayCounts[pickupDate] = 0;
        dayCounts[pickupDate] += donutsInOrder;
      }

      const recipient = fulfill?.pickup_details?.recipient || {};
      const totalCents = order.total_money ? order.total_money.amount : null;

      ordersOut.push({
        id: order.id,
        pickupDate,
        pickupTime,
        donuts: donutsInOrder,
        totalCents,
        customerName: recipient.display_name || "",
        customerPhone: recipient.phone_number || "",
        customerEmail: recipient.email_address || "",
        createdAt: order.created_at || "",
      });
    }

    const daysSummary = HANUKKAH_DAYS.map((date) => {
      const used = dayCounts[date] || 0;
      const remaining = Math.max(DAILY_LIMIT - used, 0);
      return {
        date,
        used,
        remaining,
        limit: DAILY_LIMIT,
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        daysSummary,
        orders: ordersOut,
      }),
    };
  } catch (err) {
    console.error("Admin orders function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message || "Unexpected server error",
      }),
    };
  }
};
