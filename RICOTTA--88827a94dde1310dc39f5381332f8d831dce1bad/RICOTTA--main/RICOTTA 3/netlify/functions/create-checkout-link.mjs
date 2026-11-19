import { randomUUID } from "node:crypto";
import store from "../lib/store.js";
import squareApi from "../lib/square.js";

const RESERVATION_MS = 15 * 60 * 1000;

export default async (request, context) => store.handle(async () => {
  if (request.method !== "POST") return store.reply({}, 405);
  const draft = await store.readJSON(request);
  const { cartItems, pickupDate, pickupTime, customerName, customerEmail, customerPhone, notes } = draft || {};
  if (!Array.isArray(cartItems) || cartItems.length < 1 || cartItems.length > 80 || !store.validDate(pickupDate)) {
    throw new store.HttpError(400, "Choose products and a pickup date.");
  }
  const name = store.text(customerName, 100, true);
  const email = store.text(customerEmail, 120, true);
  const phone = store.text(customerPhone, 32, true);
  const memo = store.text(notes ?? "", 300);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\+?[\d\s().-]{7,32}$/.test(phone)) {
    throw new store.HttpError(400, "Enter a valid email address and phone number.");
  }

  const db = store.stateStore(context);
  const { data } = await store.readState(db);
  const products = new Map(data.settings.products.filter(product => product.active).map(product => [product.id, product]));
  const usedIds = new Set();
  let units = 0;
  const lineItems = cartItems.map(item => {
    const product = products.get(item?.id);
    if (!product || item.unitAmountCents !== product.price) {
      throw new store.HttpError(409, "The menu or prices changed. Review your updated cart and try again.");
    }
    if (usedIds.has(product.id) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 5000) {
      throw new store.HttpError(400, "Check the quantities in your cart.");
    }
    usedIds.add(product.id);
    units += item.quantity;
    return { name: product.name, quantity: String(item.quantity), base_price_money: { amount: product.price, currency: "USD" } };
  });
  const slot = checkCapacity(data, pickupDate, pickupTime, units);
  const key = randomUUID();
  const { location } = squareApi.squareConfig(context);
  const pickupLabel = `Pickup: ${pickupDate} (${slot.from}–${slot.to}) New York`;
  const info = [pickupLabel, memo].filter(Boolean);
  const origin = new URL(request.url).origin;
  const body = {
    idempotency_key: key,
    order: {
      location_id: location,
      reference_id: key,
      line_items: lineItems,
      taxes: [{ uid: "default-tax", name: "Sales Tax", type: "ADDITIVE", scope: "ORDER", percentage: "8.875" }],
      fulfillments: [{
        type: "PICKUP", state: "PROPOSED",
        pickup_details: {
          schedule_type: "SCHEDULED", pickup_at: slot.at, note: info.join("\n"),
          recipient: { display_name: name, phone_number: phone, email_address: email },
        },
      }],
    },
    checkout_options: { redirect_url: origin + "/success.html" },
    pre_populated_data: { buyer_email: email },
  };

  const result = await squareApi.square(context, "/v2/online-checkout/payment-links", "POST", body);
  const link = result.payment_link;
  if (!link?.id || !link.order_id || !link.url) throw new Error("Square did not return a complete payment link.");

  try {
    await store.changeState(db, state => {
      if (state.settings.revision !== data.settings.revision) {
        throw new store.HttpError(409, "The store settings changed. Review your cart and try again.");
      }
      checkCapacity(state, pickupDate, pickupTime, units);
      const bookings = state.bookings[pickupDate] ||= [];
      bookings.push({ units, expires: Date.now() + RESERVATION_MS, link: link.id, order: link.order_id });
      return true;
    });
  } catch (error) {
    try {
      await squareApi.square(context, "/v2/online-checkout/payment-links/" + encodeURIComponent(link.id), "DELETE");
    } catch (cancelError) {
      console.error("Ricotta: could not cancel an undisclosed Square payment link.", cancelError.message);
    }
    throw error;
  }

  return store.reply({ payment_link: { url: link.url } });
});

function checkCapacity(state, date, time, units) {
  const day = store.upcomingDays(state).find(day => day.date === date);
  const slot = day?.slots.find(slot => slot.from === time);
  if (!slot) throw new store.HttpError(409, "This pickup time is unavailable. Please choose another time.");
  if (day.ordersLeft === 0 || day.unitsLeft === 0) {
    throw new store.HttpError(409, "This date is fully booked. Please choose another date.");
  }
  if (units > day.unitsLeft) {
    throw new store.HttpError(409, `Only ${day.unitsLeft} items are available for that date. Reduce the quantity or select another date.`);
  }
  return slot;
}

export const config = {
  path: "/api/checkout",
  rateLimit: { windowLimit: 12, windowSize: 120, aggregateBy: ["ip"] },
};
