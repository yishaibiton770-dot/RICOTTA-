// netlify/functions/admin-dashboard.js
const https = require("https");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";
const DAILY_LIMIT = 250;

// הימים הרלוונטיים
const DAYS = [
  "2025-12-15","2025-12-16","2025-12-17","2025-12-18",
  "2025-12-19","2025-12-21","2025-12-22" // 20 שבת – מדלגים
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
      body: JSON.stringify({ success: false, error: "Missing SQUARE_ACCESS_TOKEN env var" }),
    };
  }

  try {
 // מחפשים כל ההזמנות ששולמו בערך בשנה הזו
const body = {
  location_ids: [LOCATION_ID],
  query: {
    filter: {
      state_filter: {
        states: ["COMPLETED"], // רק הזמנות ששולמו
      },
      date_time_filter: {
        created_at: {
          // טווח רחב כדי לכלול גם הזמנות ניסיון וגם חנוכה
          start_at: "2025-01-01T00:00:00-05:00",
          end_at:   "2026-01-01T00:00:00-05:00",
        },
      },
    },
  },
};


    const result = await callSquare("/v2/orders/search", "POST", body);

    if (result.statusCode >= 400 || result.body.errors) {
      console.error("Square orders error:", result.body);
      return {
        statusCode: 500,
        body: JSON.stringify({
          success: false,
          error:
            result.body.errors?.[0]?.detail ||
            "Error loading orders from Square",
        }),
      };
    }

    const orders = result.body.orders || [];

    // חישוב מספר הסופגניות לכל הזמנה ולכל תאריך איסוף
    const dailyMap = {}; // { '2025-12-18': מספר סופגניות }
    const simplifiedOrders = [];

    for (const order of orders) {
      const fulfill = (order.fulfillments && order.fulfillments[0]) || null;
      const pickupAt = fulfill?.pickup_details?.pickup_at || null;
      if (!pickupAt) continue;

      const pickupDate = pickupAt.slice(0, 10);   // yyyy-mm-dd
      const pickupTime = pickupAt.slice(11, 16);  // HH:MM

      // סופרים סופגניות לפי line_items (בלי שורת Pickup Details)
      let donutsInOrder = 0;
      for (const li of order.line_items || []) {
        if (li.name === "Pickup Details") continue;
        const q = parseInt(li.quantity || "0", 10);
        if (!isNaN(q)) donutsInOrder += q;
      }

      if (!dailyMap[pickupDate]) dailyMap[pickupDate] = 0;
      dailyMap[pickupDate] += donutsInOrder;

      const total = order.total_money
        ? order.total_money.amount / 100
        : 0;

      simplifiedOrders.push({
        id: order.id,
        pickupDate,
        pickupTime,
        donuts: donutsInOrder,
        total,
        created_at: order.created_at || order.closed_at || null,
      });
    }

    // בניית אובייקט יומי ל־UI
    const daily = {};
    for (const d of DAYS) {
      const used = dailyMap[d] || 0;
      daily[d] = {
        used,
        remaining: Math.max(DAILY_LIMIT - used, 0),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        daily,
        orders: simplifiedOrders,
      }),
    };
  } catch (err) {
    console.error("Admin dashboard error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message || "Unexpected server error",
      }),
    };
  }
};
