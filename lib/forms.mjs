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
// I18N (Brief 7): o formulário continua DIRIGIDO PELO SERVIDOR, agora com
// locale. Label, placeholder e help saem daqui já no idioma certo, e o
// front não tem dicionário de campo nenhum — uma fonte de verdade só.
//
// O CPF é o caso que justifica o desenho: no locale es-MX ele não é
// filtrado pelo front, ele NÃO É ENVIADO. `locales: ["pt-BR"]` no
// forms-map.json faz o campo não existir na resposta, então não há o que
// renderizar nem o que mandar de volta. Ausência por construção.
//
// O tipo de entrega do SKU NÃO mora mais aqui: saiu do forms-map.json e
// virou a tabela pv_sku_delivery_map (Brief 6), porque jogo novo não pode
// exigir deploy. Este arquivo recebe o mapa já carregado por parâmetro
// (`skuMap`) e continua puro — quem lê o banco é lib/sku-map.mjs.
//
// FUTURO (melhoria já registrada): trocar as `categories` pelo campo `forms`
// do Get Categories da Lapak, via proxy com cache. A forma da saída desta
// função já é a mesma, então a troca fica contida neste arquivo.

import formsMap from "../forms-map.json" with { type: "json" };
import { resolveDelivery } from "./sku-map.mjs";
import { resolveLocale, DEFAULT_LOCALE } from "./locale.mjs";

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
export function purposeNote(locale) {
  const lang = resolveLocale(locale);
  if (lang === "es-MX" && formsMap.purpose_note_es) return formsMap.purpose_note_es;
  return formsMap.purpose_note || null;
}

/**
 * Texto de um campo no idioma pedido.
 *
 * pt-BR usa a chave original (`label`), es-MX usa o sufixo (`label_es`).
 * Manter o pt-BR na chave sem sufixo é o que garante que o site
 * brasileiro não mude byte nenhum com este brief.
 *
 * Tradução faltando NÃO quebra o resgate — cai no pt-BR e GRITA no log.
 * É fail-open de propósito: copy errada é um problema de produto, resgate
 * bloqueado é um problema de dinheiro. Mas o grito existe pra ninguém
 * descobrir meses depois que um campo novo nasceu sem tradução.
 */
function localized(spec, key, locale) {
  if (locale === DEFAULT_LOCALE) return spec[key] ?? null;

  const suffix = locale === "es-MX" ? "_es" : null;
  const translated = suffix ? spec[`${key}${suffix}`] : null;
  if (translated) return translated;

  // `label` é o único obrigatório: sem ele o campo fica sem identificação.
  // placeholder e help ausentes são legítimos (nem todo campo tem).
  if (key === "label" && spec[key]) {
    console.error(
      `[forms] tradução ausente: campo=${spec.field} chave=${key} locale=${locale} — caiu no pt-BR`
    );
  }
  return spec[key] ?? null;
}

/** true se o campo existe neste idioma. Sem `locales`, existe em todos. */
function availableIn(spec, locale) {
  return !Array.isArray(spec.locales) || spec.locales.includes(locale);
}

function specForFront(spec, locale) {
  return {
    field: spec.field,
    label: localized(spec, "label", locale),
    type: spec.type,
    required: !!spec.required,
    placeholder: localized(spec, "placeholder", locale) || null,
    help: localized(spec, "help", locale) || null,
    min_length: spec.min_length ?? null,
    max_length: spec.max_length ?? null,
  };
}

function commonFields(locale) {
  return (formsMap.common_fields || [])
    .filter((spec) => availableIn(spec, locale))
    .map((spec) => specForFront(spec, locale));
}

/**
 * Nomes dos campos que são NOSSOS (contato/antifraude), não da entrega.
 * O redeemer usa isso pra separar o que vai pras colunas de dado pessoal
 * do attempt do que vai no player_data da entrega.
 */
export function commonFieldNames() {
  return (formsMap.common_fields || []).map((spec) => spec.field);
}

/**
 * Campos de contato que NÃO existem neste idioma (Brief 7).
 *
 * Alimenta a recusa de payload: se o cliente mandar `cpf` num resgate
 * es-MX, isso não é ruído — é um front desatualizado ainda coletando
 * documento de brasileiro de quem não é, ou alguém batendo na API à mão.
 * Descartar em silêncio esconderia os dois casos.
 */
export function commonFieldsHiddenIn(locale) {
  const lang = resolveLocale(locale);
  return (formsMap.common_fields || [])
    .filter((spec) => !availableIn(spec, lang))
    .map((spec) => spec.field);
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
 * Tipo de entrega VERDADEIRO do SKU, segundo a tabela pv_sku_delivery_map.
 * `null` = desconhecido, e desconhecido é RECUSA (ver checkSkuDelivery).
 *
 * `skuMap` vem de loadSkuMap() — uma leitura por request, feita pela
 * function. Recebido por parâmetro, e não lido aqui dentro, pra este
 * arquivo continuar puro e testável sem banco.
 */
export function expectedDeliveryType(productCode, skuMap) {
  return resolveDelivery(skuMap, productCode)?.deliveryType ?? null;
}

/**
 * TRAVA SKU × delivery_type — a lição do Brief 2 §8.2.
 *
 * `pv_batch_contents.delivery_type` é digitado no admin e não é validado
 * contra o SKU. Um lote de teste já teve FFBV100-S22-br (SKU de VOUCHER,
 * que entrega PIN) cadastrado como DTU, e nada reclamou. No Brief 2 isso
 * gerava só um formulário errado; aqui viraria uma order errada com
 * dinheiro real e sem reembolso.
 *
 * FAIL-CLOSED, sem chave de escape: SKU que não casa com nenhum pattern da
 * pv_sku_delivery_map é recusado nos DOIS tipos, PIN inclusive. Mapear um
 * SKU novo é um INSERT na tabela (Brief 6 — não precisa mais de deploy);
 * entregar errado não tem desfazer.
 *
 * Devolve também `requiresIp`, que sai da linha da tabela e diz se o create
 * da Lapak leva o IP do portador (caso Hoyoverse).
 */
export function checkSkuDelivery(content, skuMap) {
  const rule = resolveDelivery(skuMap, content.product_code);

  if (!rule) {
    return { ok: false, reason: "unmapped_delivery_sku", expected: null, requiresIp: false };
  }

  if (rule.deliveryType !== content.delivery_type) {
    return {
      ok: false,
      reason: "sku_delivery_mismatch",
      expected: rule.deliveryType,
      requiresIp: false,
    };
  }

  return { ok: true, expected: rule.deliveryType, requiresIp: rule.requiresIp };
}

/**
 * Campos que o usuário precisa preencher pra este conteúdo.
 *
 * PIN → só os common_fields: a entrega não depende de nenhum dado dele.
 * DTU → campos da categoria do SKU + common_fields.
 *
 * FAIL-CLOSED em duas frentes, nesta ordem:
 *   1. o SKU tem que bater com o delivery_type cadastrado (checkSkuDelivery);
 *   2. SKU de DTU sem categoria mapeada devolve
 *      `{ ok: false, reason: "unmapped_sku" }`.
 * Em ambos os casos quem chama RECUSA o conteúdo. Não existe formulário
 * genérico de DTU: pedir o campo errado entrega no lugar errado, e DTU
 * não tem reembolso (Check ID OFF).
 *
 * A checagem (1) vem primeiro de propósito: ela é a que impede uma order
 * do tipo errado, e vale pra PIN também — que não passa por (2).
 */
export function fieldsForContent(content, skuMap, locale) {
  const lang = resolveLocale(locale);
  const delivery = checkSkuDelivery(content, skuMap);
  if (!delivery.ok) {
    return {
      ok: false,
      reason: delivery.reason,
      expected: delivery.expected,
      fields: [],
      categoryKey: null,
      requiresIp: false,
    };
  }

  if (content.delivery_type === "PIN") {
    return {
      ok: true,
      fields: commonFields(lang),
      categoryKey: null,
      requiresIp: delivery.requiresIp,
    };
  }

  const categoryKey = resolveCategoryKey(content.product_code);
  const category = categoryKey ? formsMap.categories?.[categoryKey] : null;
  if (!category) {
    return { ok: false, reason: "unmapped_sku", fields: [], categoryKey: null, requiresIp: false };
  }

  return {
    ok: true,
    fields: [
      ...(category.fields || [])
        .filter((spec) => availableIn(spec, lang))
        .map((spec) => specForFront(spec, lang)),
      ...commonFields(lang),
    ],
    categoryKey,
    requiresIp: delivery.requiresIp,
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
 * BRIEF 7 — campo de contato ESCONDIDO no idioma é RECUSA, não descarte.
 * O padrão desta função sempre foi ignorar o que não foi declarado, e
 * isso continua valendo pra chave desconhecida qualquer. Mas um `cpf`
 * chegando num resgate es-MX é outra coisa: ou é um front desatualizado
 * ainda coletando documento de brasileiro de quem não é brasileiro, ou é
 * alguém batendo na API à mão. Descartar em silêncio esconde os dois.
 *
 * A recusa é DELIBERADAMENTE ESTREITA — só os campos de contato que o
 * mapa declara como ausentes naquele locale. Recusar qualquer chave extra
 * quebraria clientes antigos por ruído inofensivo.
 *
 * ATENÇÃO: `clean` contém dado pessoal (email, CPF). NUNCA logar valores
 * daqui; no máximo as chaves. Mesma regra do código do voucher.
 */
export function validatePlayerData(fields, playerData, locale) {
  const errors = {};
  const clean = {};
  const input =
    playerData && typeof playerData === "object" && !Array.isArray(playerData) ? playerData : {};

  for (const forbidden of commonFieldsHiddenIn(locale)) {
    const sent = input[forbidden];
    // Chave presente mas vazia é ruído de formulário, não coleta. Só
    // recusa o que tem valor de verdade.
    const hasValue = sent !== undefined && sent !== null && String(sent).trim() !== "";
    // Mensagem sem i18n de propósito: ela é DIAGNÓSTICO, não copy. O front
    // procura o input do campo pra pintar o erro, não encontra (o campo não
    // existe naquele idioma) e cai na mensagem genérica, que é traduzida.
    // Ou seja: isto aparece em log e em resposta de API, nunca na tela.
    if (hasValue) errors[forbidden] = "Campo não disponível.";
  }

  for (const spec of fields) {
    const result = validateOne(spec, input[spec.field]);
    if (result.error) errors[spec.field] = result.error;
    else if ("value" in result) clean[spec.field] = result.value;
  }

  return { ok: Object.keys(errors).length === 0, errors, clean };
}
