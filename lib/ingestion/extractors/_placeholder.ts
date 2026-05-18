// Placeholder used by the router until a specialized extractor is built for this category.
// Falls back to the existing monolithic classifier so behavior is unchanged during migration.
import { classifyAndExtractEmail } from '../../ai'
import type { ExtractorInput, ExtractionResult } from '../types'

export default async function extract(input: ExtractorInput): Promise<ExtractionResult[]> {
  const results = await classifyAndExtractEmail({
    subject:         input.subject,
    senderName:      input.senderName,
    senderEmail:     input.senderEmail,
    receivedDateTime:new Date().toISOString(),
    bodyPreview:     input.bodyPreview,
    fullBody:        input.fullBody,
    attachmentText:  input.attachmentText,
  })
  return results as ExtractionResult[]
}
