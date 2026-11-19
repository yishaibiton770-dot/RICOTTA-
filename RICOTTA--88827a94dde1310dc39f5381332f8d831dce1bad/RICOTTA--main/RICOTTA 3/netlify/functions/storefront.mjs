import store from "../lib/store.js";
import { stateStore } from "../lib/blob-store.mjs";

export default async (request, context) => store.handle(async () => {
  if (request.method !== "GET") return store.reply({}, 405);
  const { data } = await store.readState(stateStore(context));
  const today = store.localDate(Date.now());
  const { products, schedule, messages, site } = data.settings;
  return store.reply({
    products: products.filter(product => product.active),
    site,
    days: store.upcomingDays(data),
    hours: schedule.hours,
    paused: schedule.paused,
    season: { start: schedule.start, end: schedule.end },
    messages: messages.filter(message => message.active && (!message.start || message.start <= today) &&
      (!message.end || message.end >= today)).map(message => message.text),
  });
}, context?.deploy?.context === "deploy-preview" ? error => {
  const name = error?.name;
  const message = error?.message || "";
  if (name === "MissingBlobsEnvironmentError") return "storage-context";
  if (name === "InvalidBlobsRegionError" || message.includes("configured with a region")) return "storage-region";
  if (name === "BlobsConsistencyError") return "storage-consistency";
  if (name === "BlobsInternalError") return "storage-response-" + (message.match(/\b(?:400|401|403|404|409|429|500|502|503)\b/)?.[0] || "unknown");
  if (/require|module/i.test(message)) return "storage-module";
  if (/fetch/i.test(message)) return "storage-transport";
  return "unexpected";
} : undefined);
