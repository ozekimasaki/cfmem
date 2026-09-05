import { MemoryProfile } from "./memory-profile";

export { MemoryProfile };

interface Env {
  MEMORY_PROFILES: DurableObjectNamespace<MemoryProfile>;
  PROFILE_KEY_SECRET: string;
  ADMIN_API_TOKEN: string;
  MEMORY_NAMESPACE: string;
}

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, init);
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function requireAdmin(request: Request, env: Env) {
  return request.headers.get("authorization") === `Bearer ${env.ADMIN_API_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/health") return json({ ok: true });
    if (url.pathname === "/v1/ready") return json({ ok: Boolean(env.PROFILE_KEY_SECRET && env.ADMIN_API_TOKEN) });
    if (!requireAdmin(request, env)) return json({ error: "unauthorized" }, { status: 401 });

    const match = url.pathname.match(/^\/v1\/namespaces\/([^/]+)\/characters\/([^/]+)\/subjects\/([^/]+)(\/.*)?$/);
    if (!match) return json({ error: "not found" }, { status: 404 });

    const namespace = decodeURIComponent(match[1]);
    const characterId = decodeURIComponent(match[2]);
    const subjectId = decodeURIComponent(match[3]);
    const suffix = match[4] || "";

    if (namespace !== env.MEMORY_NAMESPACE) return json({ error: "namespace mismatch" }, { status: 404 });
    if (namespace.length > 32 || characterId.length > 100 || subjectId.length > 100) {
      return json({ error: "identity exceeds compatibility limits" }, { status: 400 });
    }

    const profileKey = await hmac(env.PROFILE_KEY_SECRET, `${namespace}\n${characterId}\n${subjectId}`);
    const stub = env.MEMORY_PROFILES.getByName(profileKey);

    let targetPath = suffix;
    if (suffix === "/remember") targetPath = "/remember";
    else if (suffix === "/search" || suffix === "/recall") targetPath = "/search";
    else if (suffix === "/memories") targetPath = "/memories";
    else if (suffix.startsWith("/memories/")) targetPath = suffix;
    else return json({ error: "route not implemented in starter" }, { status: 501 });

    const forwarded = new Request(`https://profile.internal${targetPath}`, request);
    return stub.fetch(forwarded);
  },
};
