# DealFlow Inbox Intelligence

A private, read-only Outlook inbox intelligence system for real estate deal discovery and matching.

> **Safety**: This app never sends, deletes, moves, or modifies emails. It only reads your inbox using Microsoft Graph GET requests.

---

## What it does

- Reads your Outlook inbox in read-only mode
- Classifies emails into real estate deal categories (coming soon, buyer ISOs, off-market, rentals, etc.)
- Extracts structured data (price, neighborhood, property type, beds/baths, etc.)
- Stores everything in a local database
- Lets you search and match deals using plain-English AI queries like:
  > "I have a buyer looking for a 2-3 family up to $2.2M in Bed-Stuy, Clinton Hill, or Fort Greene"

---

## Prerequisites

You need:
- [Node.js 18+](https://nodejs.org) — download and install
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — for PostgreSQL
- An Outlook/Microsoft 365 account
- An OpenAI API key (or Anthropic API key)

---

## Step 1 — Enter the project folder

```bash
cd dealflow-inbox-intelligence
```

---

## Step 2 — Install dependencies

```bash
npm install
```

---

## Step 3 — Create your .env file

```bash
cp .env.example .env
```

Then open `.env` in a text editor and fill in:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dealflow_inbox"
MICROSOFT_GRAPH_ACCESS_TOKEN=""       <- paste your token here (see Step 5)
OPENAI_API_KEY=""                     <- paste your OpenAI key here
AI_PROVIDER="openai"
SYNC_DAYS_BACK=30
READ_ONLY_MODE=true
```

---

## Step 4 — Start PostgreSQL with Docker

Make sure Docker Desktop is running, then:

```bash
docker compose up -d
```

This starts a local PostgreSQL database.

Verify it is running:
```bash
docker ps
```
You should see `dealflow_postgres` in the list.

---

## Step 5 — Get a Microsoft Graph token

> Token expires in approximately 60 minutes. You will need to refresh it occasionally.

1. Go to https://developer.microsoft.com/en-us/graph/graph-explorer
2. Click Sign in and sign in with your Outlook / Douglas Elliman Microsoft account
3. Click the Access token tab near the top of the page
4. Copy the entire token (it is a very long string)
5. Paste it into your .env file as the value for MICROSOFT_GRAPH_ACCESS_TOKEN

> Note: This is for local testing only. The token is never sent to the frontend.

---

## Step 6 — Run the database migration

```bash
npx prisma migrate dev --name init
```

This creates all the database tables.

---

## Step 7 — Seed demo data (optional but recommended)

```bash
npx prisma db seed
```

This adds 8 sample emails and 7 extracted opportunities so you can explore the UI without connecting to Outlook.

---

## Step 8 — Start the development server

```bash
npm run dev
```

Open your browser to http://localhost:3000

---

## Step 9 — Test your Outlook connection

1. Go to the Settings tab (gear icon at the bottom)
2. Click Test Outlook Connection
3. If successful, you will see your name and email
4. If it fails, your token expired — go back to Step 5

---

## Step 10 — Preview your latest 5 emails

In Settings, click Preview Latest 5 Emails to confirm the app can read your inbox.

This does NOT store anything — it is a quick sanity check.

---

## Step 11 — Run your first sync

Go to the Dashboard tab and click Run Sync Now.

This will:
1. Fetch your most recent emails (up to 50, from the last 30 days)
2. Classify each email using AI
3. Extract structured opportunity data
4. Store relevant deals in the database
5. Log the sync activity

---

## Step 12 — Browse opportunities

Go to the Deals tab to browse extracted opportunities.

Use the filters to narrow by category, borough, neighborhood, price range, or property type.

---

## Step 13 — Use the AI search

Go to the Search tab and type a plain-English query:

"I have a buyer looking for a 2-3 family up to $2.2M in Bed-Stuy, Clinton Hill, Fort Greene, or similar Brooklyn neighborhoods"

Results are ranked by how well they match your query, with explanations.

---

## When the token expires

1. Go back to Graph Explorer
2. Sign in again
3. Copy the new access token
4. Open .env and replace the old token
5. Restart the dev server: stop it with Ctrl+C, then run npm run dev again

---

## Read-Only Safety

| Action | Status |
|--------|--------|
| Read emails (GET) | Allowed |
| Send emails | Never |
| Delete emails | Never |
| Move emails | Never |
| Archive emails | Never |
| Create calendar events | Never |
| Modify Microsoft 365 | Never |

All sync activity is logged in the AuditLog database table.

---

## Troubleshooting

MICROSOFT_GRAPH_ACCESS_TOKEN is not set
  Open .env and paste your token from Graph Explorer.

Microsoft Graph token expired
  Get a new token from Graph Explorer and restart the server.

Cannot connect to database
  Make sure Docker is running: docker compose up -d

Prisma error: table does not exist
  Run migrations: npx prisma migrate dev --name init

The app is blank with no deals
  Run a sync from the Dashboard, or seed demo data: npx prisma db seed

---

## Future Production Notes

For production use, you would need to:
1. Register an app in Azure Active Directory
2. Request the Mail.Read permission (read-only)
3. Implement OAuth 2.0 authorization code flow with refresh tokens
4. Encrypt stored tokens
5. Potentially get admin consent from your Microsoft 365 organization

The current MVP uses a temporary personal token suitable for local development and testing.
