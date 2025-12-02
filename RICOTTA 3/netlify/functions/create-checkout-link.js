// netlify/functions/create-checkout-link.js

const crypto = require("crypto");
const { Client, Environment } = require("square");

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.SQUARE_ENVIRONMENT === "production"
      ? Environment.Production
      : Environment.Sandbox,
});

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const TAX_RATE = 0.08875; // 8.875%

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const payload = JSON.parse(event.body || "{}");

    const {
      cartItems,
      currency = "USD",
      redirectUrlBase,
      pickupDate,
      pickupWindow, // { start: "2025-12-18T10:00:00", end: "2025-12-18T11:00:00" }
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

    /* -----------------------------
       סכומים
    ------------------------------ */
    const subtotalCents = cartItems.reduce(
      (sum, item) =>
        sum + (Number(item.unitAmountCents) || 0) * (Number(item.quantity) || 0),
      0
    );

    const taxCents = Math.round(subtotalCents * TAX_RATE);
    const totalCents = subtotalCents + taxCents; // רק אם תרצה להשתמש בזה בעתיד

    /* -----------------------------
       שורות מוצרים
    ------------------------------ */
    const lineItems = cartItems.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount: Math.round(item.unitAmountCents),
        currency,
      },
    }));

    // נבנה טקסט יפה לשורת ה-Pickup
    let pickupLabel = "";
    if (pickupWindow && pickupWindow.start && pickupWindow.end) {
      const day = pickupWindow.start.slice(0, 10); // YYYY-MM-DD
      const from = pickupWindow.start.slice(11, 16); // HH:MM
      const to = pickupWindow.end.slice(11, 16); // HH:MM
      pickupLabel = `${day} ${from}-${to}`;
    } else if (pickupDate) {
      pickupLabel = pickupDate;
    }

    const pickupInfoLine = [
      `Name: ${customerName || ""}`,
      customerPhone ? `Phone: ${customerPhone}` : "",
      customerEmail ? `Email: ${customerEmail}` : "",
      notes ? `Notes: ${notes}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    // 👇 שורת INFO ב-$0 שתודפס על הטיקט
    lineItems.push({
      name: `Pickup ${pickupLabel}`,
      quantity: "1",
      base_price_money: {
        amount: 0,
        currency,
      },
      note: pickupInfoLine,
    });

    /* -----------------------------
       Fulfillment (איסוף)
    ------------------------------ */
    const fulfillment =
      pickupWindow && pickupWindow.start
        ? [
            {
              type: "PICKUP",
              state: "PROPOSED",
              pickup_details: {
                schedule_type: "SCHEDULED",
                pickup_at: pickupWindow.start, // סקוור משתמשת בזה לזמן האיסוף
                note: `Pickup ${pickupLabel} | ${pickupInfoLine}`,
                recipient: {
                  display_name: customerName,
                  phone_number: customerPhone,
                  email_address: customerEmail,
                },
              },
            },
          ]
        : undefined;

    /* -----------------------------
       יצירת לינק תשלום
    ------------------------------ */
    const idempotencyKey = crypto.randomUUID();

    const { result } = await client.checkoutApi.createPaymentLink({
      idempotencyKey,
      order: {
        location_id: LOCATION_ID,
        line_items: lineItems,
        fulfillments: fulfillment,
      },
      checkoutOptions: {
        redirectUrl: `${redirectUrlBase}/thanks.html`,
      },
      prePopulatedData: {
        buyerEmail: customerEmail,
        buyerPhoneNumber: customerPhone,
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ payment_link: result.paymentLink }),
    };
  } catch (error) {
    console.error("Square function error:", error);
    const message =
      error?.body?.errors?.[0]?.detail ||
      error?.message ||
      "Unexpected server error";
    return {
      statusCode: 500,
      body: JSON.stringify({ error: message }),
    };
  }
};
