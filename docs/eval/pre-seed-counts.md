# Pre-seed / pre-wipe row counts — Brief 2.5, Step 2

Captured immediately before the selective wipe of AI-generated tables.
A full DB snapshot zip was exported to `~/Downloads` as insurance before any DELETE ran.

## Deleted (V1 AI outputs — cheap to regenerate)
| table | pre-wipe count |
|---|---|
| DocumentChunk | 15898 |
| Match | 21640 |
| ExtractedOpportunity | 13163 |

## Preserved (real user data / auth / observation log)
| table | count |
|---|---|
| RawEmail | 3041 |
| ConnectedMailbox | 1 |
| MojoContact | 7410 |
| LinkedResource | 9827 |
| User | 0 |
| Organization | 1 |
| AIExtractionLog | 3410 |
| DriftInteraction | 5 |
| DriftInteractionClick | 4 |
| DriftInteractionFeedback | 1 |

_Not present in this schema (no-op): SyncRun, ExtractedListing, LandlordLead, SellerLead._
_User = 0 (auth is org-scoped via the singleton Organization row)._
