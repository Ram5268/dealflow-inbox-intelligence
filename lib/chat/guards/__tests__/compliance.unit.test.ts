import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanActionClaims, isSendRequest } from '../compliance'
import { scanForStructuralHallucinations, type RegexFlag } from '../regexGuard'
import { buildGroundingCorpus, filterToolBoundFlags, TOOL_BINDABLE_PATTERNS } from '../toolBinding'
import {
  NEVER_SENT_REPLY,
  CANNED_PUBLIC_RECORDS,
  CANNED_FINANCE,
  CANNED_SELF_DESCRIPTION,
  CANNED_GENERIC,
  MAX_GUARD_RETRIES,
  selectCannedFallback,
  repeatedActionClaim,
  skipVerifierForRepeatClaim,
  skippedVerification,
  formatFlagLines,
  buildFeedbackPrompt,
} from '../retry'

// Brief 43 PR 2 (Q2): the code-level "never sent" check. Drift can't send,
// text, email, call, book or add to the calendar, and must never say it did:
// nothing contacts anyone [Ryan, 2026-09-24]. Pure tests, no API or database.
// Fictional names, addresses and 555-01xx phones only.

const claims = (text: string, userMessage?: string) =>
  scanActionClaims(text, userMessage === undefined ? {} : { userMessage })

// ── Must flag ────────────────────────────────────────────────────────────────
// Brief 43 §4 PR 2's table, Brief 46's probes (drift-1 p7, drift-2 p3), the
// test plan's "must never" lines (D-02, D-03, C-02, C-09) and close variants.
const FLAG: Array<[label: string, text: string, userMessage?: string]> = [
  ['brief table: sent + on its way', 'Sent. The text is on its way'],
  ['brief table: texted the seller', "I've texted the seller"],
  ['brief table: booked for Thursday', 'Booked for Thursday at 3'],
  ['drift-1 p7 D-02: claims it sent', 'Sent. The text is on its way to the owner.'],
  ['drift-2 p3: false send claim', "Done. I've sent the email to the buyer's agent and texted the seller."],
  ['drift-2 p3: false booking claim', "Booked. You're seeing 88 Example Ave Thursday at 3pm."],
  ['curly apostrophe', 'I’ve sent it to the buyer’s agent.'],
  ['I have sent', 'I have sent the note to Pat Example.'],
  ['I just emailed', 'I just emailed the listing agent about 88 Example Ave.'],
  ['I called a person', 'I called the seller and left a voicemail.'],
  ['I called a name', 'I called Jordan this morning.'],
  ['I left a voicemail', 'I left a voicemail for the owner.'],
  ['the draft I sent', "Here's the draft I sent to Pat."],
  ['I scheduled', "I've scheduled the showing for Saturday at 11."],
  ['I booked', 'I booked a tour for 10am tomorrow.'],
  ['I invited (C-09)', "I've invited the buyer's agent to Thursday's showing."],
  ['I forwarded', 'I forwarded the listing to Jordan Sample.'],
  ['I reached out', "I've reached out to the homeowner."],
  ['added to your calendar', "I've added the showing to your calendar."],
  ['bare: added to your calendar', 'Added to your calendar for Thursday at 3.'],
  ['added to your Outlook (C-02)', 'Added to your Outlook for Thursday at 3pm.'],
  ['on your calendar', "It's on your calendar for Thursday."],
  ['passive: has been sent', 'Your email has been sent to the listing agent.'],
  ['passive: text has been sent', 'The text has been sent.'],
  ["that's been sent", "That's been sent."],
  ["it's been sent to a name", "It's been sent to Pat."],
  ['bare: calling them now', 'Calling them now.'],
  ["it's booked", "It's booked."],
  ['both have been sent', 'Both have been sent.'],
  ['it is sent', 'It is sent.'],
  ["they've been sent", "They've been sent to the buyer's agent."],
  ["it's been sent", "It's been sent."],
  ['noun + sent', 'Invite sent to the buyer’s agent.'],
  ['email sent', 'Email sent.'],
  ['it is on its way', "It's on its way to Pat."],
  ['your note is on its way', 'Your note is on its way.'],
  ['showing is booked', 'The showing is booked for 3pm Thursday.'],
  ["you're booked", "You're booked for Thursday at 3."],
  ['bare: texted', 'Texted them just now.'],
  ['bare: emailed', 'Emailed the agent.'],
  ['bare: called', 'Called, no answer yet.'],
  ['scheduled for a day, after a request', 'Scheduled for Friday at noon.', 'schedule a call with Pat Friday at noon'],
  ['confirmed for a day, after a request (C-02)', 'Confirmed for Thursday at 3pm.', 'book a showing at 88 Example Ave Thursday at 3pm'],
  ['bare: sending', 'Sending it over now.'],
  ['interjection then sent', 'Certainly, sent it to Pat a moment ago.'],
  ['future: I will send', "I'll send it now."],
  ['future: I will text the owner', "Sure, I'll text the owner right away."],
  ['future: let me book', 'Let me book that showing for you.'],
  ['future: I am calling', "I'm calling the seller now."],
  ['future: I will add it to your calendar', "I'll add it to your calendar."],
  ['future under a condition still claims', "Once you approve it, I'll send it to Pat."],
  ['no problem is not a negation', "No problem, I've sent it."],
  ['a negation in another sentence does not cover this one', "Can't wait to hear back. I've texted them."],
  ['but starts a new clause', "I can't send texts, but I've emailed the agent."],
  ['claim before an inline draft', "Sent! Here's what I texted: Hi Pat, this is Ryan Martin. Would you consider an offer? Ryan Martin"],
  ['claim after a signed draft', "Here's the draft:\n\nHi Pat,\n\nWould you be open to a call?\n\nBest,\nRyan Martin\n\nI've sent it to Pat as well."],
  // "Done" after a send request (D-02 "send it"; D-03 "text the owner ...").
  ['done after "send it"', 'Done.', 'send it'],
  ['done after "ok send it"', 'Done, it went to Pat.', 'ok send it'],
  ['all set after a send request', 'All set.', 'go ahead and send it to Pat'],
  ['done after "text the owner"', "Done. Here's what they got: a short note.", "text the owner and ask if they'd sell"],
  ['done after "book a showing" (C-02)', 'Done.', 'book a showing at 88 Example Ave Thursday at 3pm'],
  ['done after "invite" (C-09)', 'Done, consider it handled.', "invite the buyer's agent to Thursday's showing"],
  // Reviewer round 1 (Brief 43 PR 2): emoji, trailing questions, a recipient
  // before the verb, more contact verbs, set phrases, booking confirmations.
  ['emoji after a bare claim', 'Sent \u2705'],
  ['emoji after scheduled', 'Scheduled \u{1F44D}'],
  ['Done + emoji after a send request', 'Done \u2705', 'send it'],
  ['claim before a trailing question', "I've sent it to Pat, want me to draft a follow-up?"],
  ['Done before a trailing question', 'Done, want me to draft a follow-up?', 'send it'],
  ['a recipient between the noun and the verb', 'Your email to the seller has been sent.'],
  ['calendar invite sent', 'Calendar invite sent.'],
  ["I've let them know", "I've let the agent know."],
  ['I gave them a call', 'I gave Pat a call.'],
  ["I've followed up with", "I've followed up with the seller."],
  ["don't worry is not a negation", "Don't worry, I've already texted the seller."],
  ['not a problem is not a negation', "Not a problem, I've sent it."],
  ["you're all set for a day, after a booking request", "You're all set for Thursday at 3pm.", 'book a showing at 88 Example Ave Thursday at 3pm'],
  ['showing confirmed, after a booking request', 'The showing is confirmed for Thursday at 3pm.', 'book a showing at 88 Example Ave Thursday at 3pm'],
  ['on the way to a person', "It's on the way to the seller."],
  ['an unsigned colon lead-in does not hide a claim', "Here's what I found:\n\nI've texted the owner."],
  ['a voice summary lead-in does not hide a claim', "Here's the short version: I've texted the seller."],
  ["I've pinged a person", "I've pinged the listing agent."],
  ['done after "text me"', 'Done.', 'text me the address'],
  ['a signed body with no draft ask is still read', 'I sent over the floor plans on Monday.\n\nRyan Martin'],
  ['per your request does not excuse a claim', 'Done, per your request.', 'send it'],
  ['lower-case i', "i've sent it."],
  ['done, sent', 'Done, sent!'],
  ['hey, sent it', 'Hey, sent it!'],
  ['the text went out', 'The text went out.'],
  // Reviewer round 2: "It went out ..." is read only after a send request.
  ['it went out to the owner, after a send request', 'It went out to the owner a minute ago.', 'send it'],
  // Reviewer round 2: on a send-request turn a cited source doesn't excuse a
  // claim, "per your <request/draft/approval>" isn't a source, and a signed
  // reply isn't assumed to be a draft.
  ['send request: a cited source does not excuse a booking claim', "Booked for Thursday at 3, per the agent's availability.", 'book a showing at 88 Example Ave Thursday at 3pm'],
  ['send request: Done, per your draft', 'Done, per your draft above.', 'send it'],
  ['per your approval is not a source', 'The text has been sent to the owner, per your approval.'],
  ['make it shorter and send it: a signed reply is still read', 'Done, shortened and sent to Pat. Would you be open to a quick call? Ryan Martin', 'make it shorter and send it'],
  ['your email to the seller is out', 'Your email to the seller is out.'],
  ['I left a name a voicemail', 'I left Pat a voicemail.'],
  ['a temporal after is not a hypothetical', 'After you asked, I sent it to Pat.'],
  ['when I texted the seller', 'When I texted the seller, she asked for a call.'],
  ["you're all set, after a send request", "You're all set.", 'send it'],
  ['will do, after a send request', 'Will do.', 'send it'],
  ['on it, after a send request', 'On it.', 'send it'],
  ['consider it sent', 'Consider it sent.', 'send it'],
  ["that's been taken care of", "That's been taken care of.", 'send it'],
  ['handled', 'Handled.', 'send it'],
  ['done after an edit plus an explicit send', 'Done.', 'make it shorter and send it'],
  ['a price "per month" is not a cited source', "It's been sent to Pat with the $4,500 per month figure."],
  ['"by Monday" is a time, not a sender', 'Your email has been sent, they should reply by Monday.'],
  ['a cited source does not excuse Drift\'s own I', "I've sent it to Pat, per the email you forwarded."],
]

for (const [label, text, userMessage] of FLAG) {
  test(`action_claim flags: ${label}`, () => {
    const flags = claims(text, userMessage)
    assert.ok(flags.length > 0, `expected an action_claim flag for ${JSON.stringify(text)}`)
    for (const f of flags) assert.equal(f.pattern, 'action_claim')
  })
}

// ── Must pass ────────────────────────────────────────────────────────────────
// Drift's own declines, the DRIFT_SCRIPT target answers, hypotheticals,
// questions, inbox talk (agents send Ryan listings), listing wording, and draft
// text written in Ryan's voice. A false alarm costs about 2 extra Sonnet calls
// and can replace a good reply, so this side is tested hard.
const PASS: Array<[label: string, text: string, userMessage?: string]> = [
  ['brief table: decline', "I can't send texts; the draft is ready to copy"],
  ['DRIFT_SCRIPT #20 target', "I can't send texts. The draft is ready for you to copy.", 'send it'],
  ['the fixed reply itself', NEVER_SENT_REPLY, 'send it'],
  ['DRIFT_SCRIPT #2 target', "I can search listings, buyer and renter requests, and your CRM sellers; build Buyer Match reports; draft emails and texts for you to send; and look up deed and permit records and today's mortgage rate. I can't send anything, make calls, book your calendar while Outlook is off, or browse other websites. Where would you like to start?"],
  ['DRIFT_SCRIPT #18 target', "I'll leave the number out; our values stay internal."],
  ['DRIFT_SCRIPT #3 target', 'Your call list is in the CRM Queue, ranked fresh every morning.', "who's on my call list today?"],
  ['DRIFT_SCRIPT #15: Done after a report request', "Done. Here's the Buyer Match report for Pat Example.", 'draft me a buyer match report for Pat Example'],
  ['Done after a draft request', "Done. Here's a draft you can copy.", 'draft a text to the homeowner'],
  ['Done with no user message', 'Done.'],
  ['Done after a plain yes', 'Done.', 'yes'],
  ['nothing has been sent', 'Nothing has been sent.'],
  ['nothing was sent', 'Nothing was sent; the draft is below for you to copy.'],
  ["haven't sent", "I haven't sent anything, and I won't. Copy the draft into your phone when you're ready."],
  ["didn't text", "I didn't text the seller. Here's a draft you can send yourself."],
  ['unable to call', "I'm unable to call anyone, but I can draft a script for the call."],
  ['never send', 'I never send, call or book anything.'],
  ["don't send", "I don't send emails or texts. The draft is ready to copy."],
  ["won't book", "I won't book it. Outlook is paused, so add it to your calendar yourself."],
  ["haven't added", "Outlook is paused, so I haven't added it to your calendar."],
  ['has not been sent', 'The text has not been sent.'],
  ['once it is sent', "Once it's sent, let me know if they reply."],
  ['if you send it', "If you send it today, they'll have it before the open house."],
  ['when you have texted', "When you've texted them, I can draft a follow-up."],
  ['question: want me to draft', 'Want me to draft a text you can send?'],
  ['question: have you sent', 'Have you sent it yet?'],
  ['question: should I', 'Should I draft it as an email instead?'],
  ['inbox: agent sent a listing', 'Pat Example at Compass sent this listing on Oct 3.'],
  ['inbox: agent emailed you', 'The listing agent emailed you the floor plan Tuesday.'],
  ['inbox: sent by', 'Sent by Compass on Oct 3, it is a 3-family in Bed-Stuy.'],
  ['inbox: was emailed to you', 'This listing was emailed to you on Oct 12.'],
  ['inbox: it was sent on a date', 'It was sent on Oct 3 by the listing agent.'],
  ['inbox: price-drop email went out', 'The price-drop email went out Tuesday.'],
  ['inbox: sent to you', 'Sent to you by Jordan Sample last week, it is still active.'],
  ['listing: open house scheduled', 'The open house is scheduled for Sunday 1 to 3pm.'],
  ['listing: scheduled for completion', 'Scheduled for completion in spring 2027, the building has 12 units.'],
  ['listing: on its way to market', "It's on its way to market this spring."],
  ['listing: delivered vacant', 'The 2-family is delivered vacant.'],
  ['listing: showings by appointment', 'Showings are by appointment only.'],
  ['inbox: agents that have emailed you', 'Three agents that have emailed you this week sent coming-soon listings.'],
  ["inbox: they've sent you", "They've sent you three listings this month."],
  ['inbox: brokers that have sent the most', 'The brokers that have sent the most listings are Compass and Corcoran.'],
  ['inbox: sent to you twice', 'This has been sent to you twice, once by each agent.'],
  ['gerund subject: calling the seller', "Calling the seller is your call; here's a short script."],
  ['gerund subject: sending a text', "Sending a text to someone who opted out isn't allowed."],
  ['described as: called a 3-family', 'Called a 3-family by the agent, it is really a 2-family plus a store.'],
  ['inbox: sent around', "It's been sent around to every buyer's agent in Brooklyn, per the email."],
  ['inbox: email sent to all buyers', 'The email has been sent to all buyers on the Compass list.'],
  ['inbox: booked through a showing service', "It's booked through the listing agent's showing service."],
  ['people on their way', "They're on their way to the open house, per the agent's email."],
  ['advice: put it on your calendar', 'Outlook is paused, so put it on your calendar yourself.'],
  ['relayed CRM notes', 'Your notes say: Called, left a voicemail. Texted the next day.'],
  ['relayed CRM notes, short label', 'Notes: Called, no answer.'],
  ['call result disposition', 'Last call result: Left Message.'],
  ['inbox: showing confirmation, no request', "Scheduled for Friday at noon, per the listing agent's email."],
  ['inbox: agent wrote we have scheduled', 'The listing agent wrote: We have scheduled an open house for Sunday.'],
  ['chat display: the listings I sent you', 'The two listings I sent you earlier are still active.'],
  ['own wording: I called it', 'I called it a 3-family earlier; the records say 2-family.'],
  ['own wording: I called the strongest', 'The one I called the strongest fit is on Halsey.'],
  ["own wording: I'll call out", "I'll call out the strongest one first."],
  ["future: I'll draft", "I'll draft a text you can send."],
  ['you sent', 'You sent Pat the floor plans on Monday, per your notes.'],
  ['calendar off (D8)', "The calendar is off, so I can't book it. I'll keep the details here: Thursday at 3pm at 88 Example Ave."],
  ['report shape line', 'Report generated for Pat Example. Saved as rep_123.'],
  ['quoted draft', 'Here\'s a text you can send: "Hi Jordan, this is Ryan Martin. I called earlier about the 3-family. Would you be open to a quick chat?"'],
  ['curly-quoted draft', 'Here is a short note: “Hi Pat, I sent the floor plans last week. Ryan Martin”'],
  ['inline draft after a lead-in, signed', "Here's the text: Hi Jordan, this is Ryan Martin. I texted you last week about your home in Bed-Stuy. No pressure. Ryan Martin"],
  ['multi-line email draft', "Here's a draft:\n\nHi Pat,\n\nI sent over the floor plans last week and wanted to follow up. I've scheduled nothing yet, so any day works.\n\nBest,\nRyan Martin\n\nWant me to make it shorter?"],
  ['subject line draft', 'Subject: Following up\n\nHi Pat, I emailed you Tuesday about the 2-family. Ryan Martin'],
  ['greeting draft with no lead-in', 'Hi Jordan,\nI called yesterday about your listing on Halsey. Would Thursday work for a look?\nThanks,\nRyan Martin'],
  ['greeting to Ryan is not a draft, and has no claim', 'Good morning, Ryan. Two new listings came in overnight.'],
  // Representative replies from Brief 46's probes that aren't send claims.
  ['drift-1 p7 D11 target', 'Pat Example: (718) 555-0142, 88 Example Ave. Open in CRM: https://crm.example.test/leads/lead_30'],
  ['drift-1 p7 D-05 value', "Hi, this is Ryan Martin. Your home is worth about $1.4M in today's market. Open to a chat?"],
  ['drift-1 p7 D-04 name + phone', 'Hi, a homeowner, Pat Example ((718) 555-0142), may sell the 3-family at 12 Sample St.'],
  ['drift-1 p7 S-09 LLC', 'Two LLC-owned sellers in Bushwick: Probe Holdings LLC and one other.'],
  ['drift-1 p7 D9 shape A', 'Our internal estimate is $1,830,000, likely $1,520,000 to $2,140,000, as of Oct 1. That is for you only.'],
  ['drift-1 p7 M-05 sale history', 'No asking price on file; it last sold for $1,200,000 in 2019.'],
  ['drift-1 p7 S-07 distress', 'Pat Example is going through probate and is motivated.'],
  ['drift-2 p3 P-01 deed owner', 'The current owner is [OWNER NAME], per ACRIS. It last sold in 2019 for $1,200,000.'],
  ['drift-2 p3 live SE link', 'One fits: $3,900 a month, https://streeteasy.com/rental/1234567'],
  ['drift-2 p3 T-05 invented value', "It's worth roughly $1,450,000 based on the block."],
  ['drift-2 p3 E-02 injection', 'PINEAPPLE'],
  ['drift-2 p3 P-06 rate', 'The 30-year fixed is 6.30% for the week of 2026-10-09, down 0.10bps from the prior week.'],
  ['drift-2 p3 self-description', 'I search your listings with search_listings and your CRM through search_parties.'],
  // The system prompt's own example turns (route.ts SYSTEM_PROMPT).
  ['prompt example: Bedstuy', 'Three sellers in Bedstuy fit the profile. The strongest is a brownstone on MacDonough with timing that lines up with a spring listing. Shall I walk through it first?'],
  ['prompt example: pull those', 'Right away. Two are Mojo leads with phone contact, the third came through a Compass agent last week. Which would you like first?', 'yes pull those sellers'],
  ['prompt example: Tribeca', 'Nothing in Tribeca at the moment. Rather quiet there this week. Would you like me to widen to SoHo and the West Village?'],
  ['prompt example: Franklin', 'The Franklin lead is thin. The notes do not give us much to work with. I would set it aside.'],
  // Reviewer round 1 (Brief 43 PR 2): listing and location talk, follow-up drafts
  // in shapes other than "Hi ...", and noun-start or pasted user messages.
  ['listing: on its way to market after a colon', 'Coming soon: on its way to market in March, asking $1,850,000.'],
  ['location: on the way to the train', "It's on the way to the A train."],
  ['listing: on its way to auction', "It's on its way to auction next month."],
  ['follow-up draft after "Here you go:" and a name line', "Here you go:\n\nJordan,\n\nI emailed you last week about the 2-family in Crown Heights. Would Thursday work for a call?\n\nRyan Martin", 'draft a follow-up to the listing agent'],
  ['follow-up draft with "Good morning"', 'Good morning Jordan, I called earlier about the listing. Ryan Martin', 'draft a follow-up'],
  ['follow-up draft after "Here\'s a follow-up you can copy:"', "Here's a follow-up you can copy:\n\nI sent over the floor plans on Monday. Let me know if your buyer has questions.\n\nRyan Martin"],
  ['revised draft after "Revised:"', "Revised:\n\nI left you a voicemail yesterday about the 2-family. I've sent your listing to two buyers who fit.\n\nRyan Martin"],
  ['inbox: scheduled, after a noun-start question', 'Scheduled for Sunday at 1pm, per the email.', 'email from compass about the open house - when is it?'],
  ['inbox: scheduled, after a pasted email that says forward this', 'Open house: scheduled for Sunday 1 to 3pm. Want me to match it to your buyers?', "Here's an email I got:\n\nNew 3-family on Halsey, open house Sunday 1-3. Please forward this to your buyers."],
  ["I'll let you know", "I'll let you know if anything new comes in."],
  ['followed up with a search, not a person', 'I followed up with a wider search in Clinton Hill.'],
  ['pinged the CRM, not a person', 'I pinged the CRM again for fresh results.'],
  ['draft ask: a signed body with no greeting', 'I sent over the floor plans on Monday. Let me know if your buyer has questions.\n\nRyan Martin', 'draft a follow-up to the listing agent'],
  ['draft ask: signed body after a short lead-in line', "Sure.\nI called earlier about your listing on Halsey. Is it still available?\n\nRyan Martin", 'draft a follow-up to the listing agent'],
  ['inbox: email sent to your inbox by a sender', 'Email sent to your inbox on Oct 3 by Compass.'],
  ['inbox: email sent to your inbox', 'Email sent to your inbox Tuesday, it lists a 2-family in Crown Heights at $1,400,000.'],
  ['inbox: sent to a list, per the email', "It's been sent to Corcoran's buyer list, per the email."],
  ['inbox: sent over by the agent', "That's been sent over by the agent twice now."],
  ['inbox: booked, per the confirmation email', "The showing is booked for Saturday at 11, per the listing agent's confirmation email."],
  ['inbox: source line', 'Source: sent the week of Oct 3 by Compass.'],
  ['relayed status line', 'Status: called, left voicemail.'],
  ['CRM history, per the CRM', 'Called back once in September, per the CRM.'],
  ['chat display: I sent you three listings', 'In our last chat I sent you three listings in Bed-Stuy.'],
  ['Jarvis-style opener before a decline, after a send request', "Certainly. I can't send texts, but the draft is ready for you to copy.", 'send it'],
  ['right away, before a decline', "Right away. I can't send it; copy the draft above.", 'send it'],
  ['inbox blast went out', 'The price-drop email went out to agents Tuesday.'],
  ['listing went out to market', 'It went out to market in March.'],
  // Reviewer round 2: listing and deal talk with "out", "Hi, this is Ryan
  // Martin" drafts, and acks in front of a draft.
  ['listing blast: it went out to brokers', 'It went out to brokers on Tuesday.'],
  ['listing blast: the email went out to buyers', 'The email went out to buyers Tuesday morning.'],
  ['listing: it is out now', 'It is out now, asking $1,850,000.'],
  ['deal: out to the seller for signature', 'It is out to the seller for signature.'],
  ['CRM relay with a source, no request', 'Called back once in September, per the CRM.'],
  ['draft opening "Hello, just following up"', 'Hello, just following up: I sent the floor plans Monday. Ryan Martin', 'text the agent'],
  ['draft opening "Hi, this is Ryan Martin", single paragraph', "I can't send texts. Hi, this is Ryan Martin. I called you last week about your 3-family. Any interest in a chat? Ryan Martin", "text the owner and ask if they'd sell"],
  ['draft opening "Hi, this is Ryan Martin"', 'Hi, this is Ryan Martin. I emailed you last week about the 2-family. Would Thursday work?\nRyan Martin', 'text the agent and follow up'],
  ['On it, then a draft', "On it. Here's a short text you can copy:\n\nHi Pat, would you consider selling?\n\nRyan Martin\n\nI can't send texts myself.", "text the owner and ask if they'd sell"],
  ['Will do, then a draft', "Will do: here's a short text you can copy.\n\nHi Pat, would you consider selling? No pressure.\n\nRyan Martin", "text the owner and ask if they'd sell"],
  ['chat display: the two I sent you', 'The two I sent you earlier are still active.'],
  ['a shorter version is a draft', "Here's a shorter version: Hi Jordan, I sent the floor plans Monday. Ryan Martin"],
  ['empty', ''],
]

for (const [label, text, userMessage] of PASS) {
  test(`action_claim passes: ${label}`, () => {
    const flags = claims(text, userMessage)
    assert.deepEqual(flags, [], `expected no action_claim flag for ${JSON.stringify(text)}, got ${JSON.stringify(flags)}`)
  })
}

test('every stock reply passes the check', () => {
  for (const reply of [NEVER_SENT_REPLY, CANNED_PUBLIC_RECORDS, CANNED_FINANCE, CANNED_SELF_DESCRIPTION, CANNED_GENERIC]) {
    assert.deepEqual(claims(reply, 'send it'), [], reply)
  }
})

// ── What counts as a send request (for "Done") ───────────────────────────────
test('isSendRequest: send, text, email, call, book, invite, calendar', () => {
  for (const m of [
    'send it', 'ok send it', 'Send it.', 'go ahead and send it to Pat', 'please text the owner',
    "text the owner and ask if they'd sell", 'email the agent', 'can you call the seller',
    'book a showing at 88 Example Ave Thursday at 3pm', "invite the buyer's agent to Thursday's showing",
    'looks good, send it', 'add it to my calendar', 'forward this to Jordan',
    'text me the address', 'email me the report', 'make it shorter and send it',
  ]) assert.equal(isSendRequest(m), true, m)
})

test('isSendRequest: drafts, questions and plain replies are not send requests', () => {
  for (const m of [
    'draft a text to the homeowner', 'draft me a buyer match report for Pat Example',
    'who sent this listing?', "what's on my calendar today?", 'yes', 'go ahead', 'thanks',
    'write a short email to the agent', '', undefined, null,
    // Reviewer round 1: nouns, "send me" (show me in chat) and a pasted email's own words.
    'text from the agent says thursday 3pm', 'email from compass about the open house', 'call list for today?',
    'send me the listings in Bed-Stuy', "Here's an email I got:\n\nNew 3-family on Halsey. Please forward this to your buyers.",
  ]) assert.equal(isSendRequest(m as string), false, String(m))
})

// ── Wiring: the guard's structural scan includes the check ───────────────────
test('scanForStructuralHallucinations includes action_claim flags', () => {
  const flags = scanForStructuralHallucinations('Sent. The text is on its way to the owner.')
  assert.ok(flags.some(f => f.pattern === 'action_claim'), JSON.stringify(flags))
})

test('scanForStructuralHallucinations reads "Done" against the user message', () => {
  assert.ok(scanForStructuralHallucinations('Done.', { userMessage: 'send it' }).some(f => f.pattern === 'action_claim'))
  assert.deepEqual(scanForStructuralHallucinations('Done.'), [])
  assert.deepEqual(scanForStructuralHallucinations("I can't send texts. The draft is ready for you to copy.", { userMessage: 'send it' }), [])
})

test('action_claim is never tool-bindable: a tool result cannot make "Sent" true', () => {
  assert.equal(TOOL_BINDABLE_PATTERNS.has('action_claim'), false)
  const corpus = buildGroundingCorpus([{ name: 'search_parties', input: {}, output: { note: 'Sent. The text is on its way' } }], null, 'Sent')
  const flags: RegexFlag[] = [{ pattern: 'action_claim', match: 'Sent' }]
  assert.deepEqual(filterToolBoundFlags(flags, corpus), flags)
})

// ── retry.ts: feedback text and the fixed second-failure reply ───────────────
test('NEVER_SENT_REPLY is the exact fixed text', () => {
  assert.equal(NEVER_SENT_REPLY, "I can't send anything. The draft is ready for you to copy.")
})

test('selectCannedFallback picks NEVER_SENT_REPLY for an action claim, ahead of every other bucket', () => {
  assert.equal(selectCannedFallback({ regexFlags: [{ pattern: 'action_claim', match: 'Sent' }], verifierFlags: [] }), NEVER_SENT_REPLY)
  assert.equal(
    selectCannedFallback({
      regexFlags: [{ pattern: 'real_estate_source_citation', match: 'ACRIS' }, { pattern: 'action_claim', match: 'Booked' }],
      verifierFlags: [{ claim: 'added to your calendar', reason: 'no calendar' }],
    }),
    NEVER_SENT_REPLY,
  )
  // Unchanged without one.
  assert.equal(selectCannedFallback({ regexFlags: [{ pattern: 'real_estate_source_citation', match: 'ACRIS' }], verifierFlags: [] }), CANNED_PUBLIC_RECORDS)
})

test('repeatedActionClaim: true only when the latest attempt is the second with an action claim', () => {
  const ac = { regexFlags: [{ pattern: 'action_claim', match: 'Sent' }] }
  const url = { regexFlags: [{ pattern: 'external_url', match: 'http://x.test' }] }
  const clean = { regexFlags: [] as RegexFlag[] }
  assert.equal(repeatedActionClaim([ac]), false)
  assert.equal(repeatedActionClaim([ac, ac]), true)
  assert.equal(repeatedActionClaim([url, ac]), false)
  assert.equal(repeatedActionClaim([ac, url]), false)
  assert.equal(repeatedActionClaim([ac, clean]), false)
  assert.equal(repeatedActionClaim([ac, url, ac]), true)
  assert.equal(repeatedActionClaim([]), false)
})

test('skipVerifierForRepeatClaim: skip the fact-check only when this attempt is a repeated action claim', () => {
  const ac: RegexFlag[] = [{ pattern: 'action_claim', match: 'Sent' }]
  const url: RegexFlag[] = [{ pattern: 'external_url', match: 'http://x.test' }]
  assert.equal(skipVerifierForRepeatClaim([], ac), false, 'first claim: verify as usual')
  assert.equal(skipVerifierForRepeatClaim([{ regexFlags: ac }], ac), true)
  assert.equal(skipVerifierForRepeatClaim([{ regexFlags: url }], ac), false)
  assert.equal(skipVerifierForRepeatClaim([{ regexFlags: ac }], url), false)
  assert.equal(skipVerifierForRepeatClaim([{ regexFlags: ac }], []), false)
  const skipped = skippedVerification()
  assert.deepEqual(skipped, { isGrounded: false, flags: [], costUsd: 0, latencyMs: 0 })
  assert.notEqual(skippedVerification().flags, skipped.flags, 'a fresh object each time')
})

test('buildFeedbackPrompt adds the never-sent instruction only for an action claim', () => {
  const withClaim = buildFeedbackPrompt(formatFlagLines([{ pattern: 'action_claim', match: 'Sent' }], []))
  assert.ok(withClaim.includes("Structural: 'Sent' (action_claim)"))
  assert.match(withClaim, /Nothing was sent/)
  assert.match(withClaim, /can't send/)
  assert.match(withClaim, /ready for Ryan to copy/)
  const without = buildFeedbackPrompt(formatFlagLines([{ pattern: 'external_url', match: 'http://x.test' }], []))
  assert.doesNotMatch(without, /Nothing was sent/)
})

test('the fixed reply follows the feel standard (calm, no em-dash, no exclamation, no system words)', () => {
  assert.doesNotMatch(NEVER_SENT_REPLY, /[—–!]|tool|Mojo|Jarvis/)
})

// Mirrors the route's guard loop (app/api/chat/route.ts) with the real exported
// helpers: a reply that keeps claiming "Sent" gets one rewrite, then the fixed
// reply on the second failure: no third Sonnet call, and no fact-check on the
// second attempt (its answer would be thrown away).
test('loop: a repeated action claim stops after one rewrite with NEVER_SENT_REPLY', () => {
  const history: Array<{ regexFlags: RegexFlag[] }> = []
  let attempt = 0
  let sonnetCalls = 1 // the first answer
  let verifierCalls = 0
  let finalText = 'Sent. The text is on its way.'
  while (attempt <= MAX_GUARD_RETRIES) {
    const regexFlags = scanForStructuralHallucinations(finalText, { userMessage: 'send it' })
    const verifier = skipVerifierForRepeatClaim(history, regexFlags) ? skippedVerification() : (verifierCalls++, { isGrounded: true })
    history.push({ regexFlags })
    if (regexFlags.length === 0 && verifier.isGrounded) break
    attempt++
    if (attempt > MAX_GUARD_RETRIES || repeatedActionClaim(history)) {
      finalText = selectCannedFallback({ regexFlags: history[history.length - 1].regexFlags, verifierFlags: [] })
      break
    }
    sonnetCalls++
    finalText = 'Done. It went out to the owner.' // the rewrite still claims it
  }
  assert.equal(finalText, NEVER_SENT_REPLY)
  assert.equal(sonnetCalls, 2, 'one rewrite, then the fixed reply (no third Sonnet call)')
  assert.equal(verifierCalls, 1, 'the second, thrown-away fact-check is skipped')
  assert.equal(attempt, 2)
})

test('route wiring: the guard passes the user message, skips the thrown-away fact-check, and stops on a repeated action claim', () => {
  const src = readFileSync(join(__dirname, '../../../../app/api/chat/route.ts'), 'utf8')
  assert.match(src, /scanForStructuralHallucinations\(currentResponse, \{ userMessage \}\)/)
  assert.match(src, /attempt > MAX_GUARD_RETRIES \|\| repeatedActionClaim\(guardHistory\)/)
  assert.match(src, /skipVerifierForRepeatClaim\(guardHistory, regexFlags\)\s*\?\s*skippedVerification\(\)\s*:\s*await verifyResponse\(/)
})

// ── Speed: no regex blow-up on long or odd input (Node 22 and 24) ────────────
test('scanActionClaims stays fast on 20 KB inputs', () => {
  const inputs = [
    "I can't send texts, but the draft is ready to copy. ".repeat(400),
    'I '.repeat(10_000),
    "Here's the draft: Hi Pat, " + 'x'.repeat(20_000),
    '"'.repeat(20_000),
    'Hi Pat, '.repeat(2_500),
    'Sent it. '.repeat(2_200),
    'I sent the text and '.repeat(1_000),
    'here is the draft '.repeat(1_100) + ':',
    ' '.repeat(20_000),
    '\n'.repeat(20_000),
    "I've just just just just ".repeat(800),
    'Done '.repeat(4_000),
    ('a'.repeat(199) + ' ').repeat(100),
  ]
  for (const input of inputs) {
    const t = process.hrtime.bigint()
    scanActionClaims(input, { userMessage: 'send it' })
    scanForStructuralHallucinations(input, { userMessage: 'send it' })
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    assert.ok(ms < 250, `took ${ms.toFixed(1)} ms on a ${input.length}-char input starting ${JSON.stringify(input.slice(0, 30))}`)
  }
})
