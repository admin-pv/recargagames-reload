// Resolução do formulário dinâmico a partir do SKU, e validação do que o
// usuário digitou.
//
// O front NUNCA vê product_code: ele escolhe conteúdo por `id` (linha de
// pv_batch_contents) e recebe só os campos já resolvidos aqui. Assim o
// catálogo do parceiro não é enumerável a partir do app público.
//
// Dois tipos de campo, misturados na mesma lista pro front:
//   - campos de ENTREGA, por categoria de SKU (ex: user_id do Free Fire)
//   - common_fields: pedidos em todo resgate, DTU e PIN igual (email, CPF,
//     optin de marketing)
//
// FUTURO (melhoria já registrada): trocar as `categories` pelo campo `forms`
// do Get Categories da Lapak, via proxy com cache. A forma da saída desta
// função já é a mesma, então a troca fica contida neste arquivo.

import formsMap from "../forms-map.json" with { type: "json" };

// Teto de tamanho por tipo. Existe pra cortar payload abusivo antes de
// qualquer validação mais cara.
const MAX_LENGTH_BY_TYPE = {
  email: 254,
  cpf: 20, // aceita máscara: 000.000.000-00
  number: 32,
  checkbox: 8,
  text: 64,
};

// Pragmático de propósito: não existe regex "correta" de email (RFC 5322 é
// absurda). Isso barra o que é obviamente errado; a validação de verdade é
// o email chegar.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

export function formsMapVersion() {
  return formsMap.version;
}

/** Linha de finalidade do tratamento dos dados (exibida abaixo dos campos). */
export function purposeNote() {
  return formsMap.purpose_note || null;
}

function specForFront(spec) {
  return {
    field: spec.field,
    label: spec.label,
    type: spec.type,
    required: !!spec.required,
    placeholder: spec.placeholder || null,
    help: spec.help || null,
    min_length: spec.min_length ?? null,
    max_length: spec.max_length ?? null,
  };
}

function commonFields() {
  return (formsMap.common_fields || []).map(specForFront);
}

/** Categoria de um SKU, pelos patterns do mapa (primeiro match ganha). */
export function resolveCategoryKey(productCode) {
  const sku = String(productCode ?? "");
  for (const rule of formsMap.sku_category_patterns || []) {
    try {
      if (new RegExp(rule.pattern, "i").test(sku)) return rule.category;
    } catch {
      // pattern inválido no mapa: ignora essa regra em vez de derrubar o app
    }
  }
  return formsMap.fallback_category || null;
}

/**
 * Campos que o usuário precisa preencher pra este conteúdo.
 *
 * PIN → só os common_fields: a entrega não depende de nenhum dado dele.
 * DTU → campos da categoria do SKU + common_fields.
 *
 * FAIL-CLOSED: SKU de DTU sem categoria mapeada devolve
 * `{ ok: false, reason: "unmapped_sku" }` e quem chama RECUSA o conteúdo.
 * Não existe formulário genérico de DTU: pedir o campo errado entrega no
 * lugar errado, e DTU não tem reembolso (Check ID OFF).
 */
export function fieldsForContent(content) {
  if (content.delivery_type === "PIN") {
    return { ok: true, fields: commonFields(), categoryKey: null };
  }

  const categoryKey = resolveCategoryKey(content.product_code);
  const category = categoryKey ? formsMap.categories?.[categoryKey] : null;
  if (!category) {
    return { ok: false, reason: "unmapped_sku", fields: [], categoryKey: null };
  }

  return {
    ok: true,
    fields: [...(category.fields || []).map(specForFront), ...commonFields()],
    categoryKey,
  };
}

/** Dígito verificador de CPF. Recebe 11 dígitos, sem máscara. */
export function isValidCpf(digits) {
  if (!/^\d{11}$/.test(digits)) return false;
  // 11111111111 e afins passam no cálculo mas não são CPF.
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const checkDigit = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(digits[i]) * (length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10]);
}

function validateOne(spec, raw) {
  // Checkbox é o único que não é string: chega como boolean (ou "true"/"on"
  // se algum cliente mandar form-encoded).
  if (spec.type === "checkbox") {
    const value = raw === true || raw === "true" || raw === "on" || raw === 1 || raw === "1";
    return { value };
  }

  const value = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";

  if (!value) {
    // Campo opcional vazio simplesmente não entra no payload limpo.
    return spec.required ? { error: "Campo obrigatório." } : {};
  }

  const maxLength = MAX_LENGTH_BY_TYPE[spec.type] ?? MAX_LENGTH_BY_TYPE.text;
  if (value.length > maxLength) return { error: "Valor muito longo." };

  if (spec.type === "email") {
    if (!EMAIL_RE.test(value)) return { error: "Email inválido." };
    return { value: value.toLowerCase() };
  }

  if (spec.type === "cpf") {
    const digits = value.replace(/\D/g, "");
    if (digits.length !== 11) return { error: "CPF deve ter 11 dígitos." };
    if (!isValidCpf(digits)) return { error: "CPF inválido." };
    // Guarda só dígitos — máscara é assunto de apresentação.
    return { value: digits };
  }

  if (spec.type === "number" && !/^[0-9]+$/.test(value)) {
    return { error: "Use somente números." };
  }
  if (spec.min_length && value.length < spec.min_length) {
    return { error: `Mínimo de ${spec.min_length} caracteres.` };
  }
  if (spec.max_length && value.length > spec.max_length) {
    return { error: `Máximo de ${spec.max_length} caracteres.` };
  }

  return { value };
}

/**
 * Revalida no servidor o que o front mandou. O client-side é conveniência;
 * esta é a validação que conta.
 *
 * Devolve `clean` com SÓ os campos declarados — nada que o usuário mande a
 * mais entra no player_data.
 *
 * ATENÇÃO: `clean` contém dado pessoal (email, CPF). NUNCA logar valores
 * daqui; no máximo as chaves. Mesma regra do código do voucher.
 */
export function validatePlayerData(fields, playerData) {
  const errors = {};
  const clean = {};
  const input =
    playerData && typeof playerData === "object" && !Array.isArray(playerData) ? playerData : {};

  for (const spec of fields) {
    const result = validateOne(spec, input[spec.field]);
    if (result.error) errors[spec.field] = result.error;
    else if ("value" in result) clean[spec.field] = result.value;
  }

  return { ok: Object.keys(errors).length === 0, errors, clean };
}
