// Runs the hotsheet backfill on the server so it uses the server's DB connection.
// POST /api/admin/backfill-hotsheets
// Body: { days: 90, secret: "..." }
export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { runHotsheetSync } from '@/lib/streetEasyHotsheet'
import { maintenanceEnabled, MAINTENANCE_OFF_BODY, adminSecretOk } from '@/lib/config/maintenance'

// Maintenance route (Brief 41, H6): off unless MAINTENANCE_ENABLED=true.
export async function POST(req: NextRequest) {
  if (!maintenanceEnabled()) return NextResponse.json(MAINTENANCE_OFF_BODY, { status: 403 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  // Secret guard so this can't be called publicly. Brief 41: fails closed (with
  // ADMIN_SECRET unset it used to let every request through).
  if (!adminSecretOk(body.secret, process.env.ADMIN_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const days     = Math.min(Number(body.days ?? 30), 90)
  const today    = new Date()
  const dates: string[] = []

  for (let i = days; i >= 1; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    dates.push(d.toISOString().slice(0, 10))
  }

  let totalSales = 0, totalRentals = 0, failed = 0

  for (const date of dates) {
    try {
      const result = await runHotsheetSync(date)
      totalSales   += result.sales
      totalRentals += result.rentals
      console.log(`[Backfill] ${date} — ${result.sales} sales, ${result.rentals} rentals`)
    } catch (err) {
      failed++
      console.error(`[Backfill] Failed ${date}:`, err)
    }
  }

  return NextResponse.json({ ok: true, days, totalSales, totalRentals, failed })
}
