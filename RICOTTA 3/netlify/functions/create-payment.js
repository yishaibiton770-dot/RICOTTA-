const https = require('https');

exports.handler = async (event) => {
  // Allow only POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const { amountCents, currency, sourceId, idempotencyKey } = JSON.parse(event.body || '{}');

    // Validate
    if (!amountCents || !currency || !sourceId || !idempotencyKey) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required payment parameters' }),
      };
    }

    const postData = JSON.stringify({
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: {
        amount: amountCents,     // כבר בסנטים!
        currency: currency,
      },
      autocomplete: true,
    });

    const options = {
      hostname: 'connect.squareup.com',
      path: '/v2/payments',
      method: 'POST',
      headers: {
        'Square-Version': '2025-11-27', // כמו שביקשת
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    return new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: { 'Content-Type': 'application/json' },
            body: data,
          });
        });
      });

      req.on('error', (error) => {
        console.error('Payment request error:', error);
        resolve({
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Payment processing failed',
            message: error.message,
          }),
        });
      });

      req.write(postData);
      req.end();
    });
  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message,
      }),
    };
  }
};