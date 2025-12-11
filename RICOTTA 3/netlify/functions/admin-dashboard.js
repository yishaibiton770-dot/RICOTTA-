// netlify/functions/admin-dashboard.js
const https = require("https");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";

// כמה סופגניות מותר ליום
const DAILY_LIMIT = 250;

// כל ההזמנות *לפני* התאריך הזה לא נספרות (בדיקות)
const GO_LIVE_AT = "2025-12-04T00:00:00-05:00";

// טווח ימים לחנוכה (בשביל daily map)
const DAYS = [
  "2025-12-15","2025-12-16","2025-12-17","2025-12-18",
  "2025-12-19","2025-12-21","2025-12-22"
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
      body: JSON.stringify({ success: false, error: "Missing SQUARE_ACCESS_TOKEN" }),
    };
  }

  try {
    // מחפשים הזמנות שהושלמו סביב חנוכה
    const body = {
      location_ids: [LOCATION_ID],
      query: {
        filter: {
          state_filter: {
            states: ["COMPLETED"],
          },
          date_time_filter: {
            created_at: {
              start_at: "2025-12-01T00:00:00-05:00",
              end_at:   "2025-12-31T23:59:59-05:00",
            },
          },
        },
      },
    };

    const result = await callSquare("/v2/orders/search", "POST", body);

    if (result.statusCode >= 400 || result.body.errors) {
      console.error("Square error:", result.body);
      return {
        statusCode: 400,
        body: JSON.stringify({
          success: false,
          error:
            result.body.errors?.[0]?.detail ||
            "Error loading orders from Square",
        }),
      };
    }

    const orders = result.body.orders || [];

    const daily = {};
    const outOrders = [];

    for (const order of orders) {
      // לא סופרים ניסויים לפני GO_LIVE_AT
      if (order.created_at && order.created_at < GO_LIVE_AT) continue;

      const fulfill = (order.fulfillments && order.fulfillments[0]) || null;
      const pickupAt = fulfill?.pickup_details?.pickup_at || null;
      if (!pickupAt) continue;

      const pickupDate = pickupAt.slice(0, 10);  // yyyy-mm-dd
      const pickupTime = pickupAt.slice(11, 16); // hh:mm

      // לא מעניין אותנו ימים מחוץ לטווח חנוכה בדשבורד
      if (!DAYS.includes(pickupDate)) continue;

      // סופגניות שנמכרו
      let sold = 0;
      for (const li of order.line_items || []) {
        if (li.name === "Pickup Details") continue;
        const q = parseInt(li.quantity || "0", 10);
        if (!isNaN(q)) sold += q;
      }

      // סופגניות שהוחזרו/בוטלו
      let returned = 0;
      for (const ret of order.returns || []) {
        for (const rli of ret.return_line_items || []) {
          if (rli.name === "Pickup Details") continue;
          const rq = parseInt(rli.quantity || "0", 10);
          if (!isNaN(rq)) returned += rq;
        }
      }

      const netDonuts = sold - returned;
      if (netDonuts <= 0) {
        // הזמנה שבוטלה לגמרי – לא תופסת מקום במלאי
        continue;
      }

      if (!daily[pickupDate]) {
        daily[pickupDate] = { used: 0, remaining: DAILY_LIMIT };
      }

      daily[pickupDate].used += netDonuts;
      daily[pickupDate].remaining = Math.max(
        DAILY_LIMIT - daily[pickupDate].used,
        0
      );

      const total = order.total_money
        ? order.total_money.amount / 100
        : 0;

      outOrders.push({
        id: order.id,
        pickupDate,
        pickupTime,
        donuts: netDonuts,
        total,
        created_at: order.created_at || "",
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        daily,
        orders: outOrders,
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
