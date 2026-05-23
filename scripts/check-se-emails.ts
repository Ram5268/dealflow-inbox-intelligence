import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  const email = await prisma.rawEmail.findFirst({
    where: { subject: { contains: 'New Sales', mode: 'insensitive' }, senderEmail: { contains: 'streeteasy', mode: 'insensitive' } },
    select: { rawJson: true },
    orderBy: { receivedDateTime: 'desc' },
  })
  const html = (email?.rawJson as any)?.body?.content ?? ''

  const linkBlocks = [...html.matchAll(/([^<]{0,100})<a[^>]*href="(https:\/\/url\.us\.m\.mimecastprotect[^"]+)"[^>]*>([^<]*)<\/a>([^<]{0,100})/gi)]
  
  console.log('All links:')
  linkBlocks.forEach((m: any) => {
    console.log(`  "${m[3].trim()}" | ${m[2].slice(0, 90)}`)
  })
  await prisma.$disconnect()
}
main()
