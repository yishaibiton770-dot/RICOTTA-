import { createHash } from "node:crypto";
import store from "../lib/store.js";
import { stateStore } from "../lib/blob-store.mjs";
import auth from "../lib/admin-auth.js";

const TYPES = {
  "image/jpeg": bytes => bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")),
  "image/png": bytes => bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  "image/webp": bytes => bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP",
};
const MAX_BYTES = 2 * 1024 * 1024;

export default async (request, context) => store.handle(async () => {
  if (request.method === "GET") {
    const id = new URL(request.url).searchParams.get("id");
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return store.reply({}, 404);
    const image = await stateStore(context).getWithMetadata("image/" + id, { type: "arrayBuffer" });
    if (!image || !Object.hasOwn(TYPES, image.metadata.type)) return store.reply({}, 404);
    return new Response(image.data, { headers: {
      "Content-Type": image.metadata.type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    } });
  }
  if (request.method !== "POST") return store.reply({}, 405);
  auth.requireAdmin(request);
  auth.requireSameOrigin(request);
  const type = request.headers.get("content-type") || "";
  if (!Object.hasOwn(TYPES, type)) return store.reply({ error: "אפשר להעלות JPG, PNG או WebP." }, 415);
  if (Number(request.headers.get("content-length")) > MAX_BYTES) {
    return store.reply({ error: "גודל התמונה המרבי הוא 2MB." }, 413);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return store.reply({ error: "גודל התמונה המרבי הוא 2MB." }, 413);
  if (!TYPES[type](Buffer.from(bytes))) return store.reply({ error: "פורמט התמונה אינו תקין." }, 415);
  const id = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  const write = await stateStore(context).set("image/" + id, bytes, { metadata: { type }, onlyIfNew: true });
  if (write.modified && !write.etag) throw new Error("The store could not verify the image upload.");
  return store.reply({ url: "/.netlify/functions/product-image?id=" + id }, 201);
});
