import { getCurrentOrgId } from './auth/orgContext'
import { runCrmLeadSync } from './crm-sync/runSync'
import { runNightlyScoring } from './matching/nightly/runScoring'
import { buildCallQueue } from './ranking/queueBuilder'

// Brief 35: the nightly pipeline, shared by /api/cron/nightly-pipeline and
// scripts/nightly-pipeline.ts. Steps run in order, each in its own try/catch,
// so a failed step never stops the ones after it.
//   1 crmLeadSync  CRM → DealFlow lead sync (Brief 34)
//   2 scoring      CRM sellers × buyer demand → Match rows
//   3 callQueue    rebuild the call list (CRM sellers only)
export type StepOutcome = { ok: true; result: unknown } | { ok: false; error: string }

export async function runSteps(steps: Record<string, () => Promise<unknown>>) {
  const outcomes: Record<string, StepOutcome> = {}
  for (const [name, step] of Object.entries(steps)) {
    try {
      outcomes[name] = { ok: true, result: await step() }
    } catch (e) {
      console.error(`[nightly-pipeline] ${name} failed:`, (e as Error).message)
      outcomes[name] = { ok: false, error: (e as Error).message }
    }
  }
  return { ok: Object.values(outcomes).every(o => o.ok), steps: outcomes }
}

export const STEP_NAMES = ['crmLeadSync', 'scoring', 'callQueue'] as const

// Brief 37: step 3 persists every ranked CRM seller (ranks 1..N), not the top 50.
// The CRM pulls the whole list each morning and shows it in its own queue.
export const CALL_LIST_LIMIT = Infinity
export type StepName = (typeof STEP_NAMES)[number]

// dryRun: steps 1-2 run their SQL and roll back; step 3 ranks without saving.
export function runNightlyPipeline({ dryRun = false, only }: { dryRun?: boolean; only?: StepName } = {}) {
  const all: Record<StepName, () => Promise<unknown>> = {
    crmLeadSync: () => runCrmLeadSync({ dryRun }),
    scoring: () => runNightlyScoring({ dryRun }),
    callQueue: async () => {
      const { stats, generationRunId } = await buildCallQueue(await getCurrentOrgId(), CALL_LIST_LIMIT, !dryRun, { scope: 'crm' })
      return { generationRunId, persisted: !dryRun, ...stats }
    },
  }
  return runSteps(only ? { [only]: all[only] } : all)
}
