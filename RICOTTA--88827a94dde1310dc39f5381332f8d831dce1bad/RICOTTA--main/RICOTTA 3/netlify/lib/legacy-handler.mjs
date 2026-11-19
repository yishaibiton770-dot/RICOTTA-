import store from "./store.js";

export function productionHandler(handler) {
  return async (request, context) => {
    if (!store.isProduction(context)) return new Response(null, { status: 404 });
    const httpMethod = request.method;
    const body = httpMethod === "GET" || httpMethod === "HEAD" ? "" : await request.text();
    const result = await handler({ httpMethod, body, headers: Object.fromEntries(request.headers) });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  };
}
