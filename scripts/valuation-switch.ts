// Brief 44 (PR 4): the USE_OUR_ESTIMATES switch, which decides whether nightly matching
// prices CRM sellers by DealFlow's own published values (lib/matching/ourEstimates.ts).
// The executor turns it on in Brief 44's data step V4 (Ryan's yes given in advance,
// 2026-10-17); the nightly job turns it back off by itself if our values fail its
// rollback checks. It takes effect at the next nightly run. Prints the switch's state
// only. It uses the DATABASE_URL in its environment only (it doesn't load .env).
//
//   npx tsx scripts/valuation-switch.ts                  # show the state
//   npx tsx scripts/valuation-switch.ts --on             # dry run: says what --apply would change
//   npx tsx scripts/valuation-switch.ts --on --apply     # turn it on (on the live database also --i-mean-live)
//   npx tsx scripts/valuation-switch.ts --off --apply    # turn it off
import { prisma } from '../lib/prisma'
import { maintenanceApply, scriptArgs } from '../lib/dbGuard'
import { SWITCH_USAGE, parseSwitchArgs, runSwitchCommand } from '../lib/matching/ourEstimates'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply on a
// database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/valuation-switch.ts (DATABASE_URL)')

async function main() {
  const wanted = parseSwitchArgs(scriptArgs())
  if (wanted === 'usage') {
    console.error(SWITCH_USAGE)
    process.exitCode = 2
    return
  }
  for (const line of await runSwitchCommand(prisma, wanted, APPLY)) console.log(line)
}

main()
  .catch(e => {
    // Only the class name: a message could quote the query.
    console.error(`Failed (${e instanceof Error ? e.constructor.name : 'unknown'}).`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
