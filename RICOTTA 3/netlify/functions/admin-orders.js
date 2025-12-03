// netlify/functions/admin-orders.js
const https = require("https");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID =
  process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";

// אותם ערכים כמו באתר / באדמין
const DAILY_LIMIT = 250;
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
    // מחפשים את כל ההזמנות בחנוכה
    const searchBody = {
      location_ids: [SQUARE_LOCATION_ID],
      query: {
        filter: {
          date_time_filter: {
            // closed_at עדיף, אבל אם אין – ניקח created_at
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
      // -------- 1) דילוג על הזמנות שלא בתאריכים שלנו --------
      const fulfill = (order.fulfillments && order.fulfillments[0]) || null;
      const pickupAt = fulfill?.pickup_details?.pickup_at || null;
      if (!pickupAt) continue;

      const pickupDate = pickupAt.slice(0, 10);
      if (!DAYS.includes(pickupDate)) continue;

      // -------- 2) דילוג על הזמנות שבוטלו / זוכו --------
      // net_amounts.total_money = סכום נטו אחרי החזרים
      const netAmount =
        order.net_amounts?.total_money?.amount ??
        order.total_money?.amount ??
        0;

      // אם הנטו 0 או פחות – כנראה בוטל/זוכה → מדלגים
      if (netAmount <= 0) continue;

      // למקרה שמשחקים עם fulfillments – אם כולן CANCELED גם מדלגים
      const allFulfillCanceled =
        Array.isArray(order.fulfillments) &&
        order.fulfillments.length > 0 &&
        order.fulfillments.every((f) =>
          ["CANCELED", "FAILED"].includes(f.state)
        );

      if (allFulfillCanceled) continue;

      // -------- 3) ספירת סופגניות בהזמנה --------
      let donutsInOrder = 0;
      for (const li of order.line_items || []) {
        // לא סופרים את שורת "Pickup Details"
        if (li.name === "Pickup Details") continue;

        const q = parseInt(li.quantity || "0", 10);
        if (!isNaN(q)) donutsInOrder += q;
      }

      if (donutsInOrder <= 0) continue;

      // עדכון סך ליום
      if (!countsByDate[pickupDate]) countsByDate[pickupDate] = 0;
      countsByDate[pickupDate] += donutsInOrder;

      // דחיפת ההזמנה ל־UI של Paid Orders
      const pickupTime = pickupAt.slice(11, 16);

      cleanedOrders.push({
        id: order.id,
        pickupDate,
        pickupTime,
        donuts: donutsInOrder,
        total: (netAmount / 100).toFixed(2),
        createdAt: order.closed_at || order.created_at || "",
      });
    }

    // -------- 4) בניית סיכום ימים לאדמין --------
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
