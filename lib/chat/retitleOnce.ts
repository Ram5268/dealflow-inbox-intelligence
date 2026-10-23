// Brief 43 PR 16 (Q36; U-08): the History drawer asks the server to title its
// untitled chats once per page load, not on every open. It used to call
// /api/chat/retitle on every open while any chat was untitled, and a chat the
// route can't title (an old one, or one with no message of Ryan's) kept that
// going for good. Returns whether to call the route, and marks these chats as
// asked. Pure, so it's unit-tested (retitleOnce.unit.test.ts).
export function shouldRetitle(sessions: ReadonlyArray<{ id: string; title: string | null }>, asked: Set<string>): boolean {
  const fresh = sessions.filter(s => !s.title && !asked.has(s.id))
  for (const s of fresh) asked.add(s.id)
  return fresh.length > 0
}
