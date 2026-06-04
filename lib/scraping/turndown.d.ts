// Minimal ambient types for `turndown` (the package ships no .d.ts, and the
// Phase 4.1 scope forbids adding extra packages such as @types/turndown).
declare module 'turndown' {
  namespace TurndownService {
    interface Options {
      headingStyle?: 'setext' | 'atx'
      bulletListMarker?: '-' | '+' | '*'
      codeBlockStyle?: 'indented' | 'fenced'
      [key: string]: unknown
    }
  }
  class TurndownService {
    constructor(options?: TurndownService.Options)
    turndown(html: string): string
    remove(filter: string | string[]): TurndownService
    addRule(key: string, rule: unknown): TurndownService
  }
  export = TurndownService
}
