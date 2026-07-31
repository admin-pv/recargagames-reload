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
    // O detalhe do PostgREST pode ecoar a linha inteira — inclusive email e
    // CPF, num INSERT de attempt. Quem loga UpstreamError corta a mensagem;
    // ainda assim, nunca repasse `err.message` pro cliente.
    throw new UpstreamError(`Supabase ${res.status} on ${path}: ${detail.slice(0, 300)}`);
  }
  // Prefer: return=minimal responde 204 sem corpo — res.json() estouraria.
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

/** INSERT. Devolve a linha criada (Prefer: return=representation). */
export function sbInsert(cfg, table, row) {
  return sbFetch(cfg, `/rest/v1/${table}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
}

/**
 * UPDATE com filtro PostgREST no `query`.
 *
 * Devolve as linhas ATUALIZADAS (return=representation). Isso não é
 * conforto: é assim que se sabe se o UPDATE condicional pegou. Um
 * `status=eq.PROCESSING` que volta vazio significa que outro caminho já
 * mexeu no voucher — e quem chama precisa saber disso, não seguir em
 * frente achando que gravou.
 */
export function sbPatch(cfg, table, query, patch) {
  return sbFetch(cfg, `/rest/v1/${table}?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
}
