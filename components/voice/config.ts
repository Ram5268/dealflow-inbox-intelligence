// Brief 36 — every voice-mode timing in one place, for tuning after Ryan's
// iPhone test.
export const VOICE_TIMING = {
  vadRedemptionMs: 900, // silence before the VAD calls end of speech (vad-web default: 1400)
  vadMinSpeechMs: 250, // shorter blips are misfires; low enough to keep a quick "yes"
  commitStableMs: 300, // after speech end, commit once the live text has been stable this long…
  commitMaxWaitMs: 1400, // …or at the latest this long after speech end
  finalTimeoutMs: 4000, // then wait this long for the final transcript
  listenSettleMs: 400, // re-clear the buffer this long after the mic reopens (echo/tail)
  sentenceGapS: 0.12, // pause between spoken sentences (TTS silence is trimmed)
  idleCloseMs: 5 * 60_000, // auto-close after this long without speech
  closeFadeMs: 200,
}

// Commit the turn once the live text has settled after the VAD's speech end, so
// audio still in flight isn't cut off (seen in WebKit during Phase 0).
export function shouldCommit(now: number, speechEndAt: number, lastDeltaAt: number, t = VOICE_TIMING): boolean {
  return now - speechEndAt >= t.commitMaxWaitMs || now - Math.max(speechEndAt, lastDeltaAt) >= t.commitStableMs
}
