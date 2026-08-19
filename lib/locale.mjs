// Locale — fonte única de verdade sobre quais idiomas existem (Brief 7).
//
// Vive num módulo próprio porque três consumidores muito diferentes
// precisam concordar sobre isso: o formulário (lib/forms.mjs), os emails
// (lib/email-templates.mjs) e as functions que recebem o locale do
// cliente. Duplicar a lista em cada um deles seria criar três verdades
// que divergem no dia em que um idioma novo entrar.
//
// O locale chega pelo CLIENTE (hostname → payload do /api/validate e do
// /api/redeem), então é entrada não confiável. `resolveLocale` é a
// fronteira: o que não estiver na lista vira o default, sem estourar.
// Isso é deliberadamente FAIL-OPEN, ao contrário das travas de dinheiro
// deste repo — um formulário em português é ruim, um resgate bloqueado
// por causa de um parâmetro de idioma é pior.

/** Idiomas com tradução completa. Ordem irrelevante. */
export const SUPPORTED_LOCALES = ["pt-BR", "es-MX"];

/** O que vale quando o cliente não diz nada, ou diz algo que não existe. */
export const DEFAULT_LOCALE = "pt-BR";

/** Normaliza o locale pedido. Desconhecido → default. Nunca lança. */
export function resolveLocale(locale) {
  const value = String(locale ?? "").trim();
  return SUPPORTED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

/**
 * true só quando o valor é um locale que existe de verdade.
 *
 * Serve pra distinguir "o cliente NÃO disse nada" de "o cliente disse
 * pt-BR" — distinção que `resolveLocale` apaga por construção, já que ela
 * devolve o default nos dois casos. Sem isso não dá pra ter cadeia de
 * precedência: qualquer fallback seria código morto.
 */
export function isSupportedLocale(value) {
  return SUPPORTED_LOCALES.includes(String(value ?? "").trim());
}

/**
 * Locale dos EMAILS, com a precedência do Brief 7:
 *
 *   1. o que o cliente mandou, se for válido — quem sabe em que idioma a
 *      pessoa está é o site que ela abriu;
 *   2. o `locale` do lote (Brief 5) — o fallback que a migration já
 *      previa, e o que vale quando o email sai da reconciliação, onde não
 *      existe cliente nenhum;
 *   3. o default.
 *
 * NÃO usar isto para resolver o FORMULÁRIO. Lá o que vale é só o locale
 * do cliente: os campos precisam bater com o que a pessoa viu na tela, e
 * um lote marcado es-MX acessado do site pt-BR esconderia um campo que o
 * navegador dela renderizou.
 */
export function emailLocale(clientLocale, batchLocale) {
  if (isSupportedLocale(clientLocale)) return String(clientLocale).trim();
  return resolveLocale(batchLocale);
}
