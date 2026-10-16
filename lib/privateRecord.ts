// Brief 41.1 (PR H): a production data script writes what it is about to
// change (a pre-image) to a private JSON file BEFORE it changes anything, so a
// run can be checked or undone later. The file holds row ids and old values,
// so it must never be committed: it goes outside every git checkout. The
// default is ~/dev/brief41-1/private/ (built from the home directory);
// --preimage-dir <dir> picks another. File system only: no DB, no network.
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const PREIMAGE_DIR_FLAG = '--preimage-dir'

// A refusal: nothing was written. The scripts print the message and exit 2.
export class PrivateDirRefusal extends Error {}

export function defaultPrivateDir(home: string = homedir()): string {
  return join(home, 'dev', 'brief41-1', 'private')
}

// --preimage-dir <dir> (relative to the current directory), or the default.
export function privateDirFrom(argv: readonly string[], cwd: string = process.cwd(), home: string = homedir()): string {
  const at = argv.indexOf(PREIMAGE_DIR_FLAG)
  if (at < 0) return defaultPrivateDir(home)
  const value = argv[at + 1]
  if (!value || value.startsWith('--')) throw new PrivateDirRefusal(`Refusing: ${PREIMAGE_DIR_FLAG} needs a directory. Nothing changed.`)
  return resolve(cwd, value)
}

// The real path of p with symlinks resolved, for the part of it that exists
// (the directory may not have been created yet).
function realPathOf(p: string): string {
  let head = resolve(p)
  const tail: string[] = []
  while (!existsSync(head)) {
    const up = dirname(head)
    if (up === head) break
    tail.unshift(basename(head))
    head = up
  }
  return join(realpathSync.native(head), ...tail)
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

// The git checkout that contains p (the nearest folder at or above it with a
// .git entry; a worktree has a .git file), or null.
export function gitCheckoutOf(p: string): string | null {
  for (let dir = realPathOf(p); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return null
  }
}

// Refuses a directory inside the repo or inside any git checkout, so a private
// file can never be committed. Returns the directory's real path.
export function assertPrivateDir(dir: string, repoRoot: string): string {
  const real = realPathOf(dir)
  if (isInside(real, realPathOf(repoRoot))) {
    throw new PrivateDirRefusal(`Refusing ${PREIMAGE_DIR_FLAG} ${dir}: it is inside the repo (${repoRoot}). Private files go outside every git checkout, e.g. ${defaultPrivateDir()}. Nothing changed.`)
  }
  const checkout = gitCheckoutOf(real)
  if (checkout) {
    throw new PrivateDirRefusal(`Refusing ${PREIMAGE_DIR_FLAG} ${dir}: it is inside the git checkout ${checkout}. Private files go outside every git checkout, e.g. ${defaultPrivateDir()}. Nothing changed.`)
  }
  return real
}

// A file name that sorts by time, e.g. brief41-x-2026-10-11T18-42-00-000Z.json
export function privateFileName(prefix: string, now: Date): string {
  return `${prefix}-${now.toISOString().replace(/[:.]/g, '-')}.json`
}

// Makes dir owner-only (0700), whether it is new or already there: mkdir's
// mode only applies to a folder it creates, so an existing 0755 folder would
// otherwise stay readable by others. Refuses if that can't be done.
export function makeOwnerOnly(dir: string): void {
  try {
    chmodSync(dir, 0o700)
  } catch (e) {
    throw new PrivateDirRefusal(`Refusing: can't make ${dir} owner-only (${(e as Error).message}). Nothing changed.`)
  }
  if ((statSync(dir).mode & 0o077) !== 0) {
    throw new PrivateDirRefusal(`Refusing: ${dir} is still readable by others after chmod 700. Nothing changed.`)
  }
}

// Writes data as JSON to a new file in dir, which is created if missing and
// made owner-only either way. The file is readable by the owner only and is
// never overwritten. Returns its path.
export function writePrivateJson(dir: string, repoRoot: string, name: string, data: unknown): string {
  if (name !== basename(name)) throw new PrivateDirRefusal(`Refusing: "${name}" is not a plain file name. Nothing changed.`)
  const real = assertPrivateDir(dir, repoRoot)
  mkdirSync(real, { recursive: true, mode: 0o700 })
  makeOwnerOnly(real)
  const file = join(real, name)
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  return file
}
