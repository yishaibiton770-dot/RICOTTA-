// netlify/functions/create-checkout-link.js

const https = require("https");
const crypto = require("crypto");

/** ==== SQUARE CONFIG ==== */
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN";
const TAX_PERCENT = "8.875"; // tax is calculated *inside* Square

/** ==== SUPABASE CONFIG ==== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DAILY_LIMIT = 250; // מקסימום 250 סופגניות ליום

/** -------- Generic HTTPS helper -------- */
function callHttps(hostname, path, method, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const options = {
      hostname,
      path,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          json = data ? { raw: data } : {};
        }
        resolve({ statusCode: res.statusCode, body: json });
      });
    });

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
}

/** -------- Square helper -------- */
function callSquare(path, method, bodyObj) {
  return callHttps(
    "connect.squareup.com",
    path,
    method,
    {
      "Square-Version": "2025-01-15",
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    bodyObj
  );
}

/** -------- Supabase helper (REST) -------- */
function callSupabase(path, method, bodyObj) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    // אם לא מוגדר – לא חוסם את התשלום, פשוט מדלג על מגבלה
    return Promise.resolve({
      statusCode: 501,
      body: { error: "Supabase not configured" },
    });
  }

  const url = new URL(SUPABASE_URL);

  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  return callHttps(url.hostname, `${url.pathname}/rest/v1${path}`, method, headers, bodyObj);
}

/** =======================================================
 *                Netlify Function Handler
 * =======================================================*/
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return { statusCode: 500, body: "Missing SQUARE_ACCESS_TOKEN" };
  }

  try {
    const payload = JSON.parse(event.body || "{}");

    const {
      cartItems,
      currency = "USD",
      redirectUrlBase,
      pickupDate,
      pickupTime, // "10:00 - 11:00"
      pickupWindow, // לא חובה מהפרונט
      customerName,
      customerPhone,
      customerEmail,
      notes,
    } = payload;

    if (!cartItems || !cartItems.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "cartItems is required" }),
      };
    }

    if (!pickupDate) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Pickup date is required" }),
      };
    }

    /** ============ 1. INVENTORY LIMIT (SUPABASE) ============ */
    const totalUnitsInOrder = cartItems.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );

    let usedToday = 0;
    let inventoryRow = null;

    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      // 1. לקרוא מה־DB כמה כבר הוזמן לתאריך הזה
      const invRes = await callSupabase(
        `/daily_inventory?date=eq.${pickupDate}&select=id,total_units&limit=1`,
        "GET"
      );

      if (invRes.statusCode === 200 && Array.isArray(invRes.body) && invRes.body.length > 0) {
        inventoryRow = invRes.body[0];
        usedToday = Number(inventoryRow.total_units || 0);
      }

      const newTotal = usedToday + totalUnitsInOrder;

      if (newTotal > DAILY_LIMIT) {
        const remaining = Math.max(DAILY_LIMIT - usedToday, 0);
        const msg =
          remaining <= 0
            ? "We’re fully booked for this date. Please choose another date."
            : `Only ${remaining} donuts left for this date. Please reduce your quantity or choose another date.`;

        return {
          statusCode: 400,
          body: JSON.stringify({ error: msg, code: "INVENTORY_LIMIT" }),
        };
      }

      // 2. לעדכן / ליצור רשומה חדשה
      if (inventoryRow) {
        const updateRes = await callSupabase(
          `/daily_inventory?id=eq.${inventoryRow.id}`,
          "PATCH",
          { total_units: newTotal }
        );
        if (updateRes.statusCode >= 400) {
          console.error("Supabase update error:", updateRes.body);
        }
      } else {
        const insertRes = await callSupabase(`/daily_inventory`, "POST", {
          date: pickupDate,
          total_units: newTotal,
        });
        if (insertRes.statusCode >= 400) {
          console.error("Supabase insert error:", insertRes.body);
        }
      }
    }

    /** ============ 2. BUILD PICKUP TEXT ============ */
    let pickupLabel = "";
    let pickupAt = null;

    if (pickupDate && pickupTime) {
      const d = new Date(pickupDate + "T12:00:00");
      const weekday = d.toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: "America/New_York",
      });
      const niceDate = d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      });

      pickupLabel = `Pickup: ${weekday}, ${niceDate} (${pickupTime.replace(
        "-",
        "–"
      )})`;

      const fromStr =
        (pickupWindow && pickupWindow.from) ||
        (pickupTime.match(/^(\d{2}:\d{2})/)
          ? pickupTime.match(/^(\d{2}:\d{2})/)[1]
          : "10:00");

      pickupAt = `${pickupDate}T${fromStr}:00-05:00`; // America/New_York
    } else if (pickupDate) {
      pickupLabel = `Pickup: ${pickupDate}`;
    }

    const infoLines = [
      pickupLabel,
      customerName ? `Name: ${customerName}` : "",
      customerPhone ? `Phone: ${customerPhone}` : "",
      customerEmail ? `Email: ${customerEmail}` : "",
      notes ? `Notes: ${notes}` : "",
    ].filter(Boolean);

    const infoText = infoLines.join("\n");

    /** ============ 3. BUILD ORDER LINE ITEMS ============ */
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: Math.round(item.unitAmountCents), // לפני מס
        currency,
      },
    }));

    // שורת מידע באפס דולר שתופיע על הטיקט
    if (infoText) {
      lineItems.push({
        name: "Pickup Details",
        quantity: "1",
        base_price_money: { amount: 0, currency },
        note: infoText,
      });
    }

    /** ============ 4. FULFILLMENT לדשבורד ============ */
    const fulfillments = pickupAt
      ? [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickup_details: {
              schedule_type: "SCHEDULED",
              pickup_at: pickupAt,
              note: infoText,
              recipient: {
                display_name: customerName || "",
                phone_number: customerPhone || "",
                email_address: customerEmail || "",
              },
            },
          },
        ]
      : undefined;

    /** ============ 5. ORDER כולל TAX אמיתי ============ */
    const order = {
      location_id: LOCATION_ID,
      line_items: lineItems,
      taxes: [
        {
          uid: "default-tax",
          name: "Sales Tax",
          type: "ADDITIVE",
          scope: "ORDER",
          percentage: TAX_PERCENT,
        },
      ],
    };

    if (fulfillments) {
      order.fulfillments = fulfillments;
    }

    const body = {
      idempotency_key: crypto.randomBytes(16).toString("hex"),
      order,
      checkout_options: {
        redirect_url: `${redirectUrlBase || ""}/success.html`,
      },
    };

    /** ============ 6. CALL SQUARE ============ */
    const result = await callSquare(
      "/v2/online-checkout/payment-links",
      "POST",
      body
    );

    if (result.statusCode >= 400 || result.body.errors) {
      console.error("Square error:", result.body);
      return {
        statusCode: 400,
        body: JSON.stringify({
          error:
            result.body.errors?.[0]?.detail ||
            "Error creating Square payment link",
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(result.body),
    };
  } catch (err) {
    console.error("Function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message || "Unexpected server error",
      }),
    };
  }
};
