import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  const total = await prisma.attachment.count()
  const withBytes = await prisma.attachment.count({ where: { contentBytes: { not: null } } })
  const pdfs = await prisma.attachment.count({ where: { mimeType: 'application/pdf' } })
  const pdfsWithBytes = await prisma.attachment.count({
    where: { mimeType: 'application/pdf', contentBytes: { not: null } },
  })

  console.log('Attachment table:')
  console.log(`  total rows:                   ${total}`)
  console.log(`  with contentBytes:            ${withBytes}`)
  console.log(`  pdf rows:                     ${pdfs}`)
  console.log(`  pdf rows with contentBytes:   ${pdfsWithBytes}`)

  const samplePdfs = await prisma.attachment.findMany({
    where:  { mimeType: 'application/pdf', contentBytes: { not: null } },
    select: {
      id: true, name: true, sizeBytes: true,
      rawEmail: { select: { id: true, subject: true, receivedDateTime: true } },
    },
    orderBy: { createdAt: 'desc' },
    take:    15,
  })
  console.log('\nPDF candidates (with bytes), most recent first:')
  for (const a of samplePdfs) {
    const sz = a.sizeBytes ?? 0
    const subj = (a.rawEmail.subject ?? '').slice(0, 70)
    console.log(`  ${a.rawEmail.id}  ${sz.toString().padStart(8)}B  ${a.name.slice(0, 45).padEnd(45)}  ${subj}`)
  }

  const sampleImages = await prisma.attachment.findMany({
    where: {
      mimeType: { startsWith: 'image/' },
      contentBytes: { not: null },
      sizeBytes: { gt: 50_000 },
    },
    select: {
      id: true, name: true, mimeType: true, sizeBytes: true,
      rawEmail: { select: { id: true, subject: true } },
    },
    orderBy: { createdAt: 'desc' },
    take:    10,
  })
  console.log('\nImage attachment candidates (>50KB, with bytes), most recent first:')
  for (const a of sampleImages) {
    const sz = a.sizeBytes ?? 0
    const subj = (a.rawEmail.subject ?? '').slice(0, 70)
    console.log(`  ${a.rawEmail.id}  ${a.mimeType.padEnd(15)}  ${sz.toString().padStart(8)}B  ${a.name.slice(0, 35).padEnd(35)}  ${subj}`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
