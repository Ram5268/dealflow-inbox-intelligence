// Brief 41 (H11): DealFlow's database-backed tests may only touch a test
// database. A database whose name ends in `_perf` or `_test` is one; anything
// else (DATABASE_URL in .env is production) is refused, unless the run was
// started with `--i-mean-live` on its command line. Pure: no I/O.

export const LIVE_OVERRIDE_FLAG = '--i-mean-live'

export function databaseName(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || null
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
