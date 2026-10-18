// Brief 41 (H11): imported FIRST by every database-backed test file. Loads .env
// (as those files did) and refuses to go on unless DATABASE_URL is a *_perf /
// *_test database. DealFlow's .env DATABASE_URL is production, and these tests
// write rows. Brief 41.2 (PR B, engineering precaution): no live override, as
// for the CRM's tests.
import 'dotenv/config'
import { refuseLiveDatabase } from '../dbGuard'

refuseLiveDatabase(process.env.DATABASE_URL, 'a DealFlow integration test (DATABASE_URL)')
