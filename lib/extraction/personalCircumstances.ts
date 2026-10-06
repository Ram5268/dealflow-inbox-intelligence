// Brief 41 (H9): estate, probate, divorce and similar personal circumstances
// are never stored or shown. The seller-lead extractors no longer ask for them,
// and anything the model returns anyway is dropped here before saving.
const PERSONAL =
  /\b(probate|divorc\w*|passed away|deceased|death|died|dying|heirs?|inherit\w*|executor|executrix|widow\w*|funeral|(?<!real )estates?)\b/i

export function mentionsPersonalCircumstances(text: string | null | undefined): boolean {
  return !!text && PERSONAL.test(text)
}

// A motivation that mentions any of them is dropped entirely.
export function safeMotivation(motivation: string | null | undefined): string | null {
  const m = motivation?.trim()
  return m && !mentionsPersonalCircumstances(m) ? m : null
}

// Sentences that mention them are dropped from free text (summaries).
export function withoutPersonalCircumstances(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !mentionsPersonalCircumstances(sentence))
    .join(' ')
    .trim()
}
