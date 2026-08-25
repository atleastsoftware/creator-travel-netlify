const crypto = require("crypto");

const USERS_STORE = "creator-users";
let blobsPromise;

async function blobs() {
  if (!blobsPromise) blobsPromise = import("@netlify/blobs");
  return blobsPromise;
}

async function usersStore() {
  const { getStore } = await blobs();
  return getStore({ name: USERS_STORE, consistency: "strong" });
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function tokenSign(payload) {
  const secret = process.env.SESSION_SECRET || "dev-secret-change-me";
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
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

async function getCreator() {
  const store = await usersStore();
  return store.get("creator-owner", { type: "json", consistency: "strong" });
}

async function saveCreator(creator) {
  const store = await usersStore();
  return store.setJSON("creator-owner", creator);
}

function pathFromEvent(event) {
  const raw = event.path || "";
  return raw.replace(/^\/auth\/?/, "/").replace(/^\/\.netlify\/functions\/auth\/?/, "/");
}

exports.handler = async (event) => {
  const path = pathFromEvent(event);
  const method = event.httpMethod || "GET";

  if (method === "GET" && path === "/status") {
    const creator = await getCreator();
    return response(200, { available: !creator });
  }

  if (method === "GET" && path === "/profile") {
    const creator = await getCreator();
    return response(200, {
      creator: creator ? {
        name: creator.name,
        handle: creator.handle || "",
        email: creator.email
      } : null
    });
  }

  if (method === "POST" && path === "/signup") {
    const existing = await getCreator();
    if (existing) {
      return response(409, { error: "The creator account has already been created for this storefront." });
    }

    let data = {};
    try { data = JSON.parse(event.body || "{}"); } catch {}

    const name = String(data.name || "").trim().slice(0, 100);
    const rawHandle = String(data.handle || "").trim().slice(0, 60);
    const handle = rawHandle ? (rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`) : "";
    const email = String(data.email || "").trim().toLowerCase().slice(0, 200);
    const password = String(data.password || "");

    if (name.length < 2) return response(400, { error: "Please enter your creator name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response(400, { error: "Please enter a valid email address." });
    if (password.length < 8) return response(400, { error: "Password must contain at least 8 characters." });

    const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (adminEmail && email === adminEmail) {
      return response(400, { error: "This email is reserved for the administrator account." });
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
    return response(201, {
      token: tokenSign({ ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }),
      user
    });
  }

  if (method === "POST" && path === "/login") {
    let data = {};
    try { data = JSON.parse(event.body || "{}"); } catch {}

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

    if (!user) return response(401, { error: "Invalid email or password" });

    return response(200, {
      token: tokenSign({ ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }),
      user
    });
  }

  return response(404, { error: "Not found" });
};
