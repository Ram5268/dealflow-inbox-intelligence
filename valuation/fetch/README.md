# valuation/fetch: monthly download of NYC public property data

**In plain English.** Once a month this copies the city's public sales and
property records for Brooklyn and Queens into a folder, as files. A later
step builds the home-value model's tables from those files. It only reads
datasets the city publishes for anyone to reuse. It never asks about a
particular property, and it never fetches names, phone numbers, emails or
amounts owed.

## Run it

From the repo root, with Python 3.12:

```
pip install -r valuation/fetch/requirements.txt
python -m valuation.fetch --out <folder>
```

Optional:
- `NYC_SOCRATA_KEY_ID` and `NYC_SOCRATA_KEY_SECRET` in the environment: NYC
  Open Data requests carry that key pair as HTTP Basic auth. Without them the
  requests are anonymous.
- `--newest-roll-year YYYY`: the newest assessment roll year for #7. The
  default is next calendar year (2027 during 2026), because the city
  publishes the next year's roll each January. #7 takes that year and the
  three before it.
- `--only ID ...`: download only these datasets (`dof` means the 26 DOF
  files). Anything not on the allow-list is refused before any request.

Exit codes: `0` done; `1` a request failed, so the run stopped and the
manifest records why; `2` refused before any request.

## What it writes

```
<folder>/raw/<id>.parquet         one per Open Data dataset (17 files)
<folder>/raw/dof_annual/*.xls     the 26 DOF annualized-sales files, 2003-2015
<folder>/manifest.json            what each file is
```

- **Parquet files:** every column is text, exactly as the city's API sent it,
  and missing values stay empty. The later step does the typing; each
  manifest entry's `column_types` gives the city's type for every column.
- **Manifest entries:** each one has the source address, the filter, the
  column list, the row count, the download time and the SHA-256. The DOF
  files are saved whole, so their entries have no column list or row count.
- **Run record:** `run.status` is `complete` only when everything finished.
  The manifest is rewritten after each file, so it always describes what is
  on disk.

## Sources

| # | Dataset | Id | Filter |
|---|---|---|---|
| 1 | DOF annualized sales, 2003-2015 | 26 files on www.nyc.gov | whole files |
| 2 | NYC Citywide Annualized Calendar Sales Update | `w2pb-icbu` | `borough in ('3','4')` |
| 3 | NYC Citywide Rolling Calendar Sales | `usep-8jbt` | `borough in ('3','4')` |
| 4 | PLUTO | `64uk-42ks` | `borough in ('BK','QN')` |
| 5 | ACRIS Real Property Master, deeds only | `bnx9-e6tj` | from July 2022, 8 deed types |
| 6 | ACRIS Real Property Legals | `8h5j-fqxa` | from July 2022, `borough in (3,4)` |
| 7 | Property Valuation and Assessment Data | `8y4t-faws` | Brooklyn + Queens, 4 roll years, tentative and final |
| 8 | DOB Permit Issuance | `ipu4-2q9a` | alterations A1-A3, Brooklyn + Queens |
| 9 | DOB Job Application Filings | `ic3t-wcy2` | Brooklyn + Queens |
| 10 | DOB NOW: Build – Job Application Filings | `w9ak-ipjd` | Brooklyn + Queens |
| 11 | DOB NOW: Build – Approved Permits | `rbx6-tga4` | Brooklyn + Queens |
| 12 | DOB NOW: Electrical Permit Applications | `dm9a-ab7w` | Brooklyn + Queens, both spellings |
| 13 | DOB Violations | `3h2n-5cm9` | `boro in ('3','4')` |
| 14 | DOB ECB Violations | `6bgk-3dad` | `boro in ('3','4')` |
| 15 | HPD Housing Maintenance Code Violations | `wvxf-dwi5` | Brooklyn + Queens |
| 16 | Building Footprints | `5zhs-2jue` | Brooklyn + Queens, no geometry |
| 17 | Property Exemption Detail | `muvi-b6kx` | codes 51xx, from roll year 2024 |
| 18 | MTA Subway Stations (data.ny.gov) | `39hk-dx4f` | whole list |

The exact columns and filters are in `allowlist.py`.

## Running it monthly

Give the scheduled job a 4-hour timeout (Brief 44.1 Revision 1), and the
NYC Open Data key pair as the secrets `NYC_SOCRATA_KEY_ID` and
`NYC_SOCRATA_KEY_SECRET`. The 26 DOF files can be cached between runs:
with the previous `manifest.json`, unchanged ones are skipped.

## Rules, and where each comes from

- **Engineering precaution:** whole datasets or whole-borough extracts only.
  No request is about a particular property; all lookups happen later,
  inside the saved files.
- **Engineering precaution:** one request at a time, in order. No threads
  and no parallel requests.
- **Engineering precaution (Brief 44.1 Revision 1, 2026-10-18), keyset
  paging:** pages of 50,000 rows ordered by `:id`. After the first page,
  each request adds `:id > '<last :id>'` to the dataset's own filter, so
  every page is equally quick for the city's server. `$offset` paging
  made deep pages slow until the city's server cut them off. `:id` is
  requested for paging only and never saved.
- **Run order (Revision 1):** section 2 order, except HPD (#15) last, so
  the biggest dataset can't hold up the others.
- **Engineering precaution:** no retry or back-off code. A failed request
  stops the run with an error naming the dataset and the HTTP status. The
  monthly schedule has a backup run three days later.
- **Engineering precaution:** identify honestly. Requests carry a plain
  User-Agent, `dealflow-valuation-fetch (monthly, read-only)`, and, if set,
  the key pair as HTTP Basic auth on NYC Open Data only. No browser
  impersonation, proxies or rotating addresses.
- **Engineering precaution:** official public hosts only:
  `data.cityofnewyork.us`, `data.ny.gov` (the MTA station list only) and
  `www.nyc.gov` (the 26 DOF files only). Redirects aren't followed.
- **Engineering precaution (data minimization):** an allow-list, not a
  deny-list. Each dataset's `$select` is exactly its list in `allowlist.py`,
  and any other dataset, column or filter is refused before any request.
- **Ryan's decision (2026-10-17):** PLUTO owner names stay erased, so
  `ownername` is never requested.
- **Ryan's decisions (2026-10-18):** #8 and #11 store `bbl` as a number, so
  their Brooklyn + Queens range is written for a number. #12 keeps both
  spellings of the borough names.
- **Engineering precaution:** the DOF files are history. Each one is
  downloaded only if it's missing or its SHA-256 differs from the manifest.
- **Engineering precaution:** a run stops if:
  - a dataset changed while it was being paged;
  - a dataset came back with fewer than about half its rows on 2026-10-17;
  - a row had a column outside the allow-list.

  Files are written under a `.partial` name and renamed only when complete.
- **Never downloaded** (engineering precautions, except PLUTO `ownername`
  above):
  - ACRIS Real Property Parties (`636b-3b5g`);
  - any ACRIS mortgage, loan, satisfaction or lien document;
  - ACRIS References (`pwkr-dpni`);
  - Tax Lien Sale Lists (`9rz4-mjek`);
  - 311 (`erm2-nwe9`, `76ig-c548`);
  - Multiple Dwelling Registrations (`tesw-yqqr`);
  - any person-name, phone, email or respondent column;
  - money-owed fields;
  - photos.

## Tests

```
python -m pytest valuation/fetch/tests
```

The tests never touch the network: sockets are blocked, and every answer is
a tiny recorded response with made-up values. CI runs them in
`.github/workflows/valuation-fetch-tests.yml` whenever `valuation/fetch/`
changes.
