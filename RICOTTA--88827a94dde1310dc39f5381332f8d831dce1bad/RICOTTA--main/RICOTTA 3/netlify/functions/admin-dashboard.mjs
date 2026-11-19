import store from "../lib/store.js";
import { stateStore } from "../lib/blob-store.mjs";
import auth from "../lib/admin-auth.js";
import squareApi from "../lib/square.js";

export default async (request, context) => store.handle(async () => {
  if (request.method !== "GET") return store.reply({}, 405);
  auth.requireAdmin(request);
  const params = new URL(request.url).searchParams;
  const now = Date.now();
  const from = params.get("from") || store.localDate(now - 13 * 86400000);
  const to = params.get("to") || store.localDate(now);
  if (!store.validDate(from) || !store.validDate(to) || from > to ||
      Date.parse(to) - Date.parse(from) > 30 * 86400000) {
    throw new store.HttpError(400, "בחרו טווח של עד 31 ימים.");
  }

  const nextDate = new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10);
  const { data } = await store.readState(stateStore(context));
  const { maxUnits, maxOrders } = data.settings.schedule;
  const days = store.upcomingDays(data).slice(0, 7).map(day => ({
    date: day.date, units: maxUnits - day.unitsLeft, maxUnits,
    orders: (data.bookings[day.date] || []).length, maxOrders,
  }));
  const { token, location } = squareApi.squareConfig(context);
  if (!token || !location) return store.reply({ days, orders: [], configured: false });
  const orders = await squareApi.paidOrders(context, store.pickupInstant(from, "00:00"), store.pickupInstant(nextDate, "00:00"));
  return store.reply({ days, orders, configured: true });
});
