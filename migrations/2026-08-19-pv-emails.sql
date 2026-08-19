-- =====================================================================
-- Migration: Emails transacionais (Brief 5)
-- Data: 2026-08-19
-- Objetivo: dar ao sistema (a) o idioma de cada lote, (b) o registro de
--           que os dois emails foram enviados, e (c) a fila mínima para
--           o reenvio do email de PIN pela reconciliação.
--
-- Como rodar: colar este arquivo inteiro no Supabase SQL Editor
--             (instância ashmirzgyuhspymldpfv) e executar.
--             Idempotente — pode ser re-executado sem erro.
--
-- ADITIVA. Só adiciona colunas e um índice. Nenhuma coluna existente
-- muda de tipo, nada é apagado. Se o PR do Brief 5 for revertido, estas
-- colunas ficam órfãs e sem efeito — nada no fluxo de resgate as lê.
--
-- LGPD: nenhuma coluna nova guarda dado pessoal. O endereço de email já
-- existia em pv_redeem_attempts.email (Brief 3); aqui só se registra
-- QUANDO um envio aconteceu, nunca para quem nem o conteúdo. O PIN
-- continua sem coluna em lugar nenhum.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) pv_batches.locale — o idioma do lote.
--
--    O lote É a campanha: o lote da Plusmo nasce 'es-MX', os brasileiros
--    ficam no default. Sem isto, os templates es-MX existiriam escritos e
--    inalcançáveis até o Brief 7, e uma campanha mexicana que entrasse
--    antes receberia email em português.
--
--    DEFAULT 'pt-BR' + NOT NULL: lote antigo e lote criado pelo admin de
--    hoje (que ainda não conhece esta coluna) continuam funcionando sem
--    tocar em nada. O Brief 7, quando chegar, pode sobrescrever isto com
--    o locale do site que originou o resgate — esta coluna vira o
--    fallback, não o conflito.
--
--    CHECK fechado nos dois idiomas que existem. Locale novo exige mexer
--    aqui E nos templates; falhar no INSERT é melhor que mandar email
--    num idioma sem tradução.
-- ---------------------------------------------------------------------
ALTER TABLE public.pv_batches
  ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'pt-BR';

DO $$
BEGIN
  ALTER TABLE public.pv_batches
    ADD CONSTRAINT pv_batches_locale_chk CHECK (locale IN ('pt-BR', 'es-MX'));
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- já aplicada
END $$;

COMMENT ON COLUMN public.pv_batches.locale IS
  'Brief 5. Idioma dos emails transacionais deste lote (pt-BR | es-MX). '
  'O Brief 7 pode sobrescrever com o locale do site; esta coluna e o fallback.';


-- ---------------------------------------------------------------------
-- 1b) pv_batches.site_host — o hostname do parceiro, para os links.
--
--    O branding VISUAL dos emails é Recarga Games para todo mundo. O que
--    varia é o destino dos links: um resgate do lote da Plusmo não pode
--    mandar o portador para reload.recargagames.com, que é um site que
--    ele nunca viu.
--
--    POR QUE ISTO VEM DO BANCO E NÃO DO REQUEST: seria natural usar o
--    Host da requisição — é literalmente "de onde veio o resgate". Mas
--    esse header é controlado por quem chama, e o /api/redeem aceita
--    request sem Origin (curl). Um `Host: evil.com` forjado colocaria um
--    link para evil.com dentro de um email assinado com o NOSSO DKIM.
--    Injeção de Host em link de email é vetor conhecido de phishing.
--    Vindo do lote, o valor é escrito por admin e nunca pelo visitante.
--
--    CHECK de formato: só hostname. Sem esquema, sem barra, sem espaço,
--    sem aspas — nada que possa escapar do atributo href no template.
--    O código valida de novo (defesa em profundidade), mas a primeira
--    barreira é aqui, onde o dado entra.
-- ---------------------------------------------------------------------
ALTER TABLE public.pv_batches
  ADD COLUMN IF NOT EXISTS site_host text NOT NULL DEFAULT 'reload.recargagames.com';

DO $$
BEGIN
  ALTER TABLE public.pv_batches
    ADD CONSTRAINT pv_batches_site_host_chk
      CHECK (site_host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' AND length(site_host) BETWEEN 4 AND 253);
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- já aplicada
END $$;

COMMENT ON COLUMN public.pv_batches.site_host IS
  'Brief 5. Hostname do parceiro, usado nos LINKS dos emails (o branding '
  'visual segue Recarga Games para todos). Vem do banco e nunca do header '
  'Host, que e controlado por quem chama.';


-- ---------------------------------------------------------------------
-- 2) pv_vouchers.welcome_email_at — boas-vindas, UMA VEZ POR VOUCHER.
--
--    A coluna fica no VOUCHER, e não no attempt, de propósito. O brief
--    pede "uma vez por voucher", e um voucher pode ter várias tentativas
--    (create recusado devolve o voucher pra EMITIDO e o portador tenta de
--    novo). No attempt, cada retentativa mandaria um "bem-vindo" novo.
--
--    É também a trava de concorrência: quem envia é quem ganhar o UPDATE
--    condicional `welcome_email_at IS NULL`. Dois submits simultâneos, um
--    email. Mesmo padrão do claim atômico.
-- ---------------------------------------------------------------------
ALTER TABLE public.pv_vouchers
  ADD COLUMN IF NOT EXISTS welcome_email_at timestamptz;

COMMENT ON COLUMN public.pv_vouchers.welcome_email_at IS
  'Brief 5. Quando as boas-vindas foram enviadas. Serve de trava: o envio '
  'so acontece para quem ganhar o UPDATE condicional IS NULL.';


-- ---------------------------------------------------------------------
-- 3) pv_redeem_attempts — entrega do PIN por email.
--
--    Duas colunas, com papéis diferentes:
--
--    pin_email_due  FILA. Vira true quando um resgate de PIN fecha com
--                   sucesso, e volta a false quando o email sai. É o que
--                   a reconciliação varre para reenviar.
--    pin_email_at   AUDITORIA. Carimba o envio bem-sucedido e nunca é
--                   limpo.
--
--    Por que duas e não uma: com só `pin_email_at IS NULL` como fila, TODO
--    resgate DTU (que nunca recebe email de PIN) ficaria na fila para
--    sempre, engordando o índice e a varredura com linhas que nunca saem.
--    A flag separada mantém a fila com o que de fato está pendente.
-- ---------------------------------------------------------------------
ALTER TABLE public.pv_redeem_attempts
  ADD COLUMN IF NOT EXISTS pin_email_due boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_email_at  timestamptz;

-- Índice PARCIAL: só as linhas realmente pendentes entram. Em regime
-- normal a fila é quase sempre vazia, então este índice fica minúsculo
-- mesmo com milhões de resgates. Mesmo raciocínio do
-- pv_vouchers_processing_idx do Brief 3.
CREATE INDEX IF NOT EXISTS pv_redeem_attempts_pin_email_due_idx
  ON public.pv_redeem_attempts (created_at)
  WHERE pin_email_due;

COMMENT ON COLUMN public.pv_redeem_attempts.pin_email_due IS
  'Brief 5. Fila de reenvio do email de PIN. true = pendente. A '
  'reconciliacao varre isto e reenvia dentro de 24h.';


-- =====================================================================
-- 4) TESTES DE VERIFICAÇÃO  (rodar DEPOIS dos blocos acima)
-- ---------------------------------------------------------------------
-- As colunas herdam a RLS das tabelas, que já está trancada desde o
-- Brief 1 (admin-only, sem policy pra anon). Não há policy nova aqui.
--
-- Teste 1 — colunas criadas com os defaults certos:
--     SELECT table_name, column_name, data_type, is_nullable, column_default
--       FROM information_schema.columns
--      WHERE table_schema = 'public'
--        AND (table_name, column_name) IN (
--              ('pv_batches','locale'),
--              ('pv_batches','site_host'),
--              ('pv_vouchers','welcome_email_at'),
--              ('pv_redeem_attempts','pin_email_due'),
--              ('pv_redeem_attempts','pin_email_at'))
--      ORDER BY table_name, column_name;
--     -- esperado: locale NOT NULL default 'pt-BR'; pin_email_due NOT NULL
--     --           default false; os dois timestamptz nullable.
--
-- Teste 2 — lote existente ganhou os defaults, nenhum ficou nulo:
--     SELECT locale, site_host, count(*)
--       FROM public.pv_batches GROUP BY locale, site_host;
--     -- esperado: todos em 'pt-BR' / 'reload.recargagames.com'
--
-- Teste 3 — o CHECK barra idioma sem tradução:
--     BEGIN;
--       UPDATE public.pv_batches SET locale = 'en-US'
--        WHERE id = (SELECT id FROM public.pv_batches LIMIT 1);
--     ROLLBACK;
--     -- esperado: ERROR 23514 pv_batches_locale_chk
--
-- Teste 4 — a fila nasce vazia:
--     SELECT count(*) AS deve_ser_zero
--       FROM public.pv_redeem_attempts WHERE pin_email_due;
--
-- Teste 5 — o CHECK de site_host barra o que não é hostname:
--     BEGIN;
--       UPDATE public.pv_batches SET site_host = 'https://plusmo.mx/'
--        WHERE id = (SELECT id FROM public.pv_batches LIMIT 1);
--     ROLLBACK;
--     -- esperado: ERROR 23514 pv_batches_site_host_chk (esquema e barra)
--
--     BEGIN;
--       UPDATE public.pv_batches SET site_host = 'evil.com" onclick="x'
--        WHERE id = (SELECT id FROM public.pv_batches LIMIT 1);
--     ROLLBACK;
--     -- esperado: ERROR 23514 — é o que impede escapar do href no template
--
-- Teste 6 — configurar a campanha Plusmo (quando o lote existir):
--     UPDATE public.pv_batches
--        SET locale = 'es-MX', site_host = '<hostname da Plusmo>'
--      WHERE name = '<nome do lote>';
--     -- Os emails passam a sair em espanhol e com os links do parceiro,
--     -- mantendo o branding visual Recarga Games.
-- =====================================================================


-- =====================================================================
-- 5) ROLLBACK (Plano B) — descomentar e rodar para desfazer.
--
--    Só faz sentido DEPOIS de reverter o código do Brief 5. Com as
--    colunas removidas e o código no ar, o envio quebraria — mas o
--    RESGATE não: todo o envio vive atrás de try/catch e falha de email
--    nunca falha o resgate. Ainda assim, revert do código primeiro.
--
--    Não há dado pessoal aqui: só carimbos de tempo e uma flag.
-- ---------------------------------------------------------------------
-- DROP INDEX IF EXISTS public.pv_redeem_attempts_pin_email_due_idx;
-- ALTER TABLE public.pv_redeem_attempts
--   DROP COLUMN IF EXISTS pin_email_due,
--   DROP COLUMN IF EXISTS pin_email_at;
-- ALTER TABLE public.pv_vouchers  DROP COLUMN IF EXISTS welcome_email_at;
-- ALTER TABLE public.pv_batches   DROP CONSTRAINT IF EXISTS pv_batches_locale_chk;
-- ALTER TABLE public.pv_batches   DROP CONSTRAINT IF EXISTS pv_batches_site_host_chk;
-- ALTER TABLE public.pv_batches   DROP COLUMN IF EXISTS locale;
-- ALTER TABLE public.pv_batches   DROP COLUMN IF EXISTS site_host;
-- =====================================================================
