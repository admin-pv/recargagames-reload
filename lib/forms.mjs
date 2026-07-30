// Resolução do formulário dinâmico a partir do SKU, e validação do que o
// usuário digitou.
//
// O front NUNCA vê product_code: ele escolhe conteúdo por `id` (linha de
// pv_batch_contents) e recebe só os campos já resolvidos aqui. Assim o
// catálogo do parceiro não é enumerável a partir do app público.
//
// FUTURO (melhoria já registrada): trocar forms-map.json pelo campo `forms`
// do Get Categories da Lapak, via proxy com cache. A forma da saída desta
// função (lista de {field,label,type,required,...}) já é a mesma, então a
// troca fica contida neste arquivo.

import formsMap from "../forms-map.json" with { type: "json" };

const MAX_VALUE_LENGTH = 64;

export function formsMapVersion() {
  return formsMap.version;
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
 * PIN → [] sempre: o código sai pra nós e é exibido; não há nada a informar.
 * DTU → campos da categoria do SKU.
 *
 * Retorna também `matched:false` quando caiu no fallback, pra quem chama
 * logar o SKU e a gente mapear direito.
 */
export function fieldsForContent(content) {
  if (content.delivery_type === "PIN") {
    return { fields: [], categoryKey: null, matched: true };
  }

  const explicit = (formsMap.sku_category_patterns || []).some((rule) => {
    try {
      return new RegExp(rule.pattern, "i").test(String(content.product_code ?? ""));
    } catch {
      return false;
    }
  });

  const categoryKey = resolveCategoryKey(content.product_code);
  const category = categoryKey ? formsMap.categories?.[categoryKey] : null;

  return {
    fields: (category?.fields || []).map((f) => ({
      field: f.field,
      label: f.label,
      type: f.type,
      required: !!f.required,
      placeholder: f.placeholder || null,
      help: f.help || null,
      min_length: f.min_length ?? null,
      max_length: f.max_length ?? null,
    })),
    categoryKey,
    matched: explicit,
  };
}

/**
 * Revalida no servidor o que o front mandou. O client-side é conveniência;
 * esta é a validação que conta.
 *
 * Devolve `clean` com SÓ os campos declarados — nada que o usuário mande a
 * mais entra no player_data.
 */
export function validatePlayerData(fields, playerData) {
  const errors = {};
  const clean = {};
  const input = playerData && typeof playerData === "object" && !Array.isArray(playerData)
    ? playerData
    : {};

  for (const spec of fields) {
    const raw = input[spec.field];
    const value = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";

    if (!value) {
      if (spec.required) errors[spec.field] = "Campo obrigatório.";
      continue;
    }
    if (value.length > MAX_VALUE_LENGTH) {
      errors[spec.field] = "Valor muito longo.";
      continue;
    }
    if (spec.type === "number" && !/^[0-9]+$/.test(value)) {
      errors[spec.field] = "Use somente números.";
      continue;
    }
    if (spec.min_length && value.length < spec.min_length) {
      errors[spec.field] = `Mínimo de ${spec.min_length} caracteres.`;
      continue;
    }
    if (spec.max_length && value.length > spec.max_length) {
      errors[spec.field] = `Máximo de ${spec.max_length} caracteres.`;
      continue;
    }
    clean[spec.field] = value;
  }

  return { ok: Object.keys(errors).length === 0, errors, clean };
}
