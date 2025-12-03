// netlify/functions/admin-orders.js
const https = require("https");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID =
  process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";

// כמה סופגניות ליום
const DAILY_LIMIT = 250;

// טווח הימים של חנוכה (לפי ה-PICKUP)
const DAYS = [
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

exports.handler = async () => {
  if (!SQUARE_ACCESS_TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing SQUARE_ACCESS_TOKEN" }),
    };
  }

  try {
    // מחפשים רק הזמנות במצב COMPLETED בתוך חלון הזמן של חנוכה
    const searchBody = {
      location_ids: [SQUARE_LOCATION_ID],
      query: {
        filter: {
          state_filter: {
            states: ["COMPLETED"],
          },
          date_time_filter: {
            closed_at: {
              start_at: "2025-12-14T00:00:00-05:00",
              end_at: "2025-12-23T23:59:59-05:00",
            },
          },
        },
      },
    };

    const result = await callSquare(
      "/v2/orders/search",
      "POST",
      searchBody
    );

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

    const countsByDate = {};
    const cleanedOrders = [];

    for (const order of orders) {
      const fulfill = (order.fulfillments && order.fulfillments[0]) || null;
      const pickupAt = fulfill?.pickup_details?.pickup_at || null;
      if (!pickupAt) continue;

      const pickupDate = pickupAt.slice(0, 10);
      if (!DAYS.includes(pickupDate)) continue;

      // ----- בדיקת ביטול / החזר -----
      const total = order.total_money?.amount ?? 0;
      const returned = order.total_returned_money?.amount ?? 0;

      // אם הסכום הכולל 0 או קטן – לא רלוונטי
      if (total <= 0) continue;

      // אם כל הסכום הוחזר – נחשבת כלא קיימת מבחינת מלאי
      if (returned >= total) {
        continue;
      }

      // ----- ספירת סופגניות בהזמנה -----
      let donutsInOrder = 0;
      for (const li of order.line_items || []) {
        if (li.name === "Pickup Details") continue;
        const q = parseInt(li.quantity || "0", 10);
        if (!isNaN(q)) donutsInOrder += q;
      }
      if (donutsInOrder <= 0) continue;

      if (!countsByDate[pickupDate]) countsByDate[pickupDate] = 0;
      countsByDate[pickupDate] += donutsInOrder;

      const pickupTime = pickupAt.slice(11, 16);

      cleanedOrders.push({
        id: order.id,
        pickupDate,
        pickupTime,
        donuts: donutsInOrder,
        total: (total - returned) / 100, // מה שהלקוחה באמת משלמת בסוף
        createdAt: order.closed_at || order.created_at || "",
      });
    }

    const days = DAYS.map((date) => {
      const used = countsByDate[date] || 0;
      return {
        date,
        used,
        remaining: Math.max(DAILY_LIMIT - used, 0),
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        days,
        orders: cleanedOrders.sort((a, b) =>
          (b.createdAt || "").localeCompare(a.createdAt || "")
        ),
      }),
    };
  } catch (err) {
    console.error("admin-orders function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message || "Unexpected server error",
      }),
    };
  }
};
