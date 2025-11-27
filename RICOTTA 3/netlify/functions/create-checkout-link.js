// netlify function: create-checkout-link

const https = require('https');

function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).trim();
  if (!p) return null;

  // אם המשתמש כבר כתב בפורמט בינלאומי
  if (p.startsWith('+')) {
    const digits = p.replace(/\D/g, '');
    if (digits.length >= 8) return p;
  }

  const digits = p.replace(/\D/g, '');

  // 10 ספרות -> נניח טלפון אמריקאי רגיל
  if (digits.length === 10) {
    return '+1' + digits;
  }

  // 11 ספרות ומתחיל ב-1
  if (digits.length === 11 && digits[0] === '1') {
    return '+' + digits;
  }

  // כל דבר אחר – לא שולחים בכלל טלפון לסקוור
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;

  if (!accessToken || !locationId) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Server misconfiguration',
        message: 'Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID'
      })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    const {
      cartItems,
      currency,
      redirectUrlBase,
      pickupDate,
      pickupTime,
      customerName,
      customerPhone,
      customerEmail,
      idempotencyKey
    } = body;

    if (!Array.isArray(cartItems) || !cartItems.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Cart is empty' })
      };
    }

    const totalCents = cartItems.reduce(
      (sum, item) => sum + (item.unitAmountCents || 0) * (item.quantity || 0),
      0
    );

    if (!totalCents || !currency) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid amount or currency' })
      };
    }

    const normalizedPhone = normalizePhone(customerPhone);

    const paymentLinkBody = {
      idempotency_key:
        idempotencyKey ||
        `ricotta-checkout-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`,
      quick_pay: {
        name: 'RICOTTA Donuts Preorder',
        price_money: {
          amount: totalCents,
          currency: currency
        },
        location_id: locationId,
        note: `Pickup: ${pickupDate || '-'} ${pickupTime || '-'} | Name: ${
          customerName || '-'
        } | Phone: ${customerPhone || '-'} | Email: ${customerEmail || '-'}`
      },
      checkout_options: {
        redirect_url: `${(redirectUrlBase || '').replace(
          /\/$/,
          ''
        )}/success.html`,
        ask_for_shipping_address: false,
        allow_tipping: false,
        merchant_support_email: process.env.SQUARE_SUPPORT_EMAIL || undefined
      },
      pre_populated_data: {
        buyer_email: customerEmail || undefined,
        buyer_phone_number: normalizedPhone || undefined
      },
      metadata: {
        cart_json: JSON.stringify(cartItems),
        pickup_date: pickupDate || '',
        pickup_time: pickupTime || '',
        customer_name: customerName || '',
        customer_phone: customerPhone || '',
        customer_email: customerEmail || ''
      }
    };

    const postData = JSON.stringify(paymentLinkBody);

    const options = {
      hostname: 'connect.squareup.com',
      path: '/v2/checkout/payment-links',
      method: 'POST',
      headers: {
        'Square-Version': '2024-09-18',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    return await new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            parsed = { raw: data };
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({
              statusCode: res.statusCode || 500,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(parsed)
            });
          }

          return resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
          });
        });
      });

      req.on('error', (error) => {
        console.error('Square checkout link error:', error);
        resolve({
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Checkout link creation failed',
            message: error.message
          })
        });
      });

      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('Handler error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: err.message
      })
    };
  }
};
