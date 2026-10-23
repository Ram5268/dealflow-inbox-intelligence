// Brief 48 PR 13 (M22; TEST_PLAN E-12): which chat is on screen, so a reply is
// filed in the chat it was asked in.
//
// The chat page used to apply a reply to whatever chat was open when it
// arrived, then set the open chat back to the one it was asked in: switch
// chats while Drift was answering, and chat A's reply showed in chat B, and
// Ryan's next message went to chat A. Now each question carries a token of the
// chat it was asked in, and the reply asks replyAction what to do:
//   - 'show': the same chat is still on screen (it may have just got its id);
//   - 'reload': Ryan went away and came back to that chat, so its messages are
//     read again from the server, which saved the reply with them;
//   - 'drop': another chat is on screen. The server saved the reply in its own
//     chat, where Ryan sees it when he opens that chat.
// Pure: the page keeps one of these for its lifetime.

export type ChatViewToken = { readonly view: number; readonly sessionId: string | null }
export type ReplyAction = 'show' | 'reload' | 'drop'

export function createChatView() {
  let view = 0
  let sessionId: string | null = null
  return {
    /** Another chat, or a new empty one (null), is now on screen. */
    open(id: string | null): void {
      view++
      sessionId = id
    },
    /** The chat on screen got its id (its first reply or report created it). */
    adopt(id: string | null | undefined): void {
      if (id) sessionId = id
    },
    /** The chat on screen, for a question being asked now. */
    token(): ChatViewToken {
      return { view, sessionId }
    },
    /** Is the chat a question was asked in still the one on screen? */
    isCurrent(sent: ChatViewToken): boolean {
      return sent.view === view
    },
    /** What to do with the reply to a question asked in `sent`. */
    replyAction(sent: ChatViewToken, replySessionId: string | null | undefined): ReplyAction {
      if (sent.view === view) return 'show'
      return replySessionId != null && replySessionId === sessionId ? 'reload' : 'drop'
    },
  }
}

export type ChatView = ReturnType<typeof createChatView>
