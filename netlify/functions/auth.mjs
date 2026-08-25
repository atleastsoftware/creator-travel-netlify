import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const USERS_STORE = "creator-users";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function tokenSign(payload) {
  const secret = process.env.SESSION_SECRET || "dev-secret-change-me";
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function tokenVerify(token) {
  try {
    const [data, sig] = String(token || "").split(".");
    if (!data || !sig) return null;
    const secret = process.env.SESSION_SECRET || "dev-secret-change-me";
    const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
    const A = Buffer.from(sig);
    const B = Buffer.from(expected);
    if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function bearerUser(request) {
  const raw = String(request.headers.get("authorization") || "");
  const token = raw.replace(/^Bearer\s+/i, "");
  return tokenVerify(token);
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""));
  const B = Buffer.from(String(b || ""));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: crypto.scryptSync(String(password), salt, 64).toString("hex")
  };
}

function verifyPassword(password, salt, hash) {
  try {
    const candidate = crypto.scryptSync(String(password), String(salt), 64);
    const expected = Buffer.from(String(hash), "hex");
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function creatorStore() {
  return getStore(USERS_STORE);
}

async function getCreator() {
  return creatorStore().get("creator-owner", { type: "json" });
}

async function saveCreator(creator) {
  await creatorStore().setJSON("creator-owner", creator);
}

function resolveAction(request) {
  const url = new URL(request.url);
  const queryAction = String(url.searchParams.get("action") || "").toLowerCase();
  if (queryAction) return queryAction;
  const parts = url.pathname.split("/").filter(Boolean);
  const last = String(parts.at(-1) || "").toLowerCase();
  return ["status", "profile", "signup", "login", "me"].includes(last) ? last : "";
}

export default async (request) => {
  try {
    const action = resolveAction(request);
    const method = request.method.toUpperCase();

    if (method === "GET" && action === "status") {
      const creator = await getCreator();
      return json({ available: !creator });
    }

    if (method === "GET" && action === "profile") {
      const creator = await getCreator();
      return json({
        creator: creator ? {
          name: creator.name,
          handle: creator.handle || "",
          email: creator.email
        } : null
      });
    }

    if (method === "GET" && action === "me") {
      const user = bearerUser(request);
      if (!user) return json({ error: "Unauthorized" }, 401);
      return json({
        user: {
          email: user.email,
          role: user.role,
          name: user.name || "Creator",
          handle: user.handle || ""
        }
      });
    }

    if (method === "POST" && action === "signup") {
      const existing = await getCreator();
      if (existing) {
        return json({ error: "The creator account has already been created for this storefront." }, 409);
      }

      let data = {};
      try { data = await request.json(); } catch {}

      const name = String(data.name || "").trim().slice(0, 100);
      const rawHandle = String(data.handle || "").trim().slice(0, 60);
      const handle = rawHandle ? (rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`) : "";
      const email = String(data.email || "").trim().toLowerCase().slice(0, 200);
      const password = String(data.password || "");

      if (name.length < 2) return json({ error: "Please enter your creator name." }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400);
      if (password.length < 8) return json({ error: "Password must contain at least 8 characters." }, 400);

      const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
      if (adminEmail && email === adminEmail) {
        return json({ error: "This email is reserved for the administrator account." }, 400);
      }

      const { salt, hash } = hashPassword(password);
      const creator = {
        id: "creator-owner",
        role: "creator",
        name,
        handle,
        email,
        password_salt: salt,
        password_hash: hash,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      await saveCreator(creator);

      const user = { email, role: "creator", name, handle };
      return json({
        token: tokenSign({ ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }),
        user
      }, 201);
    }

    if (method === "POST" && action === "login") {
      let data = {};
      try { data = await request.json(); } catch {}

      const email = String(data.email || "").trim().toLowerCase();
      const password = String(data.password || "");
      let user = null;

      if (
        email === String(process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase() &&
        safeEqual(password, process.env.ADMIN_PASSWORD || "replace-me")
      ) {
        user = { email, role: "admin", name: "Admin", handle: "" };
      } else {
        const creator = await getCreator();
        if (
          creator &&
          email === creator.email &&
          verifyPassword(password, creator.password_salt, creator.password_hash)
        ) {
          user = {
            email: creator.email,
            role: "creator",
            name: creator.name,
            handle: creator.handle || ""
          };
        } else if (
          !creator &&
          email === String(process.env.CREATOR_EMAIL || "creator@example.com").toLowerCase() &&
          safeEqual(password, process.env.CREATOR_PASSWORD || "replace-me")
        ) {
          user = {
            email,
            role: "creator",
            name: process.env.CREATOR_NAME || "Creator",
            handle: process.env.CREATOR_HANDLE || "@creator"
          };
        }
      }

      if (!user) return json({ error: "Invalid email or password" }, 401);

      return json({
        token: tokenSign({ ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }),
        user
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error("Creator auth function error", error);
    return json({
      error: "Account service unavailable. Please retry in a moment.",
      code: "CREATOR_AUTH_ERROR"
    }, 500);
  }
};
