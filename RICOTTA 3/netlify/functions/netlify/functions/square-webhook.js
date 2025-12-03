// netlify/functions/square-webhook.js
const https = require("https");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

async function supabaseFetch(path, options = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...(options.headers || {}),
  };

  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers,
  });

  return res;
}

async function getInventoryRow(pickupDate) {
  const res = await supabaseFetch(
    `/rest/v1/daily_inventory?select=date,total_donuts&date=eq.${pickupDate}`
  );

  if (!res.ok) {
    const txt = await res.text();
    console.error("Supabase getInventoryRow error:", txt);
    throw new Error("Supabase getInventoryRow failed");
  }

  const rows = await res.json();
  if (!rows.length) {
    return { total: 0, exists: false };
  }
  return { total: rows[0].total_donuts || 0, exists: true };
}

async function addPaidDonuts(pickupDate, donuts, paymentId) {
  // קודם רושמים את התשלום בטבלת square_payments – כדי לא לספור פעמיים
  const payRes = await supabaseFetch("/rest/v1/square_payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify([
      {
        payment_id: paymentId,
        pickup_date: pickupDate,
        donuts,
      },
    ]),
  });

  if (!payRes.ok) {
    const txt = await payRes.text();
    console.error("Supabase insert square_payments error:", txt);
    // אם כבר קיים – לא נמשיך (כדי לא לספור פעמיים)
    return;
  }

  // עכשיו מעדכנים את ה־daily_inventory
  const { total, exists } = await getInventoryRow(pickupDate);
  const newTotal = total + donuts;

  if (!exists) {
    const ins = await supabaseFetch("/rest/v1/daily_inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ date: pickupDate, total_donuts: newTotal }]),
    });

    if (!ins.ok) {
      const txt = await ins.text();
      console.error("Supabase insert daily_inventory error:", txt);
    }
  } else {
    const upd = await supabaseFetch(
      `/rest/v1/daily_inventory?date=eq.${pickupDate}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ total_donuts: newTotal }),
      }
    );

    if (!upd.ok) {
      const txt = await upd.text();
      console.error("Supabase update daily_inventory error:", txt);
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!SQUARE_ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing env vars");
    return { statusCode: 500, body: "Missing configuration" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("Invalid JSON in webhook:", e);
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const type = body.type || body.event_type;
  const payment = body.data?.object?.payment;

  // אנחנו מטפלים רק ב־payment.updated / payment.created עם status COMPLETED
  if (
    !payment ||
    !["payment.updated", "payment.created"].includes(type) ||
    payment.status !== "COMPLETED"
  ) {
    return { statusCode: 200, body: "Ignored" };
  }

  const paymentId = payment.id;
  const orderId = payment.order_id || payment.orderIds?.[0];

  if (!orderId) {
    console.error("No order_id on payment:", payment);
    return { statusCode: 200, body: "No order_id" };
  }

  try {
    // מושכים את ההזמנה המלאה
    const orderRes = await callSquare(`/v2/orders/${orderId}`, "GET");
    if (orderRes.statusCode >= 400 || orderRes.body.errors) {
      console.error("Square get order error:", orderRes.body);
      return { statusCode: 500, body: "Order fetch error" };
    }

    const order = orderRes.body.order;
    const lineItems = order.line_items || [];
    const fulfillments = order.fulfillments || [];

    // נספר רק שורות שמוכרות סופגניות (amount > 0)
    let donuts = 0;
    for (const li of lineItems) {
      const amount = Number(li.base_price_money?.amount ?? 0);
      const qty = parseInt(li.quantity || "0", 10);
      if (amount > 0 && qty > 0) {
        donuts += qty;
      }
    }

    const f = fulfillments[0];
    const pickupAt = f?.pickup_details?.pickup_at || null;
    const pickupDate = pickupAt ? pickupAt.slice(0, 10) : null; // YYYY-MM-DD

    if (!pickupDate || !donuts) {
      console.error("Missing pickupDate or donuts", { pickupDate, donuts });
      return { statusCode: 200, body: "Missing data" };
    }

    // עדכון Supabase – רק אחרי שהתשלום COMPLETED
    await addPaidDonuts(pickupDate, donuts, paymentId);

    return { statusCode: 200, body: "OK" };
  } catch (e) {
    console.error("Webhook handler error:", e);
    return { statusCode: 500, body: "Server error" };
  }
};
