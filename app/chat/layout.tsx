import type { Metadata } from 'next'

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]): a seller card's phone number is plain
// text, with no tel: link. iPhone Safari turns phone-shaped text into a tap-to-
// call link on its own unless the page says not to, so the chat page says not
// to [engineering precaution: nothing is dialed from Drift, Ryan 2026-09-24].
export const metadata: Metadata = {
  formatDetection: { telephone: false },
}

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return children
}
