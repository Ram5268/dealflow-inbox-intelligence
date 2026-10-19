// Brief 45 (PR E): import this FIRST in a test file to point lib/prisma at an
// in-memory stand-in (memoryDb.ts), as app/api/matches/__tests__/byId.test.ts
// does with its own fake. lib/prisma uses globalThis.prisma when it is set, so
// no database client is ever created. Swap `current.mem` between cases.
import { memoryDb } from './memoryDb'

export const current = { mem: memoryDb() }
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_target, prop) => (current.mem.db as unknown as Record<string | symbol, unknown>)[prop],
})
