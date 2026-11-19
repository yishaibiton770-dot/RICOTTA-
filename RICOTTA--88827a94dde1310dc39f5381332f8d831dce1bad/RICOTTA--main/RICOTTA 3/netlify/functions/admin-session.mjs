import auth from "../lib/admin-auth.js";
import store from "../lib/store.js";

export default async function handler(request) {
  return store.handle(async () => {
    if (request.method === "GET") {
      if (!auth.passwordSecret()) return store.reply({ error: "יש להגדיר סיסמת ניהול ב-Netlify." }, 503);
      auth.requireAdmin(request);
      return store.reply({ signedIn: true });
    }
    if (!["POST", "DELETE"].includes(request.method)) return store.reply({}, 405);
    auth.requireSameOrigin(request);
    if (request.method === "DELETE") {
      return store.reply({ signedIn: false }, 200, { "Set-Cookie": auth.sessionCookie(false) });
    }
    if (!auth.passwordSecret()) return store.reply({ error: "יש להגדיר סיסמת ניהול ב-Netlify." }, 503);
    const payload = await store.readJSON(request);
    if (!auth.verifyPassword(payload?.password)) return store.reply({ error: "הסיסמה שגויה." }, 401);
    return store.reply({ signedIn: true }, 200, { "Set-Cookie": auth.sessionCookie(true) });
  });
}

export const config = {
  path: "/api/admin/session",
  rateLimit: { windowLimit: 12, windowSize: 120, aggregateBy: ["ip"] },
};
