// Brief 48 (PR 7): the CRM_WINS switch, which decides whether the morning CRM → DealFlow
// lead copy lets the CRM's values replace DealFlow's (lib/crm-sync/crmWins.ts) [Ryan,
// 2026-10-19: yes, behind a switch]. The executor turns it on in Brief 48 data step DS-4,
// after scripts/brief48-crm-wins-preview.ts. It takes effect at the next copy (the nightly run
// at 09:00 UTC, or scripts/crm-lead-sync.ts). Turning it off stops further changes but doesn't undo the ones
// made; --restore does (lib/crm-sync/crmWinsBackup.ts). Prints the switch's state and counts
// only. It uses the DATABASE_URL in its environment only (it doesn't load .env).
//
//   npx tsx scripts/brief48-crm-wins-switch.ts                  # show the state
//   npx tsx scripts/brief48-crm-wins-switch.ts --on             # dry run: says what --apply would do
//   npx tsx scripts/brief48-crm-wins-switch.ts --on --apply     # save a private before-copy, then turn it on
//                                                               #   (on the live database also --i-mean-live)
//   npx tsx scripts/brief48-crm-wins-switch.ts --off --apply    # turn it off (changes made stay)
//   npx tsx scripts/brief48-crm-wins-switch.ts --restore <file>          # dry run: counts only
//   npx tsx scripts/brief48-crm-wins-switch.ts --restore <file> --apply  # switch off + the saved columns back, one transaction
// Never run `--restore --apply` between 08:50 and 09:30 UTC, around the nightly copy (a copy that
// finds the switch changed under it rolls back, but the restore then waits on it).
// The before-copy goes to ~/dev/brief48-dealflow-fixes/private/ (or --preimage-dir <dir>):
// an owner-only folder outside every git checkout, an owner-only file, its path printed,
// its contents (names, numbers, notes) never.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '../lib/prisma'
import { maintenanceApply, scriptArgs } from '../lib/dbGuard'
import { CRM_WINS, CRM_WINS_USAGE, describeCrmWins, runCrmWinsSwitch } from '../lib/crm-sync/crmWins'
import {
  RestoreRefused, applyRestore, defaultBeforeCopyDir, parseBeforeCopy, parseSwitchCommand, readBeforeCopy, restoreCheck,
} from '../lib/crm-sync/crmWinsBackup'
import { PrivateDirRefusal, privateFileName, writePrivateJson } from '../lib/privateRecord'
import { ORG_SLUG } from '../lib/crm-sync/runSync'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply on a
// database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief48-crm-wins-switch.ts (DATABASE_URL)')

async function main() {
  const cmd = parseSwitchCommand(scriptArgs())
  if (cmd === 'usage') {
    console.error(CRM_WINS_USAGE)
    process.exitCode = 2
    return
  }
  if (cmd.kind === 'state' || cmd.kind === 'off') {
    for (const line of await runCrmWinsSwitch(prisma, cmd.kind === 'off' ? 'off' : null, APPLY)) console.log(line)
    return
  }
  // Brief 48 (PR 7 review r2) [engineering precaution]: the file holds names and numbers; one
  // that others can read is refused before anything is read, so a stray copy gets noticed.
  if (cmd.kind === 'restore' && (statSync(cmd.file).mode & 0o077) !== 0) {
    throw new RestoreRefused('others can read that before-copy; make it owner-only first (chmod 600); nothing changed')
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
  const flag = await prisma.featureFlag.findUnique({ where: { id: CRM_WINS }, select: { enabled: true } })
  if (cmd.kind === 'restore') {
    const copy = parseBeforeCopy(JSON.parse(readFileSync(cmd.file, 'utf8')), org.id)
    const c = await restoreCheck(prisma, copy)
    console.log(`${CRM_WINS}: ${describeCrmWins(flag)}`)
    console.log(`Before-copy from ${copy.createdAt}: ${c.rowsInFile} sellers' rows; ${c.found} found, ${c.missing} gone; ${c.differ} differ now; do-not-call statuses that arrived since, kept: ${c.statusesKept}; sellers first copied since (left as they are): ${c.addedSince}.`)
    if (!APPLY) {
      console.log('Dry run: nothing changed. Add --apply to turn the switch off and put those rows back, in one transaction.')
      return
    }
    const r = await applyRestore(prisma, copy)
    console.log(`${CRM_WINS} -> off. Restored ${r.restored} sellers' rows; ${r.stillDiffer} still differ (should be 0).`)
    return
  }
  // --on
  const lines = await runCrmWinsSwitch(prisma, 'on', false)
  const already = flag?.enabled === true
  if (!APPLY || already) {
    for (const line of lines) console.log(line)
    if (!already) console.log(`With --apply it first saves a private before-copy of ${(await readBeforeCopy(prisma, org.id)).rows.length} sellers' rows.`)
    return
  }
  const copy = await readBeforeCopy(prisma, org.id)
  const file = writePrivateJson(cmd.dir ?? defaultBeforeCopyDir(homedir()), join(__dirname, '..'), privateFileName('brief48-crm-wins-before', new Date()), copy)
  console.log(`Before-copy: ${copy.rows.length} sellers' rows saved to ${file} (owner-only; not printed).`)
  for (const line of await runCrmWinsSwitch(prisma, 'on', true)) console.log(line)
}

main()
  .catch(e => {
    // A refusal of our own names no data; otherwise only the class name: a message could quote the query.
    const own = e instanceof RestoreRefused || e instanceof PrivateDirRefusal
    console.error(own ? `Refused: ${e.message}` : `Failed (${e instanceof Error ? e.constructor.name : 'unknown'}).`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
