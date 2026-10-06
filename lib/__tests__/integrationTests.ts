// Brief 41 (H11): the test files that use the database. They are not part of
// `npm test`; `npm run test:integration` runs them, guarded (requireTestDb).
export const INTEGRATION_TESTS: ReadonlyArray<{ file: string; runner: 'tsx' | 'ts-node' }> = [
  { file: 'lib/reports/generators/buyer-match/__tests__/generator.test.ts', runner: 'ts-node' },
  { file: 'lib/chat/tools/__tests__/searchParties.integration.test.ts', runner: 'tsx' },
  { file: 'lib/chat/tools/__tests__/searchListings.test.ts', runner: 'tsx' },
  { file: 'lib/reports/generators/buyer-match/__tests__/contactSupply.test.ts', runner: 'tsx' },
  { file: 'lib/ranking/__tests__/queueBuilder.integration.test.ts', runner: 'tsx' },
]
