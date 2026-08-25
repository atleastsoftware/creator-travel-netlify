import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORES = {
  properties: "creator-properties",
  bookings: "creator-bookings",
  clicks: "creator-airbnb-clicks"
};

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
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

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || `property-${Date.now()}`;
}

function store(name) {
  return getStore(name);
}

async function listJSON(name) {
  const s = store(name);
  const { blobs } = await s.list();
  const values = await Promise.all(blobs.map(item => s.get(item.key, { type: "json" })));
  return values.filter(Boolean);
}

async function getJSON(name, key) {
  return store(name).get(String(key), { type: "json" });
}

async function setJSON(name, key, value) {
  await store(name).setJSON(String(key), value);
}

async function ensureDemo() {
  const rows = await listJSON(STORES.properties);
  if (rows.length) return;
  const p = {
    id: crypto.randomUUID(),
    slug: "demo-villa",
    title: "Demo Pool Villa",
    location: "Krabi",
    country: "Thailand",
    description: "A sample stay to demonstrate the creator storefront. Replace this property from the dashboard.",
    image_url: "https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=1600&q=80",
    airbnb_url: "https://www.airbnb.com/",
    allow_direct: true,
    currency: "EUR",
    nightly_price_cents: 18000,
    cleaning_fee_cents: 3000,
    min_nights: 2,
    commission_percent: Number(process.env.DEFAULT_COMMISSION_PERCENT || 10),
    published: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await setJSON(STORES.properties, p.id, p);
}

export default async (request) => {
  try {
    const user = requireUser(request);
    if (!user) return json({ error: "Unauthorized" }, 401);

    const url = new URL(request.url);
    const action = String(url.searchParams.get("action") || "").toLowerCase();
    const method = request.method.toUpperCase();

    if (action === "properties" && method === "GET") {
      await ensureDemo();
      const rows = (await listJSON(STORES.properties))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return json(rows);
    }

    if (action === "properties" && method === "POST") {
      let data = {};
      try { data = await request.json(); } catch {}
      const title = String(data.title || "").trim();
      if (!title) return json({ error: "Title is required" }, 400);

      const all = await listJSON(STORES.properties);
      const baseSlug = slugify(data.slug || title);
      let slug = baseSlug;
      let n = 2;
      while (all.some(p => p.slug === slug)) slug = `${baseSlug}-${n++}`;

      const now = new Date().toISOString();
      const p = {
        id: crypto.randomUUID(),
        slug,
        title,
        location: String(data.location || "").trim(),
        country: String(data.country || "").trim(),
        description: String(data.description || "").trim(),
        image_url: String(data.image_url || "").trim(),
        airbnb_url: String(data.airbnb_url || "").trim(),
        allow_direct: Boolean(data.allow_direct),
        currency: String(data.currency || "EUR").toUpperCase().slice(0, 3),
        nightly_price_cents: Math.max(0, Math.round(Number(data.nightly_price || 0) * 100)),
        cleaning_fee_cents: Math.max(0, Math.round(Number(data.cleaning_fee || 0) * 100)),
        min_nights: Math.max(1, Math.round(Number(data.min_nights || 1))),
        commission_percent: Math.min(100, Math.max(0, Number(data.commission_percent ?? process.env.DEFAULT_COMMISSION_PERCENT ?? 10))),
        published: data.published !== false,
        created_at: now,
        updated_at: now
      };
      await setJSON(STORES.properties, p.id, p);
      return json(p, 201);
    }

    if (action === "properties" && method === "PUT") {
      const id = String(url.searchParams.get("id") || "");
      if (!id) return json({ error: "Property id is required" }, 400);
      const current = await getJSON(STORES.properties, id);
      if (!current) return json({ error: "Property not found" }, 404);
      let data = {};
      try { data = await request.json(); } catch {}

      const next = {
        ...current,
        title: String(data.title ?? current.title).trim(),
        location: String(data.location ?? current.location).trim(),
        country: String(data.country ?? current.country).trim(),
        description: String(data.description ?? current.description).trim(),
        image_url: String(data.image_url ?? current.image_url).trim(),
        airbnb_url: String(data.airbnb_url ?? current.airbnb_url).trim(),
        allow_direct: data.allow_direct === undefined ? current.allow_direct : Boolean(data.allow_direct),
        currency: String(data.currency ?? current.currency).toUpperCase().slice(0, 3),
        nightly_price_cents: data.nightly_price === undefined ? current.nightly_price_cents : Math.max(0, Math.round(Number(data.nightly_price) * 100)),
        cleaning_fee_cents: data.cleaning_fee === undefined ? current.cleaning_fee_cents : Math.max(0, Math.round(Number(data.cleaning_fee) * 100)),
        min_nights: data.min_nights === undefined ? current.min_nights : Math.max(1, Math.round(Number(data.min_nights))),
        commission_percent: data.commission_percent === undefined ? current.commission_percent : Math.min(100, Math.max(0, Number(data.commission_percent))),
        published: data.published === undefined ? current.published : Boolean(data.published),
        updated_at: new Date().toISOString()
      };
      await setJSON(STORES.properties, id, next);
      return json(next);
    }

    if (action === "stats" && method === "GET") {
      const [bookings, clicks] = await Promise.all([
        listJSON(STORES.bookings),
        listJSON(STORES.clicks)
      ]);
      const paid = bookings.filter(b => b.payment_status === "paid");
      return json({
        booking_count: paid.length,
        paid_revenue_cents: paid.reduce((sum, b) => sum + Number(b.total_cents || 0), 0),
        paid_commission_cents: paid.reduce((sum, b) => sum + Number(b.commission_cents || 0), 0),
        airbnb_clicks: clicks.length,
        recent: bookings.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 100)
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error("Dashboard function error", error);
    return json({ error: "Dashboard service unavailable. Please retry." }, 500);
  }
};
