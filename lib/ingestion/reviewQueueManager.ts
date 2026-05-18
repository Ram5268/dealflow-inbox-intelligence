import { prisma } from '../prisma'
import type { ValidationFlag } from './types'

const FLAG_SUGGESTIONS: Record<string, string> = {
  low_confidence:          'Review extracted fields and approve if correct, or correct them manually.',
  ambiguous_category:      'Verify the category is correct. Consider correcting to the right category.',
  missing_address:         'Check the source email for an address. Add it via Correct or reject if not applicable.',
  possible_duplicate:      'Compare with existing records. Mark as Duplicate if this is the same property.',
  conflicting_category:    'Verify which category best fits this email.',
  schema_validation_failed:'Extraction failed — review the source email and manually correct or reprocess.',
  multi_listing_ambiguity: 'This email may contain multiple properties. Review and split if needed.',
  missing_date:            'Showing confirmation is missing a date. Add it via Correct or reject.',
  price_sanity:            'The extracted price looks wrong. Correct or reject.',
}

export async function queueItem(
  opportunityId: string,
  rawEmailId: string,
  flags: ValidationFlag[],
): Promise<void> {
  if (flags.length === 0) return

  for (const flag of flags) {
    await prisma.reviewQueueItem.create({
      data: {
        opportunityId,
        rawEmailId,
        flagReason:      flag.reason,
        suggestedAction: FLAG_SUGGESTIONS[flag.reason] ?? 'Review this extraction.',
        status:          'pending',
      },
    }).catch(() => {}) // non-fatal — never let review queue creation crash the pipeline
  }
}

export async function queueInvalidExtraction(
  rawEmailId: string,
  reason: string,
): Promise<void> {
  await prisma.reviewQueueItem.create({
    data: {
      rawEmailId,
      flagReason:      'schema_validation_failed',
      suggestedAction: `Extraction failed: ${reason.slice(0, 200)}. Reprocess or manually review.`,
      status:          'pending',
    },
  }).catch(() => {})
}

export async function getPendingCount(): Promise<number> {
  try {
    return await prisma.reviewQueueItem.count({ where: { status: 'pending' } })
  } catch {
    return 0
  }
}
