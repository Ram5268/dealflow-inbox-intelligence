import 'dotenv/config'
import { randomUUID } from 'crypto'
import { embedChunk } from '../lib/embeddings/dispatcher'
import { upsertChunk, searchChunks, deleteChunks } from '../lib/vectorstore/qdrant'
import { prisma } from '../lib/prisma'

async function main() {
  console.log('Smoke test: Voyage → Qdrant round-trip\n')

  // Resolve singleton tenant
  const org = await prisma.organization.findUnique({ where: { slug: 'dealflow-ryan' }, select: { id: true } })
  if (!org) throw new Error('Singleton org "dealflow-ryan" not found.')
  const tenantId = org.id
  console.log(`  Tenant: ${tenantId}`)

  // 1. Embed a test sentence via Voyage 3-large
  const testText = 'Two-bedroom condo on the Upper West Side with doorman, $3.2M, in contract.'
  console.log(`  Embedding test text via voyage-3-large…`)
  const embedded = await embedChunk({ chunkType: 'email_body', textContent: testText })
  console.log(`    model:      ${embedded.model}`)
  console.log(`    dim:        ${embedded.vector.length}`)
  console.log(`    collection: ${embedded.collection}`)
  if (embedded.vector.length !== 1024) throw new Error(`Expected 1024-dim vector, got ${embedded.vector.length}`)

  // 2. Upsert to Qdrant
  const pointId = randomUUID()
  console.log(`  Upserting to Qdrant (point id: ${pointId})…`)
  await upsertChunk(embedded.collection, {
    id:     pointId,
    vector: embedded.vector,
    payload: {
      tenant_id:        tenantId,
      chunk_id:         pointId,
      chunk_type:       'email_body',
      embedding_model:  embedded.model,
      embedding_version: embedded.embeddingVersion,
      created_at:       new Date().toISOString(),
    },
  })

  // 3. Search using the same vector — should retrieve our own point with score ~1.0
  console.log(`  Searching Qdrant (tenant-scoped)…`)
  const results = await searchChunks(embedded.collection, {
    vector:   embedded.vector,
    tenantId,
    limit:    5,
  })
  console.log(`    results: ${results.length}`)
  results.forEach(r => console.log(`      ${r.id}  score: ${r.score.toFixed(4)}`))

  const own = results.find(r => String(r.id) === pointId)
  if (!own)            throw new Error('Round-trip failed: did not find our point in search results.')
  if (own.score < 0.99) throw new Error(`Round-trip score too low: ${own.score} (expected >= 0.99).`)
  console.log(`    ✅ Round-trip OK (similarity: ${own.score.toFixed(6)})`)

  // 4. Cleanup
  console.log(`  Deleting test point…`)
  await deleteChunks(embedded.collection, [pointId])

  console.log('\n✅ Smoke test passed. Voyage + Qdrant pipeline is live.')
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ Smoke test failed:', e); process.exit(1) })
