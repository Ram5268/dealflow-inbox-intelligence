// Brief 41 (H11): DealFlow's database-backed tests may only touch a test
// database. A database whose name ends in `_perf` or `_test` is one; anything
// else (DATABASE_URL in .env is production) is refused, unless the run was
// started with `--i-mean-live` on its command line. Pure: no I/O.
//
// Brief 41.2 (PR B), engineering precaution: every script in scripts/ calls one
// of these at the top level, right after its imports, before any database read
// or write and any paid API call (lib/__tests__/scriptGuards.test.ts checks):
//   - test and seed scripts: refuseLiveDatabase(), a test database or nothing,
//     with no override (as the CRM's #40);
//   - live-maintenance scripts: maintenanceApply(), a dry run unless --apply,
//     and --apply on any other database also needs --i-mean-live;
//   - scripts that drive a dev server, also refuseRemoteServer().
// Each is given the URL the script really uses: process.env.DATABASE_URL, the
// value lib/prisma built its pool from when it was imported.

export const LIVE_OVERRIDE_FLAG = '--i-mean-live'
export const APPLY_FLAG = '--apply'
export const DRY_RUN_FLAG = '--dry-run'

export function databaseName(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    // Only postgres URLs: for others (e.g. socket:/x_test?db=railway) the path
    // isn't the database the driver uses.
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null
    const name = decodeURIComponent(u.pathname.replace(/^\//, ''))
    // Brief 41.2: a database name has no "/" ("railway/x_test" isn't a test
    // database; another client could use only its first part), as the CRM's guard.
    return name && !name.includes('/') ? name : null
  } catch {
    return null
  }
}

export function isTestDatabase(url: string | null | undefined): boolean {
  const name = databaseName(url)
  return !!name && /(_perf|_test)$/.test(name)
}

export function assertTestDatabase(url: string | null | undefined, what: string, argv: readonly string[] = process.argv): void {
  if (isTestDatabase(url) || argv.includes(LIVE_OVERRIDE_FLAG)) return
  throw new Error(
    `REFUSING: ${what} would use database "${databaseName(url) ?? '(not set)'}". ` +
      `Only a *_perf or *_test database is allowed (pass ${LIVE_OVERRIDE_FLAG} to run it against this one on purpose).`,
  )
}

const shownName = (url: string | null | undefined) => databaseName(url) ?? (url ? '(unreadable URL)' : '(not set)')

// Class 1, test or seed scripts: refuses anything but a *_perf / *_test
// database. There is no override, so the refusal doesn't offer one.
export function refuseLiveDatabase(url: string | null | undefined, what: string): void {
  if (isTestDatabase(url)) return
  throw new Error(
    `REFUSING: ${what} would use database "${shownName(url)}". ` +
      'It is a test or seed script, so it only runs on a *_perf or *_test database.',
  )
}

// --apply on the command line, and no --dry-run (a dry-run flag always wins).
export function applyRequested(argv: readonly string[] = process.argv): boolean {
  return argv.includes(APPLY_FLAG) && !argv.includes(DRY_RUN_FLAG)
}

// Class 2, live-maintenance scripts: true means write, false means a dry run
// (counts and plan only). It's a dry run unless --apply is given. --apply on a
// *_perf / *_test database writes; on any other database it also needs
// --i-mean-live, and a database name it can read. Otherwise it throws before
// anything runs.
export function maintenanceApply(url: string | null | undefined, what: string, argv: readonly string[] = process.argv): boolean {
  if (!applyRequested(argv)) return false
  if (isTestDatabase(url)) return true
  const name = databaseName(url)
  if (name && argv.includes(LIVE_OVERRIDE_FLAG)) return true
  throw new Error(
    name
      ? `REFUSING: ${what} --apply would write to database "${name}", which is not a *_perf or *_test database. ` +
          `Leave out --apply for a dry run, or add ${LIVE_OVERRIDE_FLAG} to write to this database on purpose.`
      : `REFUSING: ${what} --apply needs a database URL it can read; got "${shownName(url)}". Nothing was written.`,
  )
}

// A script's own arguments: the command line without node, the script and the
// guard flags, so --apply, --dry-run and --i-mean-live can go anywhere.
export function scriptArgs(argv: readonly string[] = process.argv): string[] {
  const flags = new Set([APPLY_FLAG, DRY_RUN_FLAG, LIVE_OVERRIDE_FLAG])
  return argv.slice(2).filter(a => !flags.has(a))
}

// The chat harnesses send prompts to a dev server, which saves chat rows to its
// own database. That server must be on this machine, so a slip can never send
// test traffic to the production app. The server's database can't be checked
// from here: start it on a test database.
export function refuseRemoteServer(url: string | null | undefined, what: string): void {
  let host = ''
  try {
    const u = new URL(url ?? '')
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname
  } catch {
    // not a URL
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return
  throw new Error(`REFUSING: ${what} would send to "${host || '(not a local http URL)'}". It only talks to a dev server on this machine (localhost).`)
}
