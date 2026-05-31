import 'dotenv/config'
import { ensureCollections, COLLECTIONS, VECTOR_DIM, getQdrantClient } from '../lib/vectorstore/qdrant'

async function main() {
  console.log(`Bootstrapping Qdrant collections (${VECTOR_DIM}-dim, Cosine)…\n`)
  await ensureCollections()

  console.log('\nVerifying:')
  const client = getQdrantClient()
  for (const name of Object.values(COLLECTIONS)) {
    const info = await client.getCollection(name)
    console.log(`  ${name.padEnd(20)} points: ${info.points_count ?? 0}  vectors: ${info.vectors_count ?? 0}`)
  }
  console.log('\n✅ Qdrant bootstrap complete.')
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Bootstrap failed:', e); process.exit(1) })
