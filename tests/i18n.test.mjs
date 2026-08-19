/* =====================================================================
   Testes de i18n — Brief 7 (campanha Plusmo, es-MX).

   Cobre as duas metades do problema, que são independentes:

   1. SERVIDOR (lib/forms.mjs + lib/locale.mjs): quais campos existem em
      cada idioma e com que textos. É aqui que o CPF deixa de existir em
      es-MX — por ausência na resposta, não por filtro no cliente.

   2. CLIENTE (public/i18n.js): hostname → locale, e o override por query
      param que só vale fora de produção. Carregado com um `window` falso,
      porque o arquivo é um IIFE de browser.

   Rodar:  npm test
   ===================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fieldsForContent, validatePlayerData, purposeNote, commonFieldsHiddenIn } from "../lib/forms.mjs";
import { resolveLocale, emailLocale, isSupportedLocale, DEFAULT_LOCALE } from "../lib/locale.mjs";
import { buildSkuMap } from "../lib/sku-map.mjs";
import { SEED_ROWS } from "./sku-map-fixture.mjs";

const MAP = buildSkuMap(SEED_ROWS);
const PIN = { id: "c1", delivery_type: "PIN", product_code: "FFBV100-S22-br" };
const DTU = { id: "c2", delivery_type: "DTU", product_code: "FF100_10-S116-br" };

const names = (content, locale) =>
  fieldsForContent(content, MAP, locale).fields.map((f) => f.field);

/* ===================== 1. servidor: locale ========================= */

test("resolveLocale: fora da lista vira o default, sem estourar", () => {
  assert.equal(resolveLocale("es-MX"), "es-MX");
  assert.equal(resolveLocale("pt-BR"), "pt-BR");
  for (const lixo of ["es-ES", "en-US", "", null, undefined, 42, {}]) {
    assert.equal(resolveLocale(lixo), DEFAULT_LOCALE);
  }
});

test("isSupportedLocale distingue 'não disse nada' de 'disse pt-BR'", () => {
  // Sem isso, qualquer cadeia de precedência vira código morto —
  // resolveLocale devolve o default nos dois casos.
  assert.equal(isSupportedLocale("pt-BR"), true);
  assert.equal(isSupportedLocale("es-MX"), true);
  assert.equal(isSupportedLocale(undefined), false);
  assert.equal(isSupportedLocale(""), false);
  assert.equal(isSupportedLocale("en-US"), false);
});

test("emailLocale: cliente vence o lote, lote vence o default", () => {
  // Cliente explícito ganha — quem sabe o idioma é o site que a pessoa abriu.
  assert.equal(emailLocale("es-MX", "pt-BR"), "es-MX");
  assert.equal(emailLocale("pt-BR", "es-MX"), "pt-BR");
  // Cliente calado (reconciliação, por exemplo) cai no lote.
  assert.equal(emailLocale(undefined, "es-MX"), "es-MX");
  assert.equal(emailLocale("", "es-MX"), "es-MX");
  // Nada de nada cai no default.
  assert.equal(emailLocale(undefined, undefined), DEFAULT_LOCALE);
  assert.equal(emailLocale("en-US", "xx"), DEFAULT_LOCALE);
});

/* ============ 2. servidor: o CPF não existe em es-MX =============== */

test("es-MX NÃO recebe o campo cpf — ausência, não filtro", () => {
  // O critério de pronto do brief. O front não tem como esconder um campo
  // que nunca chegou.
  assert.deepEqual(names(PIN, "es-MX"), ["email", "marketing_optin"]);
  assert.deepEqual(names(DTU, "es-MX"), ["user_id", "email", "marketing_optin"]);

  for (const content of [PIN, DTU]) {
    const fields = fieldsForContent(content, MAP, "es-MX").fields;
    assert.equal(
      fields.some((f) => f.field === "cpf"),
      false,
      "cpf vazou pro es-MX"
    );
    assert.equal(
      fields.some((f) => f.type === "cpf"),
      false,
      "sobrou campo do tipo cpf"
    );
  }
});

test("pt-BR continua com o cpf — regressão do site brasileiro", () => {
  assert.deepEqual(names(PIN, "pt-BR"), ["email", "cpf", "marketing_optin"]);
  assert.deepEqual(names(DTU, "pt-BR"), ["user_id", "email", "cpf", "marketing_optin"]);
});

test("locale ausente ou inválido cai em pt-BR — comportamento de antes", () => {
  // Cliente velho, que ainda não manda locale, tem que ver o que via.
  for (const locale of [undefined, null, "", "en-US"]) {
    assert.deepEqual(names(PIN, locale), ["email", "cpf", "marketing_optin"]);
  }
});

test("commonFieldsHiddenIn diz quais campos de contato somem por idioma", () => {
  assert.deepEqual(commonFieldsHiddenIn("es-MX"), ["cpf"]);
  assert.deepEqual(commonFieldsHiddenIn("pt-BR"), []);
  assert.deepEqual(commonFieldsHiddenIn(undefined), []);
});

/* ============ 3. servidor: recusa de payload com cpf =============== */

test("payload es-MX com cpf é RECUSADO, não descartado em silêncio", () => {
  // Critério extra do brief. Silêncio esconderia um front desatualizado
  // ainda coletando documento de brasileiro de quem não é.
  const fields = fieldsForContent(PIN, MAP, "es-MX").fields;
  const { ok, errors, clean } = validatePlayerData(
    fields,
    { email: "jugador@correo.com", cpf: "11144477735" },
    "es-MX"
  );

  assert.equal(ok, false);
  assert.ok(errors.cpf, "não recusou o cpf");
  assert.equal("cpf" in clean, false, "o cpf entrou no payload limpo");
});

test("cpf vazio ou ausente em es-MX não é recusa — é ruído de formulário", () => {
  const fields = fieldsForContent(PIN, MAP, "es-MX").fields;
  for (const payload of [
    { email: "jugador@correo.com" },
    { email: "jugador@correo.com", cpf: "" },
    { email: "jugador@correo.com", cpf: "   " },
    { email: "jugador@correo.com", cpf: null },
  ]) {
    const { ok, clean } = validatePlayerData(fields, payload, "es-MX");
    assert.equal(ok, true, `recusou à toa: ${JSON.stringify(payload)}`);
    assert.equal("cpf" in clean, false);
  }
});

test("pt-BR com cpf continua aceitando normalmente", () => {
  const fields = fieldsForContent(PIN, MAP, "pt-BR").fields;
  const { ok, clean } = validatePlayerData(
    fields,
    { email: "jogador@email.com", cpf: "111.444.777-35" },
    "pt-BR"
  );
  assert.equal(ok, true);
  assert.equal(clean.cpf, "11144477735", "o cpf devia ter sido aceito e limpo");
});

test("chave desconhecida qualquer continua sendo descartada, não recusada", () => {
  // A recusa é ESTREITA de propósito: só campos de contato escondidos no
  // idioma. Ruído inofensivo não pode quebrar cliente antigo.
  const fields = fieldsForContent(PIN, MAP, "es-MX").fields;
  const { ok, clean } = validatePlayerData(
    fields,
    { email: "jugador@correo.com", campo_inventado: "x", utm_source: "y" },
    "es-MX"
  );
  assert.equal(ok, true);
  assert.deepEqual(Object.keys(clean).sort(), ["email", "marketing_optin"]);
});

/* ================ 4. servidor: textos traduzidos ================== */

test("os textos dos campos vêm do servidor já em es-MX", () => {
  const fields = fieldsForContent(DTU, MAP, "es-MX").fields;
  const byName = Object.fromEntries(fields.map((f) => [f.field, f]));

  assert.equal(byName.email.label, "Correo electrónico");
  assert.equal(byName.user_id.label, "ID de jugador");
  assert.match(byName.user_id.help, /Abre Free Fire/);
  assert.match(byName.marketing_optin.label, /Acepto recibir/);

  // E nada de português sobrando nos textos visíveis.
  const visiveis = fields.flatMap((f) => [f.label, f.help, f.placeholder]).filter(Boolean);
  for (const texto of visiveis) {
    assert.ok(!/jogador|somente|resgate/i.test(texto), `copy pt-BR vazou: ${texto}`);
  }
});

test("pt-BR mantém os textos originais, byte a byte", () => {
  const fields = fieldsForContent(DTU, MAP, "pt-BR").fields;
  const byName = Object.fromEntries(fields.map((f) => [f.field, f]));

  assert.equal(byName.email.label, "Email");
  assert.equal(byName.cpf.label, "CPF (opcional)");
  assert.equal(byName.user_id.label, "ID do jogador");
  assert.equal(byName.user_id.placeholder, "somente números");
  assert.equal(
    byName.user_id.help,
    "Abra o Free Fire, toque no avatar e copie o ID numérico do perfil."
  );
});

test("a linha de finalidade acompanha o idioma", () => {
  assert.match(purposeNote("pt-BR"), /prevenção a fraude/);
  assert.match(purposeNote("es-MX"), /prevenir fraudes/);
  assert.match(purposeNote(undefined), /prevenção a fraude/);
  // Sem citar lei específica em nenhum dos dois.
  for (const locale of ["pt-BR", "es-MX"]) {
    assert.ok(!/LGPD|GDPR/i.test(purposeNote(locale)));
  }
});

/* ============ 5. cliente: hostname → locale (public/i18n.js) ======= */

/** Roda o IIFE do i18n.js com um `window` falso e devolve o RG_I18N. */
function loadClientI18n({ hostname, search = "" }) {
  const source = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
  const fakeWindow = { location: { hostname, search } };
  const previous = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    new Function(source)();
    return fakeWindow.RG_I18N;
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("hostname da Plusmo serve es-MX; o resto serve pt-BR", () => {
  assert.equal(loadClientI18n({ hostname: "plusmo.recargagames.com" }).locale, "es-MX");
  assert.equal(loadClientI18n({ hostname: "reload.recargagames.com" }).locale, "pt-BR");
  assert.equal(loadClientI18n({ hostname: "qualquer.outro.com" }).locale, "pt-BR");
  // Case-insensitive: DNS não diferencia caixa.
  assert.equal(loadClientI18n({ hostname: "PLUSMO.recargagames.com" }).locale, "es-MX");
});

test("em pt-BR não há dicionário — o HTML não é reescrito", () => {
  const i18n = loadClientI18n({ hostname: "reload.recargagames.com" });
  assert.equal(i18n.has(), false);
  // t() devolve o fallback, que é o texto já escrito no index.html.
  assert.equal(i18n.t("code.submit", "Validar código"), "Validar código");
});

test("override por query param vale no preview e no local", () => {
  for (const hostname of ["deploy-preview-6--reload.netlify.app", "localhost", "127.0.0.1"]) {
    const i18n = loadClientI18n({ hostname, search: "?locale=es-MX" });
    assert.equal(i18n.locale, "es-MX", `override não funcionou em ${hostname}`);
  }
});

test("override por query param NÃO vale em produção", () => {
  // Em produção o idioma é propriedade do domínio. Um `?locale=` circulando
  // geraria chamado com print de uma tela que ninguém reproduz.
  const reload = loadClientI18n({ hostname: "reload.recargagames.com", search: "?locale=es-MX" });
  assert.equal(reload.locale, "pt-BR");

  const plusmo = loadClientI18n({ hostname: "plusmo.recargagames.com", search: "?locale=pt-BR" });
  assert.equal(plusmo.locale, "es-MX");
});

test("override com locale inexistente é ignorado", () => {
  const i18n = loadClientI18n({ hostname: "localhost", search: "?locale=en-US" });
  assert.equal(i18n.locale, "pt-BR");
});

test("o dicionário es-MX usa a tagline oficial e não a de outra marca", () => {
  const dict = loadClientI18n({ hostname: "plusmo.recargagames.com" })._dict["es-MX"];
  const todos = Object.values(dict).join(" ");
  // "TOP-UP. PLAY MORE." é assinatura da Top-Up, outra marca do grupo.
  assert.ok(!/TOP-?UP/i.test(todos), "assinatura de outra marca no dicionário es-MX");
  assert.ok(!/PLAY MORE/i.test(todos));
});

test("o dicionário es-MX não traduz campo de formulário", () => {
  // Se alguém acrescentar labels de campo aqui, volta a existir uma
  // segunda fonte de verdade — que foi exatamente o que este brief evitou.
  const dict = loadClientI18n({ hostname: "plusmo.recargagames.com" })._dict["es-MX"];
  for (const proibida of ["field.email.label", "fields", "cpf", "purpose_note"]) {
    assert.equal(proibida in dict, false, `dicionário do front invadiu o formulário: ${proibida}`);
  }
});
