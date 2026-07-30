/* =====================================================================
   Testes unitários de lib/forms.mjs — os VALORES do payload limpo.
   Existe separado de functions.test.mjs porque o stub das functions não
   expõe o player_data saneado (de propósito: ele carrega dado pessoal e
   não vai pra log nem pra resposta). Aqui a função é chamada direto.

   Rodar:  npm test
   ===================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fieldsForContent,
  validatePlayerData,
  isValidCpf,
  purposeNote,
} from "../lib/forms.mjs";

const DTU = { id: "c1", delivery_type: "DTU", product_code: "FF100_10-S116-br" };
const PIN = { id: "c2", delivery_type: "PIN", product_code: "FFBV100-S22-br" };
const DTU_NAO_MAPEADO = { id: "c3", delivery_type: "DTU", product_code: "MLBB50-S9-br" };

const fieldsOf = (content) => fieldsForContent(content).fields;

test("fail-closed: DTU sem categoria mapeada não resolve formulário", () => {
  const mapeado = fieldsForContent(DTU);
  assert.equal(mapeado.ok, true);
  assert.equal(mapeado.categoryKey, "free_fire");

  const naoMapeado = fieldsForContent(DTU_NAO_MAPEADO);
  assert.equal(naoMapeado.ok, false);
  assert.equal(naoMapeado.reason, "unmapped_sku");
  assert.deepEqual(naoMapeado.fields, []);
});

test("PIN resolve só os campos comuns", () => {
  const pin = fieldsForContent(PIN);
  assert.equal(pin.ok, true);
  assert.deepEqual(
    pin.fields.map((f) => f.field),
    ["email", "cpf", "marketing_optin"]
  );
});

test("optin desmarcado por padrão: valor limpo é false quando não vem nada", () => {
  const { ok, clean } = validatePlayerData(fieldsOf(PIN), { email: "a@b.com" });
  assert.equal(ok, true);
  assert.equal(clean.marketing_optin, false);
  assert.equal(typeof clean.marketing_optin, "boolean");
});

test("optin marcado vira true; string 'true'/'on' também", () => {
  for (const enviado of [true, "true", "on", 1, "1"]) {
    const { clean } = validatePlayerData(fieldsOf(PIN), {
      email: "a@b.com",
      marketing_optin: enviado,
    });
    assert.equal(clean.marketing_optin, true, `falhou pra ${JSON.stringify(enviado)}`);
  }
  for (const enviado of [false, "false", "off", 0, null, undefined, "qualquer"]) {
    const { clean } = validatePlayerData(fieldsOf(PIN), {
      email: "a@b.com",
      marketing_optin: enviado,
    });
    assert.equal(clean.marketing_optin, false, `falhou pra ${JSON.stringify(enviado)}`);
  }
});

test("email é normalizado pra minúsculas e sem espaço nas pontas", () => {
  const { ok, clean } = validatePlayerData(fieldsOf(PIN), { email: "  Jogador@Email.COM  " });
  assert.equal(ok, true);
  assert.equal(clean.email, "jogador@email.com");
});

test("email acima de 254 chars é recusado", () => {
  const longo = `${"a".repeat(250)}@email.com`;
  const { ok, errors } = validatePlayerData(fieldsOf(PIN), { email: longo });
  assert.equal(ok, false);
  assert.ok(errors.email);
});

test("CPF é guardado só em dígitos, sem máscara", () => {
  const { ok, clean } = validatePlayerData(fieldsOf(PIN), {
    email: "a@b.com",
    cpf: "111.444.777-35",
  });
  assert.equal(ok, true);
  assert.equal(clean.cpf, "11144477735");
});

test("CPF ausente não entra no payload limpo (é opcional)", () => {
  const { ok, clean } = validatePlayerData(fieldsOf(PIN), { email: "a@b.com" });
  assert.equal(ok, true);
  assert.equal("cpf" in clean, false);
});

test("dígito verificador de CPF", () => {
  for (const valido of ["11144477735", "52998224725", "15350946056"]) {
    assert.equal(isValidCpf(valido), true, `${valido} deveria ser válido`);
  }
  for (const invalido of [
    "11144477736", // último dígito errado
    "11144477725", // penúltimo dígito errado
    "00000000000",
    "99999999999",
    "1114447773", // 10 dígitos
    "111444777350", // 12 dígitos
    "abcdefghijk",
    "",
  ]) {
    assert.equal(isValidCpf(invalido), false, `${invalido} deveria ser inválido`);
  }
});

test("campos não declarados são descartados do payload limpo", () => {
  const { clean } = validatePlayerData(fieldsOf(DTU), {
    user_id: "13846816197",
    email: "a@b.com",
    product_code: "FF-HACK",
    admin: true,
    price: 0,
  });
  assert.deepEqual(Object.keys(clean).sort(), ["email", "marketing_optin", "user_id"]);
});

test("linha de finalidade existe e fala de resgate e fraude", () => {
  assert.match(purposeNote(), /validação do resgate/i);
  assert.match(purposeNote(), /fraude/i);
});
