// Brief 41 (H11): the test files that use the database. They are not part of
// `npm test`; `npm run test:integration` runs them, guarded (requireTestDb).
export const INTEGRATION_TESTS: ReadonlyArray<{ file: string; runner: 'tsx' | 'ts-node' }> = [
  { file: 'lib/reports/generators/buyer-match/__tests__/generator.test.ts', runner: 'ts-node' },
  { file: 'lib/chat/tools/__tests__/searchParties.integration.test.ts', runner: 'tsx' },
  { file: 'lib/chat/tools/__tests__/searchListings.test.ts', runner: 'tsx' },
  { file: 'lib/reports/generators/buyer-match/__tests__/contactSupply.test.ts', runner: 'tsx' },
  { file: 'lib/ranking/__tests__/queueBuilder.integration.test.ts', runner: 'tsx' },
  // Brief 45 (PR E): also needs CRM_TEST_DATABASE_URL (a CRM *_test database).
  { file: 'lib/importScoring/__tests__/scoreImport.integration.test.ts', runner: 'tsx' },
  // Brief 48 (PR 7): the CRM lead copy on Postgres 18; also need CRM_TEST_DATABASE_URL.
  { file: 'lib/crm-sync/__tests__/crmSyncGolden.integration.test.ts', runner: 'tsx' },
  { file: 'lib/crm-sync/__tests__/crmWins.integration.test.ts', runner: 'tsx' },
  { file: 'lib/crm-sync/__tests__/crmWinsRestore.integration.test.ts', runner: 'tsx' },
  { file: 'lib/crm-sync/__tests__/noMojoId.integration.test.ts', runner: 'tsx' }, // Brief 48 (PR 8)
  { file: 'lib/crm-sync/__tests__/sellerDetails.integration.test.ts', runner: 'tsx' }, // Brief 48 (PR 9)
]
