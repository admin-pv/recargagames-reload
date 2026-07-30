// Acesso ao Supabase (instância ashmirzgyuhspymldpfv) via REST, com a
// SECRET key. Sem SDK: uma dependência a menos e nenhum build step.
//
// A Secret key bypassa RLS por design — é o único jeito de ler pv_vouchers,
// que é admin-only. Ela existe SÓ em env var do Netlify e nunca sai daqui
// pro front.

const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "IP_HASH_SALT"];

const TIMEOUT_MS = 8000;

export class MisconfiguredError extends Error {}
export class UpstreamError extends Error {}

/** Lê e valida a config de env. Lança MisconfiguredError com a lista do que falta. */
export function serverConfig() {
  const missing = REQUIRED_ENV.filter((k) => !String(process.env[k] || "").trim());
  if (missing.length) {
    throw new MisconfiguredError(`Missing env vars: ${missing.join(", ")}`);
  }
  return {
    url: process.env.SUPABASE_URL.trim().replace(/\/+$/, ""),
    key: process.env.SUPABASE_SECRET_KEY.trim(),
    salt: process.env.IP_HASH_SALT.trim(),
  };
}

async function sbFetch(cfg, path, init = {}) {
  let res;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(`Supabase unreachable: ${err?.name || "error"}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new UpstreamError(`Supabase ${res.status} on ${path}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export function sbSelect(cfg, path) {
  return sbFetch(cfg, `/rest/v1/${path}`, { method: "GET" });
}

export function sbRpc(cfg, fn, args) {
  return sbFetch(cfg, `/rest/v1/rpc/${fn}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
}
