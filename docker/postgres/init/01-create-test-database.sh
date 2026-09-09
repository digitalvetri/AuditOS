#!/bin/bash
# Runs once, on first container start, before Postgres accepts connections.
# The primary database ($POSTGRES_DB, default "auditos") is created by the
# official image; we add the parallel test database here so the vitest
# suite has its own DB and never touches dev data.

set -euo pipefail

TEST_DB="${POSTGRES_DB}_test"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE ${TEST_DB};
    GRANT ALL PRIVILEGES ON DATABASE ${TEST_DB} TO ${POSTGRES_USER};
EOSQL
