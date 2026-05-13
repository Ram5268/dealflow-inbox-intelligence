'use client'

export default function ReadOnlyBanner() {
  return (
    <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 flex items-center gap-2 text-sm text-blue-800">
      <span className="text-base">🔒</span>
      <span>
        <strong>Read-Only Mode.</strong> This app only reads your Outlook inbox. It never sends, moves, deletes, or modifies emails.
      </span>
    </div>
  )
}
