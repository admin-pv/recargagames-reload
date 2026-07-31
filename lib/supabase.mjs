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

// ---------------------------------------------------------------------
// REDAÇÃO DAS MENSAGENS DE ERRO
//
// A mensagem de um UpstreamError acaba em console.error — e ela é montada
// a partir de duas fontes que carregam dado sensível:
//
//   1. o PATH, que filtra por VALOR: `pv_vouchers?code=eq.RLBK-XXXXXXXXXX`
//      e `pv_redeem_attempts?attempt_ref=eq.RLBK-XXXXXXXXXX-a1` colocam o
//      código completo do voucher na URL;
//   2. o CORPO de erro do PostgREST, que em violação de constraint traz
//      `Failing row contains (...)` — a linha inteira, ou seja email, CPF,
//      ip_hash e o player_data com o user_id.
//
// Nada disso pode ir pra log (regra do repo: código só via codeLabel(),
// dado pessoal nunca). Redigir AQUI, na origem, protege todos os catch de
// uma vez — inclusive os que forem escritos depois.
//
// O que sobra é o que diagnostica de verdade: status HTTP, tabela/rota,
// os NOMES dos filtros e o SQLSTATE do Postgres.
// ---------------------------------------------------------------------

/** Troca o valor de cada filtro por '·' e descarta a lista de colunas. */
export function safePath(path) {
  return String(path)
    .replace(/([?&])select=[^&]*/gi, "$1select=·")
    .replace(/=([a-z]+)\.[^&]*/gi, "=$1.·");
}

/**
 * Do corpo de erro do PostgREST, só o SQLSTATE.
 *
 * `message`, `details` e `hint` são justamente onde o Postgres ecoa
 * valores da linha que falhou — e é por isso que nenhum dos três entra.
 */
export function safeDetail(text) {
  try {
    const body = JSON.parse(text);
    return body && body.code ? ` sqlstate=${String(body.code).slice(0, 12)}` : "";
  } catch {
    return "";
  }
}

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
    // Path e corpo passam pela redação antes de virar mensagem: os dois
    // carregam código de voucher e dado pessoal (ver bloco acima).
    // Mesmo redigida, esta mensagem NUNCA vai pro cliente — só pra log.
    throw new UpstreamError(`Supabase ${res.status} on ${safePath(path)}${safeDetail(detail)}`);
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
