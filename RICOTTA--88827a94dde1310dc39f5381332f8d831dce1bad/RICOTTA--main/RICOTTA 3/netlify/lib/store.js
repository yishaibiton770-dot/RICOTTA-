const defaultSite = {
  name: "RICOTTA",
  subtitle: "Boutique Donuts",
  tagline: '"A Bite from Dreams"',
  heroImage: "",
  menuTitle: "The Collection",
  menuIntro: "Handcrafted daily. Limited donuts per day.",
  premiumTitle: "Premium Collection",
  classicTitle: "Classic Collection",
  orderButton: "Order Now",
  menuButton: "View The Menu",
  pickupTitle: "Pickup",
  pickupType: "Store Pickup Only",
  pickupNote: "Pickup Only",
  hoursTitle: "Opening Hours",
  contactTitle: "Visit Us",
  addressStreet: "513 Albany Ave",
  addressLocality: "Brooklyn NY 11203",
  mapsUrl: "",
  phone: "347-365-5177",
  email: "",
  instagram: "https://www.instagram.com/ricottacoffee?igsh=OHMzczF1NWJwa253",
};

const defaults = {
  revision: 0,
  site: defaultSite,
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

async function readState(store) {
  const entry = await store.getWithMetadata("state", { type: "json" });
  if (!entry) return { data: { settings: structuredClone(defaults), bookings: {} }, etag: null };
  entry.data.settings.site = { ...defaultSite, ...entry.data.settings.site };
  return entry;
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

function externalLink(value) {
  const link = text(value, 500);
  if (!link) return "";
  let url;
  try { url = new URL(link); } catch { throw new HttpError(400, "Enter a valid HTTPS link."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new HttpError(400, "Enter a valid HTTPS link.");
  return link;
}

function imageLink(value) {
  const image = text(value, 500);
  return /^\/\.netlify\/functions\/product-image\?id=[a-f0-9]{64}$/.test(image) ? image : externalLink(image);
}

function validateSite(input) {
  const site = { ...defaultSite, ...input };
  const phone = text(site.phone, 32);
  const email = text(site.email, 120);
  if ((phone && (!/^\+?[0-9(). -]+$/.test(phone) || phone.replace(/\D/g, "").length < 7)) ||
      (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new HttpError(400, "Enter a valid public phone number or email address.");
  }
  return {
    name: text(site.name, 35, true),
    subtitle: text(site.subtitle, 75),
    tagline: text(site.tagline, 160),
    heroImage: imageLink(site.heroImage),
    menuTitle: text(site.menuTitle, 75, true),
    menuIntro: text(site.menuIntro, 300),
    premiumTitle: text(site.premiumTitle, 75, true),
    classicTitle: text(site.classicTitle, 75, true),
    orderButton: text(site.orderButton, 40, true),
    menuButton: text(site.menuButton, 40, true),
    pickupTitle: text(site.pickupTitle, 45, true),
    pickupType: text(site.pickupType, 75, true),
    pickupNote: text(site.pickupNote, 160),
    hoursTitle: text(site.hoursTitle, 45, true),
    contactTitle: text(site.contactTitle, 45, true),
    addressStreet: text(site.addressStreet, 110, true),
    addressLocality: text(site.addressLocality, 110),
    mapsUrl: externalLink(site.mapsUrl),
    phone,
    email,
    instagram: externalLink(site.instagram),
  };
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
    const image = imageLink(item.image);
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
    ...(input.site !== undefined && { site: validateSite(input.site) }),
    schedule: { paused: schedule.paused, start: schedule.start, end: schedule.end,
      maxUnits: schedule.maxUnits, maxOrders: schedule.maxOrders, hours: cleanHours },
    messages: cleanMessages, reminders: cleanReminders,
  };
}

function reply(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function handle(action, diagnose) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError) return reply({ error: error.message }, error.status);
    console.error("Ricotta function:", error.message);
    return reply({ error: "The service is temporarily unavailable. Please try again.", ...(diagnose && { diagnostic: diagnose(error) }) }, 503);
  }
}

async function readJSON(request) {
  try { return await request.json(); } catch { throw new HttpError(400, "Invalid request."); }
}

module.exports = {
  HttpError, localDate, localParts, pickupInstant, validDate, upcomingDays, capacity, isProduction, readState, changeState,
  validateSettings, text, reply, handle, readJSON,
};
