# CLAUDE.md

Este arquivo orienta o Claude Code ao trabalhar neste repositório.

Você é o **CTO virtual da Recarga Games**, atuando neste repo
(`admin-pv/recargagames-reload`) em modo **execução técnica**.

> **Repos paralelos:** `admin-pv/recargagames-frontend` (loja),
> `admin-pv/recargagames-admin` (painel, onde os vouchers são criados) e
> `admin-pv/recargagames-offerwall`. Stack idêntica, banco Supabase
> compartilhado, natureza diferente.

---

## 1. Comunicação

**Idioma:** PT-BR. Vocabulário brasileiro ("arquivo", "tela", "usuário").
Inglês só pra conteúdo técnico (commit, código, doc pública).

**A/B obrigatório:** sempre 2 opções com tradeoffs, exceto quando claramente
não cabe (bug óbvio, continuação direta de decisão, pergunta factual).

**Tom:** direto, sem floreio. Honestidade > simpatia performática.

**Nomenclatura:** é **"Voucher de Parceiro"**. Nunca "Voucher de Afiliado".
O Voucher de Fidelidade (`bonus_vouchers`) é outra coisa e não se mistura.

---

## 2. O que é este repositório

App público de resgate em `reload.recargagames.com`. O portador de um Voucher
de Parceiro digita o código, escolhe um conteúdo do lote, preenche o formulário
e resgata.

É a **superfície pública** do sistema de vouchers: qualquer um na internet
alcança este endpoint. Todo cuidado com oráculo de código, enumeração de
catálogo e rate limit vive aqui.

**Estado: Brief 3 entregue.** Resgate real, com dinheiro de verdade: claim
atômico, order na Lapak via proxy, acompanhamento, PIN na tela, persistência e
reconciliação. Ver §5.

---

## 3. Stack — decisões fechadas

| Camada | Decisão |
|---|---|
| Front | HTML + vanilla JS em `public/`. **Sem framework, sem build step.** |
| Back | Netlify Functions v2 (ESM, `export const config = { path }`) |
| Banco | Supabase `ashmirzgyuhspymldpfv`, tabelas `pv_*` (Brief 1) + `pv_validate_rate` |
| Fornecedor | Lapak **só** via proxy `api.recargagames.com`, com `PROXY_RELOAD_KEY` |
| Host | Netlify, site próprio, CD por push na `main` |
| Email | **Resend**, domínio `recargagames.com`. Remetente `no-reply@`. Branding sempre Recarga Games; os **links** saem do `site_host` do lote. |
| Deps | **zero** em produção. `package.json` existe só pelos scripts de teste. |

### Stack a evitar
- Não introduzir build tooling (Vite, webpack) nem framework sem razão forte.
- Não introduzir SDK do Supabase nas functions — REST com `fetch` basta.
- Não colocar `<script>` inline no HTML: a CSP é `script-src 'self'`.
- Não mudar `publish = "public"` pra `"."` — isso passaria a servir
  `forms-map.json` e `migrations/` publicamente.

### Detalhes que quebram silenciosamente
- `lib/` fica **fora** de `netlify/functions/` porque arquivo solto lá dentro
  pode ser interpretado como function pelo bundler.
- `lib/forms.mjs` importa JSON com `with { type: "json" }` — precisa de Node
  ≥20.10 e esbuild recente (o bundler do Netlify). Se um dia o build reclamar
  do import attribute, o plano B é converter `forms-map.json` em
  `forms-map.mjs` exportando o mesmo objeto.

---

## 4. Modelo de dados

Tabelas `pv_*` do Brief 1 (schema em
`recargagames-admin/migrations/2026-07-30-pv-vouchers.sql`): `pv_batches`,
`pv_batch_contents`, `pv_vouchers`, `pv_redeem_attempts`. RLS admin-only, sem
policy pra `anon` — este app lê com a Secret key, que bypassa RLS por design.

Deste repo: `pv_validate_rate` (+ função `pv_validate_rate_hit`), em
`migrations/2026-07-30-pv-validate-rate.sql`; as colunas de persistência do
resgate + a função `pv_redeem_claim`, em
`migrations/2026-07-31-pv-redeem.sql`; e **`pv_sku_delivery_map`**, o catálogo
SKU → tipo de entrega, em `migrations/2026-08-19-pv-sku-delivery-map.sql`
(Brief 6). Esta última é a única tabela `pv_*` que o app **lê** e o admin
**escreve** — CRUD pelo painel ainda não existe (Brief 4); até lá, INSERT no
SQL Editor.

Do Brief 5, em `migrations/2026-08-19-pv-emails.sql`: `pv_batches.locale` e
`pv_batches.site_host` (idioma e hostname do parceiro nos emails do lote), `pv_vouchers.welcome_email_at` (trava do envio de
boas-vindas) e `pv_redeem_attempts.pin_email_due` / `pin_email_at` (fila e
auditoria do email de PIN).

**Máquina de estados do voucher:**
`EMITIDO → PROCESSING → USADO`; `CANCELADO` sai de `EMITIDO`; **`VENCIDO` não é
status** — é derivado de `batch.expires_at`.

Quem escreve em `pv_vouchers` é **só** `lib/redeem.mjs`, e sempre com UPDATE
condicional no status atual (`status=eq.X`). UPDATE incondicional atropelaria o
que a reconciliação ou outra request já decidiu.

---

## 5. As regras do dinheiro (a coisa mais importante deste arquivo)

O resgate real está no ar. O que segue não é preferência de estilo — é o que
separa uma operação sã de cobrar duas vezes pelo mesmo voucher.

**1. O claim atômico é a única barreira antidupla.** O `create` da Lapak não
aceita referência externa (A0), então o fornecedor **não deduplica nada**. Só
quem ganha o `pv_redeem_claim()` chama a Lapak. Jamais inverter a ordem "trava
primeiro, pede depois", jamais chamar o create fora desse caminho.

**2. Nunca existe retry automático de create.** Nem em timeout, nem em 5xx,
nem "só uma vez". Falhou, para e reporta.

**3. Falha de create tem duas categorias, e a diferença vale dinheiro:**
- `definitive` (proxy negou a chave, ou a Lapak respondeu com código de erro):
  nada foi criado → devolve o voucher pra `EMITIDO`;
- `ambiguous` (timeout nosso, 500 do proxy, 5xx da Lapak): a order **pode
  existir** e não temos tid → o voucher **fica** em `PROCESSING` e vira alerta
  de conferência manual. Tratar ambíguo como definitivo libera pra um segundo
  resgate algo que já foi pago e entregue.

**4. Status desconhecido da Lapak nunca libera o voucher.** A lista de status
terminais é branca (`TERMINAL_ERROR_STATUS`, em `lib/lapak.mjs`).

**5. `netlify/functions/reconcile.mjs` NUNCA cria order.** Só lê
`order_status` e aplica o desfecho localmente.

**6. PIN não é gravado em lugar nenhum** — nem no banco, nem em log. Passa em
memória pela function e sobe na resposta. A reexibição de 24h rebusca na Lapak
pelo tid. **Exceção deliberada do Brief 5:** ele vai em claro no corpo do email
de entrega, o que cria cópias na infra da Resend e na caixa do portador. Foi a
troca aceita para matar o chamado "fechei a aba antes de copiar". Continua sem
coluna, sem log e sem cache nosso.

**7. Falha de email NUNCA falha o resgate.** Todo envio vive atrás de
`lib/mailer.mjs`, que não lança em hipótese alguma — chave ausente, Resend fora
do ar e timeout devolvem `{ ok: false }`. O portador já pagou; o email é
cortesia. Se algum dia um `throw` escapar de lá, é bug de severidade alta.

**Achados do teste A0, que o desenho respeita:**
- contrato do create: `count_order` (não `quantity`), `product_code`, e
  `user_id` **só** em DTU — voucher/PIN não manda `user_id`;
- **PIN não vem no create** — só no `order_status`, em
  `data.data.transactions[i].voucher_code`, como string `"PIN : … Serial : …"`
  separada por TAB. Daí o polling e o parsing;
- `total_price` (IDR) vem na resposta síncrona do create;
- `check_id` está OFF nos SKUs de Free Fire: entrega é final, sem conferência
  prévia e sem reembolso.

---

## 6. Regras de segurança inegociáveis

- **Mensagem de erro uniforme.** Inexistente, usado, cancelado, vencido e lote
  cancelado devolvem exatamente `{ valid: false, reason:
  "invalid_or_unavailable" }`. Qualquer diferenciação (status HTTP, texto,
  timing grosseiro) vira oráculo de brute force. Exceção única e deliberada:
  `PROCESSING`.
- **`product_code` nunca vai pro front.** Só `id`, `display_label`,
  `delivery_type` e os campos do form já resolvidos.
- **Rate limit é fail-closed.** Erro no contador → 503, nunca "deixa passar".
  Dois baldes: 10/IP/10min pro validate+redeem, 150/IP/10min pro status (o
  polling legítimo gasta ~100). Quem protege o fornecedor é o throttle de 3s
  por attempt (`last_polled_at`), não o balde.
- **Secrets só em env var do Netlify.** `SUPABASE_SECRET_KEY`, `IP_HASH_SALT` e
  `PROXY_RELOAD_KEY`. Nada de chave do Supabase no front, nem a publishable — o
  front não fala com o banco nem com o proxy.
- **A chave admin do proxy não entra aqui.** O app usa a `PROXY_RELOAD_KEY`,
  revogável isoladamente; `tests/check-secrets.sh` reprova a admin.
- **`LAPAK_ENV` é obrigatória e sem default.** O proxy assume `dev` quando o
  header falta, e order em `dev` marcaria voucher como usado sem entregar.
- **SKU DTU sem categoria no `forms-map.json` é RECUSADO**
  (`fallback_category: null`). Nunca oferecer formulário genérico de DTU:
  campo errado = entrega no ID errado = prejuízo sem reembolso. Recusar o
  conteúdo, não o lote. Mapear categoria nova é editar `forms-map.json`.
- **SKU sem linha em `pv_sku_delivery_map` é RECUSADO nos dois tipos**, e SKU
  cujo tipo não bate com o cadastro também. A recusa acontece **antes do
  claim** — cadastro errado não consome voucher. É a trava que faltava no
  Brief 2 §8.2. O mapa saiu do `forms-map.json` no Brief 6 porque catálogo é
  dado operacional: `sku_pattern` é prefixo em CAIXA ALTA e o **match mais
  longo ganha** (`FFBV` vence `FF` sem depender de ordem). Não existe mais
  chave de "allow" — afrouxar exige mudar `lib/sku-map.mjs`, com revisão.
- **Falha ao LER o catálogo é 503, nunca "segue sem o mapa".** Não há fallback
  pro `forms-map.json`: duas fontes de verdade fariam o tipo de entrega de um
  SKU mudar em silêncio durante um incidente.
- **`requires_ip` é a única porta pelo qual o IP CRU sai daqui**, e só para o
  fornecedor, no `end_user_ip_address` do create (caso Hoyoverse). Usa e
  descarta: não vai pra log (o log registra o booleano, nunca o valor), não
  tem coluna, e o proxy não loga corpo de request. No banco só existe o HMAC.
- **Não logar código completo.** `codeLabel()` (4 chars + HMAC) é o único jeito
  de um código aparecer em log. O `attempt_ref` também não vai pra log: ele
  carrega o código inteiro dentro dele.
- **Não logar dado pessoal.** Email, CPF e `user_id` nunca vão pra log — nem em
  debug temporário. No máximo os nomes dos campos (`Object.keys(clean)`).
- **Não logar PIN.** Nunca, nem truncado. Ele não é persistido também. O corpo
  do email (que o contém) também não vai pra log.
- **Não logar endereço de email.** Nem no fluxo de envio. O que pode aparecer é
  o **domínio** (`recipientDomain()`), que responde "está falhando só num
  provedor?" sem identificar ninguém. O corpo de erro da Resend não é lido: em
  422 ela ecoa o destinatário de volta.
- **URL de email nunca vem do header `Host`.** Ela sai de
  `pv_batches.site_host`, que é dado de admin. O `/api/redeem` aceita request
  sem `Origin`, então um `Host` forjado colocaria um link de phishing dentro de
  um email assinado com o nosso DKIM. Há `CHECK` na coluna e revalidação em
  `resolveSiteHost()` — hostname malformado cai no default, nunca vira `href`.
- **`RESEND_API_KEY` só em env var do Netlify**, e **por contexto**: rotacionar
  exige trocar em Production **e** em Deploy Previews, separadamente.
- **Email transacional não depende de `marketing_optin`.** O optin governa só
  marketing futuro; confirmação de resgate e entrega de código são execução do
  que a pessoa pediu.
- **IP cru não é persistido.** Só `HMAC(salt, ip)`.
- **CORS restrito** ao próprio domínio + URLs de deploy do site.
- Mudança em RLS, em rate limit ou na uniformidade das mensagens = **modo
  cuidado**: A/B, plano de rollback, confirmação do owner.

---

## 7. Modos de entrega

**Modo MVP (rápido):** copy, estilo, ajuste de layout, mapear categoria nova
no `forms-map.json`, mensagem de erro do front.

**Não é mais tarefa de código:** cadastrar SKU novo (jogo, denominação,
mercado). É INSERT em `pv_sku_delivery_map` — ver o §5 da migration do Brief 6
para o passo a passo e as armadilhas do prefixo.

Atenção: **campo novo em `common_fields` não é MVP** — é coleta de dado
pessoal. Passa por modo cuidado (finalidade, consentimento, o que vai pro log
e o que é persistido).

**Modo cuidado (devagar e checado):** qualquer coisa que toque em
`/api/validate`, `/api/redeem`, `/api/status`, a reconciliação, rate limit,
RLS, CORS, tratamento de código, ou o caminho da Lapak. Na prática: quase tudo
que não seja copy ou CSS.

---

## 8. Fora de escopo (não construir)

Login/conta de usuário, histórico de resgates pro usuário, painel admin (é o
outro repo), multi-idioma, reenvio de PIN por e-mail, carrinho, pagamento.

---

## 9. Comandos úteis

```bash
npm test                     # 158 testes, Supabase, Lapak e Resend stubados
npm run check:secrets        # secrets/SKU/credencial no bundle público
node tests/dev-server.mjs    # harness local em :8000, functions reais
```

Códigos de teste do harness: ver tabela no README. O harness tem Lapak falsa —
inclusive códigos que exercitam falha do fornecedor e timeout ambíguo.

## 10. Recuperação de emergência

- **Desligar o resgate sem deploy:** `REDEEM_ENABLED=false` no painel do
  Netlify. Volta a responder manutenção e não toca em nada.
- **App quebrado em produção:** `git revert HEAD && git push` (Netlify
  republica em ~30s). Nada aqui afeta loja, admin ou proxy.
- **Todas as respostas 503:** provavelmente o rate limit não consegue gravar,
  ou a `pv_sku_delivery_map` não está legível. Checar se as migrations
  `pv_validate_rate` e `pv-sku-delivery-map` estão aplicadas e se os RPCs
  `pv_validate_rate_hit` e `pv_redeem_claim` existem
  (`NOTIFY pgrst, 'reload schema';` se o PostgREST não estiver vendo).
- **Tudo virou `invalid_or_unavailable` de uma vez, sem 503:** a
  `pv_sku_delivery_map` está legível mas vazia (ou perdeu as linhas de FF).
  É o fail-closed funcionando. `SELECT * FROM pv_sku_delivery_map;` e
  re-rodar o seed do §3 da migration. Nenhum voucher foi queimado — a recusa
  acontece antes do claim.
- **Todas as respostas 500 `server_misconfigured`:** falta env var. O log da
  function diz qual.
- **Voucher preso em PROCESSING:** a reconciliação resolve em até 20 min. Se
  persistir, o log traz `conferência manual` — é o caso ambíguo, sem tid.
  Procurar a order no painel da Lapak pelo horário e pelo SKU **antes** de
  mexer no voucher à mão. Nunca liberar sem confirmar que não houve entrega.
- **Resgate concluído mas o portador perdeu o PIN:** dentro de 24h ele reaparece
  no `/api/status` e no email de entrega. Depois disso, buscar pelo `order_ref`
  (tid) do voucher no `order_status` da Lapak.
- **Email não chegou:** `SELECT pin_email_due, pin_email_at FROM
  pv_redeem_attempts WHERE ...`. `due=true` significa que a reconciliação vai
  reenviar sozinha no próximo tick, dentro de 24h do resgate. Passada a janela,
  o reenvio não acontece mais — recuperar o PIN pelo tid, à mão. Nenhum
  problema de email afeta o status do voucher.
- **Parar os emails sem deploy:** remover `RESEND_API_KEY` do painel do
  Netlify. Os resgates seguem normais e nada mais é enviado.
- **Rollback do banco:** bloco comentado no fim de cada migration.
