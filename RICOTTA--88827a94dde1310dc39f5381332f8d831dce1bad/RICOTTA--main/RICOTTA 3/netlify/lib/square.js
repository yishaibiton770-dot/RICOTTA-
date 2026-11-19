const { localParts, isProduction } = require("./store");

function squareConfig(context) {
  return isProduction(context)
    ? { host: "https://connect.squareup.com", token: process.env.SQUARE_ACCESS_TOKEN, location: process.env.SQUARE_LOCATION_ID || "L54AH5T8V5HVN" }
    : { host: "https://connect.squareupsandbox.com", token: process.env.SQUARE_SANDBOX_ACCESS_TOKEN, location: process.env.SQUARE_SANDBOX_LOCATION_ID };
}

async function square(context, path, method = "GET", body) {
  const { host, token, location } = squareConfig(context);
  if (!token || !location) throw new Error("Square is not configured for this deploy context.");
  const response = await fetch(host + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Square-Version": "2025-01-15", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(7500),
  });
  const data = await response.json();
  if (!response.ok || data.errors?.length) {
    const error = new Error(`Square ${method} ${path.split("?")[0]} returned ${response.status}.`);
    error.status = response.status;
    if (response.status >= 500) console.error(error.message);
    throw error;
  }
  return data;
}

function netUnits(order) {
  if (order.state === "CANCELED") return 0;
  const sum = lines => (lines || []).reduce((total, line) => {
    const qty = Number(line.quantity);
    return total + (line.name === "Pickup Details" || !Number.isInteger(qty) || qty < 0 ? 0 : qty);
  }, 0);
  return Math.max(0, sum(order.line_items) - (order.returns || []).reduce(
    (total, item) => total + sum(item.return_line_items), 0
  ));
}

async function paidOrders(context, from, to) {
  const amountByOrder = new Map();
  const { location } = squareConfig(context);
  let cursor;
  do {
    const params = new URLSearchParams({ begin_time: from, end_time: to, location_id: location, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const data = await square(context, "/v2/payments?" + params);
    for (const payment of data.payments || []) {
      if (payment.status !== "COMPLETED" || !payment.order_id) continue;
      const amount = (payment.total_money?.amount || payment.amount_money?.amount || 0) - (payment.refunded_money?.amount || 0);
      amountByOrder.set(payment.order_id, (amountByOrder.get(payment.order_id) || 0) + amount);
    }
    cursor = data.cursor;
  } while (cursor);

  const ids = [...amountByOrder.keys()];
  const orders = [];
  for (let index = 0; index < ids.length; index += 50) {
    const result = await square(context, "/v2/orders/batch-retrieve", "POST", {
      location_id: location, order_ids: ids.slice(index, index + 50),
    });
    for (const order of result.orders || []) {
      const pickup = (order.fulfillments || []).find(f => f.type === "PICKUP")?.pickup_details;
      if (!pickup?.pickup_at || !Number.isFinite(Date.parse(pickup.pickup_at))) continue;
      const { year, month, day, hour, minute } = localParts(Date.parse(pickup.pickup_at));
      orders.push({
        id: order.id, pickupDate: `${year}-${month}-${day}`, pickupTime: `${hour}:${minute}`,
        donuts: amountByOrder.get(order.id) > 0 ? netUnits(order) : 0,
        total: Math.max(0, amountByOrder.get(order.id)) / 100,
        created_at: order.created_at || "",
      });
    }
  }
  return orders.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

module.exports = { square, squareConfig, netUnits, paidOrders };
