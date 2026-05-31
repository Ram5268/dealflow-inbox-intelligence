import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  experimental: {
    externalTables: true,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed.ts',
    initShadowDb: 'CREATE EXTENSION IF NOT EXISTS vector;',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
    shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'],
  },
})
