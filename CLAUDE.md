# DealFlow Inbox Intelligence - Claude Development Rules

## Core Mission
Build a private, read-only Outlook inbox intelligence system for real estate deal discovery and matching.

The app reads the user's Microsoft Outlook inbox through Microsoft Graph, classifies real estate-related emails, extracts structured opportunity data, stores it in PostgreSQL, and provides a mobile-first AI search/chat UI.

## Absolute Safety Rules
- Microsoft Graph integration must be read-only in MVP.
- Only use Graph GET requests.
- Never send emails.
- Never delete emails.
- Never archive emails.
- Never move emails.
- Never create calendar events.
- Never modify Microsoft 365 tenant settings.
- Never use POST/PATCH/PUT/DELETE against Microsoft Graph.
- Store audit logs for sync activity.
- Every UI page should make clear this is read-only.

## MVP Scope
Start with only one connected Outlook inbox: Ryan's Douglas Elliman Outlook inbox.
Do not build multi-agent onboarding yet.
Do not build brokerage-sharing yet.
Do not build automated outreach yet.
Do not build email sending yet.

## Categories
- COMING_SOON_SALE
- OFF_MARKET_SALE
- ACTIVE_SALE_LISTING
- RENTAL_LISTING
- BUYER_ISO
- RENTER_INQUIRY
- SELLER_LEAD
- LANDLORD_LEAD
- DEVELOPMENT_INVENTORY
- OPEN_HOUSE
- PRICE_DROP
- BACK_ON_MARKET
- NOISE

## Extraction Rules
Never hallucinate missing real estate data.
If an address, price, neighborhood, unit count, or date is not explicitly present or strongly inferable, use null.
Always include confidenceScore from 0 to 1.
Always include classificationReason.

## Product Positioning
This is not a generic email assistant.
It is a real estate deal intelligence layer.

It should help answer questions like:
- Which coming soon listings match my buyer?
- Which buyer ISOs match my seller?
- Which renter inquiries can I recycle into more deals?
- Which rental leads can help me pitch landlords?
- Which broker blasts from my inbox are actually useful opportunities?

## Preferred Stack
- Next.js 16+
- TypeScript
- Tailwind CSS
- PostgreSQL + Prisma
- Microsoft Graph (GET only)
- AI provider abstraction (OpenAI default, Anthropic optional)
- Mobile-first UI (max-w-lg centered, bottom nav)

## Development Style
- Build incrementally.
- Keep code clean and modular.
- Use clear names.
- Add README instructions for a non-coder.
- Avoid overengineering the MVP.
- Prioritize a working local app over perfect architecture.
- Default AI model: gpt-4o-mini (OpenAI) or claude-haiku (Anthropic) — fast and cheap for classification.
