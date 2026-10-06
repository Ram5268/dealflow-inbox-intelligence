// Brief 41 (H11): imported FIRST by every database-backed test file. Loads .env
// (as those files did) and refuses to go on unless DATABASE_URL is a *_perf /
// *_test database, or the run was started with --i-mean-live
// (`npm run test:integration -- --i-mean-live`). DealFlow's .env DATABASE_URL
// is production, and these tests write rows.
import 'dotenv/config'
import { assertTestDatabase } from '../dbGuard'

assertTestDatabase(process.env.DATABASE_URL, 'a DealFlow integration test (DATABASE_URL)')
