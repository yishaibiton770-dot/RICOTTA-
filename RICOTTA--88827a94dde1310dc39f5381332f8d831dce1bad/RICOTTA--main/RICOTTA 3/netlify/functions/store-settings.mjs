import store from "../lib/store.js";
import { stateStore } from "../lib/blob-store.mjs";
import auth from "../lib/admin-auth.js";

export default async (request, context) => store.handle(async () => {
  if (request.method !== "GET" && request.method !== "PUT") return store.reply({}, 405);
  auth.requireAdmin(request);
  if (request.method === "GET") {
    const { data } = await store.readState(stateStore(context));
    return store.reply(data.settings);
  }
  auth.requireSameOrigin(request);
  const input = await store.readJSON(request);
  let settings;
  try {
    settings = store.validateSettings(input);
  } catch (error) {
    if (error instanceof store.HttpError) throw new store.HttpError(400, "בדקו את השדות, הטווחים ומספר הפריטים בטופס.");
    throw error;
  }
  const saved = await store.changeState(stateStore(context), state => {
    if (input.revision !== state.settings.revision) {
      throw new store.HttpError(409, "ההגדרות השתנו במכשיר אחר. העתיקו שינויים שטרם נשמרו וטענו את העמוד מחדש.");
    }
    state.settings = { ...settings, revision: input.revision + 1 };
    return state.settings;
  });
  return store.reply(saved);
});
