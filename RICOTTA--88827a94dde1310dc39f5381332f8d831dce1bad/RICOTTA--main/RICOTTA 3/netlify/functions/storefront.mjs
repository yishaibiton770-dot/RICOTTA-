import store from "../lib/store.js";

export default async (request, context) => store.handle(async () => {
  if (request.method !== "GET") return store.reply({}, 405);
  const { data } = await store.readState(store.stateStore(context));
  const today = store.localDate(Date.now());
  const { products, schedule, messages } = data.settings;
  return store.reply({
    products: products.filter(product => product.active),
    days: store.upcomingDays(data),
    hours: schedule.hours,
    paused: schedule.paused,
    season: { start: schedule.start, end: schedule.end },
    messages: messages.filter(message => message.active && (!message.start || message.start <= today) &&
      (!message.end || message.end >= today)).map(message => message.text),
  });
});
