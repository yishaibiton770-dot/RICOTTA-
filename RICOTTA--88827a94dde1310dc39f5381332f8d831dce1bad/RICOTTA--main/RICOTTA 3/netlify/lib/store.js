const defaults = {
  revision: 0,
  products: [
    { id: 1, name: "Dubai Donut", description: "Rich pistachio cream, crunchy knafeh & crushed pistachios.", price: 1000, image: "https://i.postimg.cc/0yqHh34y/1.png", category: "premium", active: true },
    { id: 2, name: "Crème Brûlée", description: "Crackly caramel glaze filled with rich, silky cream.", price: 1000, image: "https://i.postimg.cc/HkCPFKNY/4.png", category: "premium", active: true },
    { id: 3, name: "Lemon Meringue", description: "Tangy lemon cream topped with fluffy, torched meringue.", price: 1000, image: "https://i.postimg.cc/fRjgsC40/3.png", category: "premium", active: true },
    { id: 4, name: "Blueberry Cheesecake", description: "Rich cream cheese, cheesecake crumble, and topped with real blueberry jam.", price: 1000, image: "https://i.postimg.cc/pVmWdhLy/blwbryz-z-yyz.png", category: "premium", active: true },
    { id: 5, name: "Oreo Donut", description: "Smooth Oreo cream, white chocolate & crunchy crumbs.", price: 800, image: "https://i.postimg.cc/RZzb28YF/5.png", category: "classic", active: true },
    { id: 6, name: "Almond Cream", description: "Rich almond cream topped with crunchy roasted almonds.", price: 800, image: "https://i.postimg.cc/DwKYRDN1/2.png", category: "classic", active: true }
  ],
  schedule: {
    paused: true, start: "", end: "", maxUnits: 250, maxOrders: null,
    hours: Array.from({ length: 7 }, (_, i) => ({ open: i !== 6, from: "10:00", to: "16:00" }))
  },
  messages: [],
  reminders: [],
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ZONE = "America/New_York";
const localClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function localParts(date) {
  return Object.fromEntries(localClock.formatToParts(date).map(({ type, value }) => [type, value]));
}

function localDate(date) {
  const { year, month, day } = localParts(date);
  return `${year}-${month}-${day}`;
}

function pickupInstant(date, time) {
  const target = Date.parse(`${date}T${time}:00Z`);
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { year, month, day, hour, minute } = localParts(timestamp);
    const delta = target - Date.parse(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
    if (!delta) return new Date(timestamp).toISOString();
    timestamp += delta;
  }
  return null;
}

function timeString(minutes) {
  return [Math.floor(minutes / 60), minutes % 60].map(n => String(n).padStart(2, "0")).join(":");
}

function timeMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function slotsFor(schedule, date, now) {
  if (schedule.paused || (schedule.start && date < schedule.start) || (schedule.end && date > schedule.end)) return [];
  const day = schedule.hours[new Date(date).getUTCDay()];
  if (!day.open) return [];
  const close = timeMinutes(day.to);
  const slots = [];
  for (let time = timeMinutes(day.from); time < close; time += 60) {
    const from = timeString(time);
    const at = pickupInstant(date, from);
    if (at && Date.parse(at) > now + 15 * 60 * 1000) slots.push({ from, to: timeString(Math.min(time + 60, close)), at });
  }
  return slots;
}

function upcomingDays(state, now = Date.now()) {
  const start = Date.parse(localDate(now));
  const days = [];
  for (let offset = 0; offset < 30; offset++) {
    const date = new Date(start + offset * 86400000).toISOString().slice(0, 10);
    const slots = slotsFor(state.settings.schedule, date, now);
    if (slots.length) days.push({ date, slots, ...capacity(state, date) });
  }
  return days;
}

function capacity(state, date) {
  const bookings = state.bookings[date] || [];
  const { maxUnits, maxOrders } = state.settings.schedule;
  return {
    unitsLeft: Math.max(0, maxUnits - bookings.reduce((sum, booking) => sum + booking.units, 0)),
    ordersLeft: maxOrders === null ? null : Math.max(0, maxOrders - bookings.length),
  };
}

function isProduction(context) {
  return context?.deploy?.context === "production" && context.deploy.published === true;
}

function stateStore(context) {
  const { getStore, getDeployStore } = require("@netlify/blobs");
  const options = { name: "ricotta-store-v1", consistency: "strong" };
  return isProduction(context) ? getStore(options) : getDeployStore(options);
}

async function readState(store) {
  const entry = await store.getWithMetadata("state", { type: "json" });
  return entry || { data: { settings: structuredClone(defaults), bookings: {} }, etag: null };
}

async function changeState(store, change) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const { data, etag } = await readState(store);
    const result = change(data);
    if (result === false) return result;
    const conditions = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const write = await store.setJSON("state", data, conditions);
    if (write.modified) {
      if (!write.etag) throw new Error("The store could not verify the write.");
      return result;
    }
  }
  throw new HttpError(503, "The store is busy. Please try again.");
}

function text(value, max, required = false) {
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) {
    throw new HttpError(400, "Check the required fields and text lengths.");
  }
  return value.trim();
}

function validateSettings(input) {
  const invalid = () => { throw new HttpError(400, "Some settings are invalid."); };
  const limit = value => Number.isSafeInteger(value) && value >= 1 && value <= 5000;
  const list = (value, size) => Array.isArray(value) && value.length <= size;
  const { products, schedule, messages, reminders } = input || {};
  if (!list(products, 80) || !list(messages, 30) || !list(reminders, 50)) invalid();
  if (!schedule || typeof schedule.paused !== "boolean" || !limit(schedule.maxUnits) ||
      !(schedule.maxOrders === null || limit(schedule.maxOrders)) ||
      !(schedule.start === "" || validDate(schedule.start)) ||
      !(schedule.end === "" || validDate(schedule.end)) ||
      (schedule.start && schedule.end && schedule.start > schedule.end) ||
      !Array.isArray(schedule.hours) || schedule.hours.length !== 7) invalid();
  const cleanHours = schedule.hours.map(day => {
    if (!day || typeof day.open !== "boolean") invalid();
    const validHours = TIME.test(day.from) && TIME.test(day.to) && day.from < day.to;
    if (day.open && !validHours) invalid();
    return { open: day.open, from: validHours ? day.from : "10:00", to: validHours ? day.to : "16:00" };
  });
  const ids = new Set();
  const cleanProducts = products.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id) ||
        !Number.isSafeInteger(item.price) || item.price < 1 || item.price > 100000 ||
        !["classic", "premium"].includes(item.category) || typeof item.active !== "boolean") invalid();
    ids.add(item.id);
    const image = text(item.image, 500);
    if (image && !/^\/\.netlify\/functions\/product-image\?id=[a-f0-9]{64}$/.test(image)) {
      let imageUrl;
      try { imageUrl = new URL(image); } catch { invalid(); }
      if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password) invalid();
    }
    return {
      id: item.id, name: text(item.name, 100, true), description: text(item.description, 350),
      image, price: item.price, active: item.active, category: item.category,
    };
  });
  const cleanMessages = messages.map(message => {
    if (!message || typeof message.active !== "boolean" ||
        !(message.start === "" || validDate(message.start)) ||
        !(message.end === "" || validDate(message.end)) ||
        (message.start && message.end && message.start > message.end)) invalid();
    return { text: text(message.text, 350, true), active: message.active, start: message.start, end: message.end };
  });
  const cleanReminders = reminders.map(reminder => {
    if (!reminder || !validDate(reminder.date) || typeof reminder.done !== "boolean") invalid();
    return { text: text(reminder.text, 350, true), date: reminder.date, done: reminder.done };
  });
  return {
    products: cleanProducts,
    schedule: { paused: schedule.paused, start: schedule.start, end: schedule.end,
      maxUnits: schedule.maxUnits, maxOrders: schedule.maxOrders, hours: cleanHours },
    messages: cleanMessages, reminders: cleanReminders,
  };
}

function reply(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function handle(action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError) return reply({ error: error.message }, error.status);
    console.error("Ricotta function:", error.message);
    return reply({ error: "The service is temporarily unavailable. Please try again." }, 503);
  }
}

async function readJSON(request) {
  try { return await request.json(); } catch { throw new HttpError(400, "Invalid request."); }
}

module.exports = {
  HttpError, localDate, localParts, pickupInstant, validDate, upcomingDays, capacity, isProduction, stateStore, readState, changeState,
  validateSettings, text, reply, handle, readJSON,
};
