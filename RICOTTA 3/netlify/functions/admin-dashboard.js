// netlify/functions/admin-dashboard.js
const https = require("https");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";

// אותם ימים כמו ב-ADMIN
const DAYS = [
  "2025-12-15",
  "2025-12-16",
  "2025-12-17",
  "2025-12-18",
  "2025-12-19",
  "2025-12-21",
  "2025-12-22" // 20 = שבת
];

const DAILY_LIMIT = 250;

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

async function loadAllCompletedOrders() {
  let allOrders = [];
  let cursor = null;

  do {
    const body = {
      location_ids: [LOCATION_ID],
      query: {
        filter: {
          state_filter: {
            states: ["COMPLETED"],  // רק הזמנות ששולמו
          },
        },
      },
      cursor: cursor || undefined,
    };

    const result = await callSquare("/v2/orders/search", "POST", body);

    if (result.statusCode >= 400 || result.body.errors) {
      console.error("Square orders error:", result.body);
      throw new Error(
        result.body.errors?.[0]?.detail || "Error loading orders from Square"
      );
    }

    const orders = result.body.orders || [];
    allOrders = allOrders.concat(orders);
    cursor = result.body.cursor || null;
  } while (cursor);

  return allOrders;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: "Missing SQUARE_ACCESS_TOKEN" }),
    };
  }

  try {
    const rawOrders = await loadAllCompletedOrders();

    // מפה יומית: { '2025-12-18': { used, remaining } }
    const dailyMap = {};
    // רשימת הזמנות לתצוגה ב-ADMIN
    const adminOrders = [];

    for (const order of rawOrders) {
      const fulfill = (order.fulfillments && order.fulfillments[0]) || null;
      const pickupAt = fulfill?.pickup_details?.pickup_at || null;

      if (!pickupAt) continue;

      const pickupDate = pickupAt.slice(0, 10); // yyyy-mm-dd
      if (!DAYS.includes(pickupDate)) continue; // מעניין אותנו רק חנוכה

      const pickupTime = pickupAt.slice(11, 16); // HH:MM

      let donutsInOrder = 0;
      for (const li of order.line_items || []) {
        if (li.name === "Pickup Details") continue;
        const q = parseInt(li.quantity || "0", 10);
        if (!isNaN(q)) donutsInOrder += q;
      }

      const total =
        order.total_money && typeof order.total_money.amount === "number"
          ? order.total_money.amount / 100
          : 0;

      // מעדכנים מפה יומית
      if (!dailyMap[pickupDate]) {
        dailyMap[pickupDate] = { used: 0, remaining: DAILY_LIMIT };
      }
      dailyMap[pickupDate].used += donutsInOrder;
      dailyMap[pickupDate].remaining = Math.max(
        DAILY_LIMIT - dailyMap[pickupDate].used,
        0
      );

      // מוסיפים להזמנות ל־ADMIN
      adminOrders.push({
        id: order.id,
        pickupDate,
        pickupTime,
        donuts: donutsInOrder,
        total,
        created_at: order.created_at || "",
      });
    }

    // מסדרים לפי תאריך יצירה מהחדש לישן
    adminOrders.sort((a, b) =>
      (b.created_at || "").localeCompare(a.created_at || "")
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        orders: adminOrders,
        daily: dailyMap,
      }),
    };
  } catch (err) {
    console.error("admin-dashboard error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message || "Unexpected server error",
      }),
    };
  }
};
