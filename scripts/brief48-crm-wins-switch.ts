// Brief 48 (PR 7): the CRM_WINS switch, which decides whether the morning CRM → DealFlow
// lead copy lets the CRM's values replace DealFlow's (lib/crm-sync/crmWins.ts) [Ryan,
// 2026-10-19: yes, behind a switch]. The executor turns it on in Brief 48 data step DS-4,
// after scripts/brief48-crm-wins-preview.ts. It takes effect at the next copy (7:00 am, or
// scripts/crm-lead-sync.ts). Turning it off is one command and takes effect the same way.
// Prints the switch's state only. It uses the DATABASE_URL in its environment only (it
// doesn't load .env).
//
//   npx tsx scripts/brief48-crm-wins-switch.ts                  # show the state
//   npx tsx scripts/brief48-crm-wins-switch.ts --on             # dry run: says what --apply would change
//   npx tsx scripts/brief48-crm-wins-switch.ts --on --apply     # turn it on (on the live database also --i-mean-live)
//   npx tsx scripts/brief48-crm-wins-switch.ts --off --apply    # turn it off
import { prisma } from '../lib/prisma'
import { maintenanceApply, scriptArgs } from '../lib/dbGuard'
import { CRM_WINS_USAGE, parseCrmWinsArgs, runCrmWinsSwitch } from '../lib/crm-sync/crmWins'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply on a
// database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief48-crm-wins-switch.ts (DATABASE_URL)')

async function main() {
  const wanted = parseCrmWinsArgs(scriptArgs())
  if (wanted === 'usage') {
    console.error(CRM_WINS_USAGE)
    process.exitCode = 2
    return
  }
  for (const line of await runCrmWinsSwitch(prisma, wanted, APPLY)) console.log(line)
}

main()
  .catch(e => {
    // Only the class name: a message could quote the query.
    console.error(`Failed (${e instanceof Error ? e.constructor.name : 'unknown'}).`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
