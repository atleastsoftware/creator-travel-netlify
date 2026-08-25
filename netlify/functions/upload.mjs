import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const IMAGE_STORE = "creator-images";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function tokenVerify(token) {
  try {
    const [data, sig] = String(token || "").split(".");
    if (!data || !sig) return null;
    const secret = process.env.SESSION_SECRET || "dev-secret-change-me";
    const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireUser(request) {
  const raw = String(request.headers.get("authorization") || "");
  return tokenVerify(raw.replace(/^Bearer\s+/i, ""));
}

function imageStore() {
  return getStore(IMAGE_STORE);
}

function contentTypeFromKey(key) {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function requestedKey(request) {
  const url = new URL(request.url);
  const queryKey = String(url.searchParams.get("id") || "");
  if (queryKey) return queryKey;
  const parts = url.pathname.split("/").filter(Boolean);
  const last = String(parts.at(-1) || "");
  return last === "upload" ? "" : last;
}

export default async (request) => {
  try {
    const method = request.method.toUpperCase();

    if (method === "GET") {
      const key = requestedKey(request);
      if (!/^[a-zA-Z0-9._-]+$/.test(key)) return new Response("Not found", { status: 404 });
      const blob = await imageStore().get(key, { type: "blob" });
      if (!blob) return new Response("Not found", { status: 404 });
      return new Response(blob, {
        status: 200,
        headers: {
          "content-type": contentTypeFromKey(key),
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff"
        }
      });
    }

    if (method === "POST") {
      const user = requireUser(request);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const form = await request.formData();
      const file = form.get("image");
      if (!file || typeof file.arrayBuffer !== "function") {
        return json({ error: "Please choose an image." }, 400);
      }

      const type = String(file.type || "").toLowerCase();
      const ext = ALLOWED_TYPES.get(type);
      if (!ext) return json({ error: "Only JPEG, PNG and WebP images are supported." }, 415);
      if (Number(file.size || 0) > MAX_BYTES) {
        return json({ error: "Image is too large. Maximum upload size is 5 MB per image." }, 413);
      }

      const key = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const bytes = await file.arrayBuffer();
      await imageStore().set(key, bytes);

      return json({
        key,
        url: `/media/${key}`,
        content_type: type,
        size: Number(file.size || bytes.byteLength)
      }, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("Image upload function error", error);
    return json({ error: "Image upload failed. Please retry." }, 500);
  }
};
