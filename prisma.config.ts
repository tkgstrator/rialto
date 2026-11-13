/**
 * Prisma 7 moved the connection URL out of schema.prisma. The CLI reads
 * this file to know how to talk to Postgres for `migrate dev`, `migrate
 * deploy`, `studio`, etc. The runtime client builds its own adapter in
 * src/db/client.ts — keep the two in sync.
 */

import path from 'node:path'
import dotenv from 'dotenv'
import { defineConfig } from 'prisma/config'
import { PrismaPg } from '@prisma/adapter-pg'

// .env lives next to this file at the repo root. `prisma generate`
// doesn't need the URL so we don't fail at top level — the throw
// happens inside the adapter factory, which only runs for commands
// that actually talk to the DB (migrate, studio, etc.).
dotenv.config({ path: path.resolve(__dirname, '.env') })

const requireDatabaseUrl = (): string => {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Start the postgres service from .devcontainer/compose.yaml and copy .env.example to .env.'
    )
  }
  return url
}

// Prisma 7.8 made `datasource.url` mandatory for `migrate dev` /
// introspection commands. `generate` and other non-DB commands still
// need to work without DATABASE_URL (CI before .env is laid down), so
// we fall back to an empty string rather than throwing here.
export default defineConfig({
  schema: path.join('src', 'prisma', 'schema.prisma'),
  datasource: { url: process.env.DATABASE_URL ?? '' },
  migrations: {
    // No seed: providers and their models are created when the operator
    // adds them, and no other table needs a row to exist before first use.
    adapter: async () => new PrismaPg({ connectionString: requireDatabaseUrl() })
  }
})
