#!/usr/bin/env bash
# TEST-ONLY reset of the local compose database. Refuses to run on production.
set -euo pipefail
if [ "${APP_ENV:-test}" = "production" ]; then echo "Refusing: APP_ENV=production"; exit 1; fi
[ -f .env ] && set -a && . ./.env && set +a
case "${POSTGRES_DB:-}" in
  *_db|*_test) ;;
  *) echo "Refusing: '${POSTGRES_DB:-}' does not look like a test database"; exit 1 ;;
esac
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE order_items, worker_jobs, orders CASCADE;
UPDATE catalog SET available = 7  WHERE sku = 'KIT-100';
UPDATE catalog SET available = 12 WHERE sku = 'PART-200';
UPDATE catalog SET available = 5  WHERE sku = 'PACK-300';
SQL
echo "Test data reset."
