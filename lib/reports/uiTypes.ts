// Brief 28.0 — pure client-safe types for the report UI layer. No imports (no
// prisma / anthropic) so client components can use these without pulling server
// code into the bundle. Mirrors the SectionResult shape from the Brief 27
// generator (lib/reports/generators/types.ts) and the attachment shapes the chat
// route captures.

export type ReportSourceRef = { type: string; id?: string; at: string }

export type ReportSectionContent = {
  prose?: string
  items?: Array<Record<string, unknown>>
  metrics?: Array<{ label: string; value: string; source?: string }>
}

export type ReportSectionResult = {
  key: string
  title: string
  content: ReportSectionContent
  sources: ReportSourceRef[]
}

// Attached to a ChatMessage when a full report was generated this turn.
export type AttachedReport = {
  reportId: string
  templateId: string
  templateName: string
  subject: string
  sectionCount: number
  matchCount?: number
}

// Attached to a ChatMessage when a single section (fragment) was generated.
export type AttachedFragment = {
  templateId: string
  sectionKey: string
  title: string
  content: ReportSectionContent
  sources: ReportSourceRef[]
}
