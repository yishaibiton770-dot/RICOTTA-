const $ = id => document.getElementById(id);
const FUNCTIONS = "/.netlify/functions/";
const SESSION = "/api/admin/session";
const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const quote = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const dateLabel = value => new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeZone: "UTC" })
  .format(new Date(value + "T12:00:00Z"));

let settings;
let dirty = false;
let saving = false;
let uploads = 0;
let ordersRequest = 0;

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallback = response.status === 429 ? "יותר מדי ניסיונות. נסו שוב בעוד שתי דקות." : "הבקשה נכשלה. נסו שוב.";
    const error = new Error(data.error || fallback);
    error.status = response.status;
    throw error;
  }
  return data;
}

function json(method, data) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

function feedback(id, message, error = false) {
  const output = $(id);
  output.textContent = message;
  output.classList.toggle("error", error);
}

function showLogin(message = "") {
  $("admin-panel").hidden = true;
  $("login-screen").hidden = false;
  feedback("login-status", message, Boolean(message));
}

async function enter() {
  settings = await request(FUNCTIONS + "store-settings");
  $("login-form").reset();
  $("login-screen").hidden = true;
  $("admin-panel").hidden = false;
  renderSettings();
  setDirty(false);
  feedback("feedback", "");
  if (!$("orders").hidden) loadOrders();
}

async function restoreSession() {
  try {
    await request(SESSION);
    await enter();
  } catch (error) {
    if (error.status !== 401) showLogin(error.message);
  }
}

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  feedback("login-status", "מתחברים…");
  try {
    await request(SESSION, json("POST", { password: $("admin-password").value }));
    await enter();
    document.querySelector("[data-panel][aria-pressed='true']").focus();
  } catch (error) {
    feedback("login-status", error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  if (saving || uploads || (dirty && !confirm("לצאת בלי לשמור את השינויים?"))) return;
  try {
    await request(SESSION, { method: "DELETE" });
    ordersRequest++;
    $("orders-list").replaceChildren();
    $("order-days").replaceChildren();
    settings = undefined;
    setDirty(false);
    showLogin();
    $("admin-password").focus();
  } catch (error) {
    feedback("feedback", error.message, true);
  }
});

function setDirty(value) {
  dirty = value;
  $("save").disabled = !dirty || saving || uploads > 0;
}

function changeMade() {
  setDirty(true);
  feedback("feedback", "יש שינויים שטרם נשמרו.");
}

window.addEventListener("beforeunload", event => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

document.querySelector(".section-nav").addEventListener("click", event => {
  const target = event.target.closest("[data-panel]");
  if (!target) return;
  for (const button of document.querySelectorAll("[data-panel]")) {
    const selected = button === target;
    button.setAttribute("aria-pressed", selected);
    $(button.dataset.panel).hidden = !selected;
  }
  if (target.dataset.panel === "orders") loadOrders();
});

$("save").addEventListener("click", async () => {
  if (!settings || saving || uploads) return;
  const invalid = document.querySelector(".panel:not([hidden]) input:invalid, .panel:not([hidden]) textarea:invalid");
  if (invalid) {
    invalid.reportValidity();
    return;
  }
  saving = true;
  setDirty(dirty);
  for (const panel of document.querySelectorAll(".panel")) panel.inert = true;
  feedback("feedback", "שומרים…");
  try {
    settings = await request(FUNCTIONS + "store-settings", json("PUT", settings));
    setDirty(false);
    renderSettings();
    feedback("feedback", "השינויים נשמרו.");
    if (!$("orders").hidden) loadOrders();
  } catch (error) {
    feedback("feedback", error.message, true);
  } finally {
    for (const panel of document.querySelectorAll(".panel")) panel.inert = false;
    saving = false;
    setDirty(dirty);
  }
});

const checked = value => value ? " checked" : "";
const selected = value => value ? " selected" : "";
const input = (field, value, label, type = "text", attributes = "") =>
  '<label>' + label + '<input data-field="' + field + '" type="' + type + '" value="' +
    quote(value) + '" ' + attributes + '></label>';
const checkbox = (field, value, label) =>
  '<label class="check"><input data-field="' + field + '" type="checkbox"' + checked(value) + '>' + label + '</label>';
const textarea = (field, value, label, required = "") =>
  '<label class="span">' + label + '<textarea dir="auto" data-field="' + field + '" maxlength="350" ' +
    required + '>' + quote(value) + '</textarea></label>';
const remove = '<button class="remove" type="button" data-remove>הסרה</button>';

function updateStoreStatus() {
  const status = $("store-status");
  status.textContent = settings.schedule.paused ? "ההזמנות מושהות" : "קבלת הזמנות מופעלת";
  status.classList.toggle("open", !settings.schedule.paused);
}

function setProductCount() {
  $("products-count").textContent = settings.products.filter(product => product.active).length +
    " פריטים מוצגים בחנות";
}

function renderProducts() {
  setProductCount();
  $("product-list").innerHTML = settings.products.map((product, index) => {
    const image = product.image
      ? '<img class="product-image" src="' + quote(product.image) + '" alt="" loading="lazy">'
      : '<div class="product-image">אין תמונה</div>';
    const imageLink = product.image.startsWith("https://") ? product.image : "";
    const options = '<option value="premium"' + selected(product.category === "premium") +
      '>פרימיום</option><option value="classic"' + selected(product.category === "classic") + '>קלאסי</option>';
    return '<article class="card product" data-index="' + index + '">' +
      '<div class="product-media">' + image + '<label>העלאת תמונה<input type="file" data-upload accept="image/jpeg,image/png,image/webp"></label>' +
      (product.image ? '<button class="quiet" type="button" data-clear-image>הסרת תמונה</button>' : '') + '</div>' +
      '<div><div class="card-title"><h3 dir="auto" data-product-title>' + quote(product.name || "פריט חדש") + '</h3>' + remove + '</div>' +
      '<div class="fields">' + input("name", product.name, "שם הפריט", "text", 'dir="auto" maxlength="100" required') +
      input("price", Number.isFinite(product.price) ? (product.price / 100).toFixed(2) : "", "מחיר בדולרים", "number", 'min="0.01" max="1000" step="0.01" required') +
      textarea("description", product.description, "תיאור") +
      '<label>קטגוריה<select data-field="category">' + options + '</select></label>' +
      input("image", imageLink, "קישור לתמונה (אופציונלי)", "url", 'maxlength="500" placeholder="https://…"') +
      checkbox("active", product.active, "מוצג בחנות") + '</div></div></article>';
  }).join("") || '<p class="empty">אין פריטים בתפריט.</p>';
  $("add-product").disabled = settings.products.length >= 80;
}

function renderSchedule() {
  const schedule = settings.schedule;
  $("schedule-settings").innerHTML = '<legend>קבלת הזמנות</legend><div class="span">' +
    checkbox("paused", schedule.paused, "השהיית הזמנות חדשות") + '</div>' +
    input("maxUnits", schedule.maxUnits, "מקסימום פריטים ליום", "number", 'min="1" max="5000" required') +
    input("maxOrders", schedule.maxOrders, "מקסימום הזמנות ליום", "number", 'min="1" max="5000" placeholder="ללא מגבלה"') +
    input("start", schedule.start, "יום איסוף ראשון (אופציונלי)", "date") +
    input("end", schedule.end, "יום איסוף אחרון (אופציונלי)", "date");
  $("hours").innerHTML = '<legend>שעות איסוף שבועיות</legend>' + schedule.hours.map((day, index) =>
    '<div class="hours-row" data-index="' + index + '">' + checkbox("open", day.open, WEEKDAYS[index]) +
    input("from", day.from, "פתיחה", "time", day.open ? "required" : "disabled") +
    input("to", day.to, "סגירה", "time", day.open ? "required" : "disabled") + '</div>'
  ).join("");
}

function renderMessages() {
  $("message-list").innerHTML = settings.messages.map((message, index) =>
    '<article class="card" data-index="' + index + '"><div class="card-title">' +
    checkbox("active", message.active, "פרסום באתר") + remove + '</div><div class="fields">' +
    textarea("text", message.text, "נוסח ההודעה", "required") +
    input("start", message.start, "תאריך התחלה (אופציונלי)", "date") +
    input("end", message.end, "תאריך סיום (אופציונלי)", "date") + '</div></article>'
  ).join("") || '<p class="empty">אין הודעות.</p>';
  $("add-message").disabled = settings.messages.length >= 30;
}

function renderReminders() {
  $("reminder-list").innerHTML = settings.reminders.map((reminder, index) =>
    '<article class="card" data-index="' + index + '"><div class="card-title">' +
    checkbox("done", reminder.done, "בוצע") + remove + '</div><div class="fields">' +
    textarea("text", reminder.text, "נוסח התזכורת", "required") +
    input("date", reminder.date, "תאריך יעד", "date", "required") + '</div></article>'
  ).join("") || '<p class="empty">אין תזכורות לצוות.</p>';
  $("add-reminder").disabled = settings.reminders.length >= 50;
}

function renderSettings() {
  updateStoreStatus();
  renderProducts();
  renderSchedule();
  renderMessages();
  renderReminders();
}

function bindList(container, list, addButton, make, render) {
  const node = $(container);
  $(addButton).addEventListener("click", () => {
    settings[list].push(make());
    render();
    node.lastElementChild?.querySelector("input:not([type=checkbox]):not([type=file]), textarea")?.focus();
    changeMade();
  });
  node.addEventListener("click", event => {
    const button = event.target.closest("[data-remove], [data-clear-image]");
    if (!button) return;
    const index = Number(button.closest("[data-index]").dataset.index);
    if (button.hasAttribute("data-remove")) settings[list].splice(index, 1);
    else settings[list][index].image = "";
    render();
    $(addButton).focus();
    changeMade();
  });
  node.addEventListener("input", event => {
    const field = event.target.dataset.field;
    if (!field) return;
    const index = Number(event.target.closest("[data-index]").dataset.index);
    const item = settings[list][index];
    let value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    if (field === "price") value = value === "" ? null : Math.round(Number(value) * 100);
    item[field] = value;
    if (list === "products") {
      setProductCount();
      if (field === "name") event.target.closest("article").querySelector("[data-product-title]").textContent = value || "פריט חדש";
    }
    changeMade();
  });
}

bindList("product-list", "products", "add-product", () => {
  let id;
  do { id = crypto.getRandomValues(new Uint32Array(1))[0]; }
  while (id < 7 || settings.products.some(product => product.id === id));
  return { id, name: "", description: "", price: null, image: "", category: "classic", active: true };
}, renderProducts);
bindList("message-list", "messages", "add-message", () => ({ text: "", start: "", end: "", active: true }), renderMessages);
bindList("reminder-list", "reminders", "add-reminder", () => ({ text: "", date: "", done: false }), renderReminders);

$("product-list").addEventListener("change", async event => {
  const field = event.target;
  if (!field.hasAttribute("data-upload") || !field.files.length) return;
  const product = settings.products[Number(field.closest("[data-index]").dataset.index)];
  const file = field.files[0];
  uploads++;
  setDirty(dirty);
  feedback("feedback", "מעלים תמונה…");
  try {
    const result = await request(FUNCTIONS + "product-image", { method: "POST", headers: { "Content-Type": file.type }, body: file });
    if (settings.products.includes(product)) {
      product.image = result.url;
      renderProducts();
      changeMade();
    }
  } catch (error) {
    field.value = "";
    feedback("feedback", error.message, true);
  } finally {
    uploads--;
    setDirty(dirty);
  }
});

$("schedule-settings").addEventListener("input", event => {
  const { dataset, value, type, checked } = event.target;
  settings.schedule[dataset.field] = type === "checkbox" ? checked
    : type === "number" ? (value === "" ? null : Number(value)) : value;
  updateStoreStatus();
  changeMade();
});

$("hours").addEventListener("input", event => {
  const { dataset, value, type, checked } = event.target;
  const row = event.target.closest("[data-index]");
  settings.schedule.hours[Number(row.dataset.index)][dataset.field] = type === "checkbox" ? checked : value;
  if (type === "checkbox") {
    for (const field of row.querySelectorAll("input[type=time]")) field.disabled = !checked;
  }
  changeMade();
});

$("orders-range").addEventListener("submit", event => {
  event.preventDefault();
  loadOrders();
});

async function loadOrders() {
  const currentRequest = ++ordersRequest;
  const params = new URLSearchParams();
  for (const [name, value] of new FormData($("orders-range"))) if (value) params.set(name, value);
  feedback("orders-status", "טוענים הזמנות…");
  try {
    const data = await request(FUNCTIONS + "admin-dashboard?" + params);
    if (currentRequest !== ordersRequest) return;
    $("order-days").innerHTML = data.days.map(day => '<div class="card"><strong>' + dateLabel(day.date) +
      '</strong><span>' + day.units + ' / ' + day.maxUnits + ' פריטים</span><span>' + day.orders +
      (day.maxOrders === null ? '' : ' / ' + day.maxOrders) + ' הזמנות</span></div>').join("");
    $("orders-list").innerHTML = data.orders.map(order => '<article class="card order-item"><div><strong>' +
      (order.donuts ? order.donuts + ' פריטים' : 'הוחזרה או בוטלה') + '</strong><p>איסוף ' +
      dateLabel(order.pickupDate) + ' בשעה <bdi>' + quote(order.pickupTime) + '</bdi></p><small dir="ltr">' +
      quote(order.id) + '</small></div><strong dir="ltr">$' + order.total.toFixed(2) + '</strong></article>').join("");
    feedback("orders-status", !data.configured ? "Square אינו מוגדר בסביבה זו." :
      data.orders.length ? "" : "אין הזמנות ששולמו בטווח שבחרתם.");
  } catch (error) {
    if (currentRequest !== ordersRequest) return;
    $("order-days").replaceChildren();
    $("orders-list").replaceChildren();
    feedback("orders-status", error.message, true);
  }
}

restoreSession();
