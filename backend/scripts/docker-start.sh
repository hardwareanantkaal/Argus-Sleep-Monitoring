#!/bin/sh
# Container entry point: migrate the database, then start the server.
set -e
node scripts/migrate.js
exec node src/index.js
