import store from "../lib/store.js";
import { stateStore } from "../lib/blob-store.mjs";
import squareApi from "../lib/square.js";

const MINUTE = 60 * 1000;

export default async (_request, context) => store.handle(async () => {
  const db = stateStore(context);
  const { data } = await store.readState(db);
  const now = Date.now();
  const oldDate = store.localDate(now - 7 * 86400000);
  const expired = Object.entries(data.bookings).flatMap(([date, bookings]) =>
    bookings.filter(booking => booking.expires <= now && (!booking.checked || booking.checked <= now)).map(booking => ({ date, ...booking }))
  ).sort((a, b) => (a.checked || a.expires) - (b.checked || b.expires)).slice(0, 24);

  const updates = new Map();
  for (let index = 0; index < expired.length; index += 12) {
    await Promise.all(expired.slice(index, index + 12).map(async booking => {
      try {
        updates.set(booking.link, await review(context, booking));
      } catch (error) {
        updates.set(booking.link, { checked: now + 10 * MINUTE });
        console.error("Ricotta hold review:", error.message);
      }
    }));
  }
  if (updates.size || Object.keys(data.bookings).some(date => date < oldDate)) {
    await store.changeState(db, state => {
      for (const [date, bookings] of Object.entries(state.bookings)) {
        state.bookings[date] = bookings.flatMap(booking => {
          const update = updates.get(booking.link);
          if (update === null) return [];
          const next = { ...booking, ...update };
          return date < oldDate && next.paid ? [] : [next];
        });
        if (!state.bookings[date].length) delete state.bookings[date];
      }
      return true;
    });
  }
  return store.reply({ reviewed: updates.size });
});

async function review(context, booking) {
  const { order } = await squareApi.square(context, "/v2/orders/" + encodeURIComponent(booking.order));
  if (!order || order.id !== booking.order) throw new Error("Square order could not be verified.");
  if (order.state === "CANCELED") return null;

  if (order.state === "COMPLETED" || order.tenders?.length) {
    const units = squareApi.netUnits(order);
    if (!units) return null;
    return { units, paid: true, checked: Date.now() + 60 * MINUTE };
  }
  const result = await squareApi.square(context, "/v2/online-checkout/payment-links/" + encodeURIComponent(booking.link), "DELETE");
  if (result.cancelled_order_id !== booking.order) throw new Error("Square link cancellation could not be verified.");
  return null;
}

export const config = { schedule: "*/5 * * * *" };
