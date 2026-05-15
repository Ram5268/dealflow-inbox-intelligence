export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getMessageAttachments } from '@/lib/microsoftGraph'

const TEST_MSG_ID = 'AAMkAGU3MDQ5YTdhLWI1NTMtNDZkYy04YzhjLWU0ZjgzYTIyOWQ0NQBGAAAAAABS046jI4AcSbA3fXQlrN1kBwCsUh721MGIQqicbXlcwL7LAAAAAAEMAACsUh721MGIQqicbXlcwL7LAAIBx1PdAAA='

export async function GET() {
  try {
    const attachments = await getMessageAttachments(TEST_MSG_ID)
    return NextResponse.json({
      count: attachments.length,
      attachments: attachments.map(a => ({
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        hasContentBytes: !!a.contentBytes,
        contentBytesLength: a.contentBytes?.length ?? 0,
      }))
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
