// netlify/functions/create-checkout-link.js
const https = require("https");
const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const MAX_DAILY_LIMIT = 250; // מקסימום דונאטס ליום (לפי תאריך איסוף)

// קריאה כללית ל־Square
function callSquare(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const postData = bodyObj ? JSON.stringify(bodyObj) : null;

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

    if (postData) {
      options.headers["Content-Length"] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        let json;
        try {
          json = data ? JSON.parse(data) : {};
        } catch (e) {
          json = { raw: data, parseError: e.message };
        }

        resolve({
          statusCode: res.statusCode,
          body: json,
        });
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

exports.handler = async (event) => {
  // מאפשרים רק POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  if (!SQUARE_ACCESS_TOKEN) {
    console.error("Missing SQUARE_ACCESS_TOKEN env var");
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server configuration error",
        detail: "Missing Square access token",
      }),
    };
  }

  try {
    const {
      cartItems,
      currency = "USD",
      redirectUrlBase,
      pickupDate,
      pickupTime,
      customerName,
      customerPhone,
      customerEmail,
    } = JSON.parse(event.body || "{}");

    // ולידציה בסיסית
    if (
      !cartItems ||
      !Array.isArray(cartItems) ||
      cartItems.length === 0 ||
      !redirectUrlBase
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing required fields",
        }),
      };
    }

    // מחשבים כמה דונאטס הלקוח מבקש בהזמנה הזאת
    const requestedQty = cartItems.reduce(
      (sum, item) => sum + (Number(item.quantity) || 0),
      0
    );

    if (!pickupDate) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "MISSING_PICKUP_DATE",
          message: "Pickup date is required.",
        }),
      };
    }

    // 1) שולפים את רשימת ה-locations מהחשבון שלך ב-Square
    const locationsRes = await callSquare("/v2/locations", "GET");
    if (locationsRes.statusCode >= 400 || locationsRes.body.errors) {
      console.error("Square locations error:", locationsRes.body);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to fetch Square locations",
          details: locationsRes.body,
        }),
      };
    }

    const locations = locationsRes.body.locations || [];
    if (!locations.length) {
      console.error("No locations found on Square account");
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "No locations configured in Square",
        }),
      };
    }

    // בוחרים לוקיישן שיכול לעבד כרטיסי אשראי
    const selectedLocation =
      locations.find((loc) =>
        (loc.capabilities || []).includes("CREDIT_CARD_PROCESSING")
      ) || locations[0];

    const locationId = selectedLocation.id;

    // 2) BEFORE creating the Payment Link – בודקים כמה כבר מוזמן ל־pickupDate הזה
    //    נשתמש ב-Search Orders API ונפילטר לפי "Pickup: YYYY-MM-DD" בתוך ה-note
    let alreadyOrderedForThisDate = 0;
    try {
      const searchBody = {
        location_ids: [locationId],
        query: {
          filter: {
            state_filter: {
              states: ["OPEN", "COMPLETED"], // גם הזמנות פתוחות וגם הושלמו
            },
          },
        },
      };

      const ordersRes = await callSquare(
        "/v2/orders/search",
        "POST",
        searchBody
      );

      if (ordersRes.statusCode >= 400 || ordersRes.body.errors) {
        console.error("Square search orders error:", ordersRes.body);
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: "AVAILABILITY_CHECK_FAILED",
            message:
              "We could not verify today's availability. Please try again in a moment.",
          }),
        };
      }

      const orders = ordersRes.body.orders || [];

      for (const order of orders) {
        const note = order.note || "";
        const lineItems = order.line_items || [];
        // רק הזמנות שה-note שלהן מכיל את אותו תאריך איסוף
        if (!note.includes(`Pickup: ${pickupDate}`)) continue;

        for (const li of lineItems) {
          const qty = parseInt(li.quantity || "0", 10);
          if (!Number.isNaN(qty)) {
            alreadyOrderedForThisDate += qty;
          }
        }
      }
    } catch (e) {
      console.error("Error while checking daily limit:", e);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "AVAILABILITY_CHECK_FAILED",
          message:
            "We could not verify today's availability. Please try again in a moment.",
        }),
      };
    }

    const remaining = MAX_DAILY_LIMIT - alreadyOrderedForThisDate;

    if (requestedQty > remaining) {
      // אין מספיק מקום לתאריך הזה
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: "DAILY_LIMIT_REACHED",
          remaining: Math.max(0, remaining),
          message:
            remaining > 0
              ? `Only ${remaining} donuts left for ${pickupDate}. Please reduce your quantity or choose another date.`
              : `We're sold out for ${pickupDate}. Please select another date.`,
        }),
      };
    }

    // 3) בונים את ה-Order לפי העגלה
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity || 1),
      base_price_money: {
        amount: item.unitAmountCents,
        currency,
      },
    }));

    const noteParts = [
      pickupDate && pickupTime ? `Pickup: ${pickupDate} ${pickupTime}` : null,
      customerName ? `Customer: ${customerName}` : null,
      customerPhone ? `Phone: ${customerPhone}` : null,
      customerEmail ? `Email: ${customerEmail}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const order = {
      location_id: locationId,
      line_items: lineItems,
      note: noteParts,
      metadata: {
        pickup_date: pickupDate || "",
        pickup_time: pickupTime || "",
        customer_name: customerName || "",
        customer_phone: customerPhone || "",
        customer_email: customerEmail || "",
      },
    };

    // idempotency key בטוח (גם אם randomUUID לא קיים)
    const idempotencyKey = crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");

    // 4) יוצרים Payment Link
    const checkoutBody = {
      idempotency_key: idempotencyKey,
      order,
      checkout_options: {
        redirect_url: `${redirectUrlBase.replace(/\/$/, "")}/success.html`,
      },
    };

    const checkoutRes = await callSquare(
      "/v2/online-checkout/payment-links",
      "POST",
      checkoutBody
    );

    if (checkoutRes.statusCode >= 400 || checkoutRes.body.errors) {
      console.error("Square checkout error:", checkoutRes.body);
      return {
        statusCode: checkoutRes.statusCode || 400,
        body: JSON.stringify(checkoutRes.body),
      };
    }

    // מחזירים ל-frontend את האובייקט כולו, ובתוכו payment_link.url
    return {
      statusCode: 200,
      body: JSON.stringify(checkoutRes.body),
    };
  } catch (err) {
    console.error("Handler error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        message: err.message,
      }),
    };
  }
};
