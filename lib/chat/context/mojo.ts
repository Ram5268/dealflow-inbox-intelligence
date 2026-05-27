import type { ContextFetcher } from './types'
import { prisma } from '@/lib/prisma'

// Triggered when there's a neighborhood OR Ryan asked about sellers / his buyer / email campaigns.
// Self-contained: does its own BUYER_ISO query for the cross-match annotation.
export const mojoFetcher: ContextFetcher = async ({ parsed }) => {
  const shouldFetch =
    parsed.neighborhoods.length > 0 ||
    parsed.isSellerLead ||
    parsed.isMyBuyer ||
    parsed.isEmailCampaign
  if (!shouldFetch) return { block: null }

  const mojoContacts = await prisma.mojoContact.findMany({
    where: parsed.neighborhoods.length > 0 ? {
      OR: parsed.neighborhoods.flatMap(n => [
        { neighborhood: { contains: n, mode: 'insensitive' as const } },
        { city:         { contains: n, mode: 'insensitive' as const } },
        { address:      { contains: n, mode: 'insensitive' as const } },
      ])
    } : {},
    orderBy: { syncedAt: 'desc' },
    take: 20,
    include: {
      instantlyEvents: {
        orderBy: { occurredAt: 'desc' },
        take: 1,
        select: { eventType: true, campaignName: true, occurredAt: true },
      },
    },
  })

  if (mojoContacts.length === 0) return { block: null }

  // Cross-match: flag Mojo leads whose neighborhood overlaps with any active BUYER_ISO record.
  const buyerISOsForMatch = await prisma.extractedOpportunity.findMany({
    where:   { category: 'BUYER_ISO', processingStatus: 'active', isDuplicate: false },
    select:  { neighborhood: true },
    take:    50,
    orderBy: { createdAt: 'desc' },
  })
  const mojoMatches = mojoContacts.filter(c =>
    c.neighborhood && buyerISOsForMatch.some(iso =>
      iso.neighborhood && iso.neighborhood.toLowerCase().includes(c.neighborhood!.toLowerCase())
    )
  )

  const block = '\n\nMOJO SELLER LEADS (' + mojoContacts.length + ' contacts from CRM):\n' +
    mojoContacts.map(c => {
      const matched   = mojoMatches.find(m => m.id === c.id)
      const matchFlag = matched ? ' ⚡ MATCHES BUYER ISO' : ''
      const lastEvent = (c as typeof c & { instantlyEvents: { eventType: string; campaignName: string | null; occurredAt: Date }[] }).instantlyEvents?.[0]
      const emailFlag = lastEvent
        ? ` | ✉️ ${lastEvent.eventType.replace(/_/g, ' ')}${lastEvent.campaignName ? ' (' + lastEvent.campaignName + ')' : ''}`
        : ''
      const groupFlag = (c as typeof c & { groups: string[] }).groups?.length
        ? ` | groups: ${(c as typeof c & { groups: string[] }).groups.join(', ')}`
        : ''
      return `[MOJO:${c.id}] ${c.fullName} | ${c.address ?? ''}${c.city ? ', ' + c.city : ''} | ${c.neighborhood ?? ''} | ${c.status ?? ''} | ${c.mojoList ?? ''}${groupFlag} | ph: ${c.phone ?? ''}${c.notes ? ' | notes: ' + c.notes.slice(0, 100) : ''}${emailFlag}${matchFlag}`
    }).join('\n')

  return { block }
}
