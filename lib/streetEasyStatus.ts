import { prisma } from './prisma'

type ListingStatus = 'active' | 'in_contract' | 'sold' | 'delisted' | 'unknown'

function parseSEStatus(html: string): ListingStatus {
  const lower = html.toLowerCase()
  if (lower.includes('no longer available') || lower.includes('listing is no longer')) return 'delisted'
  if (lower.includes('in contract') || lower.includes('contract signed')) return 'in_contract'
  if (lower.includes('closed') && lower.includes('sale')) return 'sold'
  if (lower.includes('sold')) return 'sold'
  if (lower.includes('for sale') || lower.includes('for rent') || lower.includes('price:')) return 'active'
  return 'unknown'
}

async function checkSEListing(webLink: string): Promise<ListingStatus> {
  try {
    const res = await fetch(webLink, {
      headers: {
        'Cookie': [
          process.env.SE_REMEMBER_USER_TOKEN ? `remember_user_token=${process.env.SE_REMEMBER_USER_TOKEN}` : '',
          process.env.SE_USER_AUTH_TOKEN ? `user_credentials=${process.env.SE_USER_AUTH_TOKEN}` : '',
        ].filter(Boolean).join('; '),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      redirect: 'follow',
    })

    if (res.status === 404) return 'delisted'
    if (!res.ok) return 'unknown'

    const html = await res.text()
    return parseSEStatus(html)
  } catch {
    return 'unknown'
  }
}

export async function checkStreetEasyStatuses(limit = 30): Promise<{ checked: number; updated: number }> {
  // Find opportunities with StreetEasy links, prioritize most recent
  const opps = await prisma.extractedOpportunity.findMany({
    where: {
      isDuplicate: false,
      category: { notIn: ['BUYER_ISO', 'RENTER_INQUIRY', 'SELLER_LEAD', 'LANDLORD_LEAD', 'NOISE', 'MARKET_REPORT', 'REAL_ESTATE_EVENT'] as never[] },
      rawEmail: { webLink: { contains: 'streeteasy.com' } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, status: true, category: true, rawEmail: { select: { webLink: true } } },
  })

  let updated = 0
  for (const opp of opps) {
    const webLink = opp.rawEmail?.webLink
    if (!webLink) continue
    const seStatus = await checkSEListing(webLink)
    if (seStatus === 'unknown') continue

    // Map SE status to our status field
    const newStatus = seStatus === 'delisted' ? 'Delisted'
      : seStatus === 'in_contract' ? 'In Contract'
      : seStatus === 'sold' ? 'Sold'
      : null

    if (newStatus && opp.status !== newStatus) {
      await prisma.extractedOpportunity.update({
        where: { id: opp.id },
        data: { status: newStatus },
      })
      updated++
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200))
  }

  return { checked: opps.length, updated }
}
