#!/usr/bin/env bash
# Checklist de segurança do Brief 2, automatizado.
#
# 1) Nada de secret no bundle público (public/ é o que o Netlify publica).
# 2) Nenhuma referência a PROXY_ADMIN_KEY em repo nenhum arquivo — a Lapak
#    é Brief 3, esta chave não entra aqui.
# 3) Nenhum SKU/product_code no front.
#
# Rodar: bash tests/check-secrets.sh   (ou npm run check:secrets)
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { printf '  %s %s\n' "$1" "$2"; }

echo "→ 1. secrets no bundle público (public/)"
for pattern in 'sb_secret' 'SUPABASE_SECRET_KEY' 'IP_HASH_SALT' 'service_role' 'eyJhbGciOi'; do
  if grep -rIn --exclude-dir=.git -- "$pattern" public/ >/dev/null 2>&1; then
    report "✗" "ENCONTRADO '$pattern' em public/ — abortar deploy"
    grep -rIn --exclude-dir=.git -- "$pattern" public/ | sed 's/^/      /'
    fail=1
  else
    report "✓" "sem '$pattern'"
  fi
done

echo "→ 2. PROXY_ADMIN_KEY não existe neste repo (é Brief 3)"
if grep -rIn --exclude-dir=.git --exclude-dir=node_modules --exclude="check-secrets.sh" -- 'PROXY_ADMIN_KEY' . >/dev/null 2>&1; then
  report "✗" "ENCONTRADO PROXY_ADMIN_KEY"
  grep -rIn --exclude-dir=.git --exclude-dir=node_modules --exclude="check-secrets.sh" -- 'PROXY_ADMIN_KEY' . | sed 's/^/      /'
  fail=1
else
  report "✓" "nenhuma referência"
fi

echo "→ 3. SKU / product_code fora do front"
if grep -rIn --exclude-dir=.git -- 'product_code' public/ >/dev/null 2>&1; then
  report "✗" "product_code aparece em public/"
  fail=1
else
  report "✓" "front não conhece product_code"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "OK — checklist de secrets passou."
else
  echo "FALHOU — corrigir antes de deployar."
fi
exit "$fail"
