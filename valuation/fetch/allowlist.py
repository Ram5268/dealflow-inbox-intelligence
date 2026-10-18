"""The allow-list: the only sources this downloader may fetch, with the exact
columns and filter for each. It mirrors Brief 44.1 section 2, and
tests/test_fetch_brief_table.py pins it to that table.

Where each rule comes from:
- Engineering precaution (data minimization): each dataset's $select is
  exactly its list below. Several of these datasets also carry person-name,
  phone, email and money-owed fields; an allow-list keeps them out without
  having to name them.
- Engineering precaution: whole datasets or whole-borough extracts only, so
  no request is ever about a particular property. Lookups happen later,
  inside the saved files.
- Engineering precaution: official public hosts only (NYC Open Data,
  data.ny.gov for the MTA station list, www.nyc.gov for the 26 DOF files).
- Ryan's decision (2026-10-17): PLUTO owner names stay erased, so PLUTO's
  `ownername` is never requested.
- Ryan's decisions (2026-10-18), after the metadata check:
  - #8 and #11 store `bbl` as a number, so the brief's text range
    (bbl >= '3' AND bbl < '5') matched no rows there. The same range is
    written for a number column.
  - #12 spells the boroughs two ways ('Brooklyn' and 'BROOKLYN'); both are
    kept.

Never downloaded (engineering precautions, except PLUTO `ownername` above):
ACRIS Real Property Parties (636b-3b5g); any ACRIS mortgage, loan,
satisfaction or lien document type (#5's doc_type list keeps them out); ACRIS
References (pwkr-dpni); Tax Lien Sale Lists (9rz4-mjek); 311 (erm2-nwe9,
76ig-c548); Multiple Dwelling Registrations (tesw-yqqr); any person-name,
phone, email or respondent column, including the assessment data's `owner`;
money-owed fields such as ECB `balance_due`, `penality_imposed` and
`amount_paid`; photos of any kind. None of them is on this list, so the
downloader can't ask for them.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit

NYC_OPEN_DATA = "data.cityofnewyork.us"
NY_STATE_OPEN_DATA = "data.ny.gov"
NYC_GOV = "www.nyc.gov"

# Engineering precaution: one 50,000-row page per request, ordered by :id.
PAGE_SIZE = 50_000
ORDER = ":id"


class NotAllowed(ValueError):
    """Raised before any request when something is not on the allow-list."""


@dataclass(frozen=True)
class Dataset:
    number: int  # row number in Brief 44.1 section 2
    id: str
    host: str
    title: str  # as published; confirmed 2026-10-17 via /api/views/<id>.json
    where: str | None  # the exact $where; None means the whole dataset
    columns: tuple[str, ...]
    # Engineering precaution: a run that gets fewer rows than this stops, so
    # a filter the city's data no longer matches can't pass silently. Set at
    # about half of each dataset's Brooklyn + Queens count on 2026-10-17.
    min_rows: int
    # #7 only: the year list is a setting (the newest roll year and the three
    # before it), filled in where the filter says {years}.
    uses_roll_years: bool = False

    @property
    def label(self) -> str:
        return f"#{self.number} {self.title} ({self.id})"

    @property
    def resource_path(self) -> str:
        return f"/resource/{self.id}.json"

    @property
    def metadata_path(self) -> str:
        return f"/api/views/{self.id}.json"

    @property
    def resource_url(self) -> str:
        return f"https://{self.host}{self.resource_path}"

    @property
    def metadata_url(self) -> str:
        return f"https://{self.host}{self.metadata_path}"

    @property
    def out_path(self) -> str:
        return f"raw/{self.id}.parquet"


def _cols(text: str) -> tuple[str, ...]:
    return tuple(c.strip() for c in text.split(","))


_DATASET_LIST = (
    Dataset(
        2, "w2pb-icbu", NYC_OPEN_DATA, "NYC Citywide Annualized Calendar Sales Update",
        "borough in ('3','4')",
        _cols("borough, neighborhood, building_class_category, tax_class_as_of_final_roll, block, lot, "
              "building_class_as_of_final, address, apartment_number, zip_code, residential_units, "
              "commercial_units, total_units, land_square_feet, gross_square_feet, year_built, "
              "tax_class_at_time_of_sale, building_class_at_time_of, sale_price, sale_date, latitude, "
              "longitude, bbl, bin, nta"),
        min_rows=250_000,
    ),
    Dataset(
        3, "usep-8jbt", NYC_OPEN_DATA, "NYC Citywide Rolling Calendar Sales",
        "borough in ('3','4')",
        _cols("borough, neighborhood, building_class_category, tax_class_at_present, block, lot, "
              "building_class_at_present, address, apartment_number, zip_code, residential_units, "
              "commercial_units, total_units, land_square_feet, gross_square_feet, year_built, "
              "tax_class_at_time_of_sale, building_class_at_time_of, sale_price, sale_date"),
        min_rows=24_000,
    ),
    Dataset(
        4, "64uk-42ks", NYC_OPEN_DATA, "Primary Land Use Tax Lot Output (PLUTO)",
        "borough in ('BK','QN')",
        _cols("bbl, borough, block, lot, address, zipcode, latitude, longitude, bldgclass, landuse, bldgarea, "
              "resarea, comarea, unitsres, unitstotal, numbldgs, numfloors, yearbuilt, yearalter1, yearalter2, "
              "lotarea, lotfront, lotdepth, bldgfront, bldgdepth, builtfar, residfar, zonedist1, histdist, "
              "landmark, proxcode, irrlotcode, bsmtcode, ext, condono, version"),
        min_rows=300_000,
    ),
    Dataset(
        5, "bnx9-e6tj", NYC_OPEN_DATA, "ACRIS - Real Property Master",
        "document_id >= '2022070100000000' AND document_id < '2099' AND doc_type in "
        "('DEED','DEEDO','DEEDP','DEED, LE','DEED, RC','DEED, TS','IDED','REIT')",
        _cols("document_id, doc_type, document_date, document_amt, recorded_datetime, recorded_borough, "
              "percent_trans"),
        min_rows=130_000,
    ),
    Dataset(
        6, "8h5j-fqxa", NYC_OPEN_DATA, "ACRIS - Real Property Legals",
        "document_id >= '2022070100000000' AND document_id < '2099' AND borough in (3,4)",
        _cols("document_id, borough, block, lot, property_type, partial_lot"),
        min_rows=510_000,
    ),
    Dataset(
        7, "8y4t-faws", NYC_OPEN_DATA, "Property Valuation and Assessment Data Tax Classes 1,2,3,4",
        "parid >= '3' AND parid < '5' AND year in ({years}) AND period in ('1','3')",
        _cols("parid, year, period, curmkttot, curtaxclass, bldg_class, gross_sqft, units"),
        min_rows=2_900_000,
        uses_roll_years=True,
    ),
    Dataset(
        8, "ipu4-2q9a", NYC_OPEN_DATA, "DOB Permit Issuance",
        "job_type in ('A1','A2','A3') AND bbl >= 3000000000 AND bbl < 5000000000",
        _cols("bbl, job__, job_type, work_type, permit_type, permit_status, filing_status, filing_date, "
              "issuance_date, job_start_date"),
        min_rows=640_000,
    ),
    Dataset(
        9, "ic3t-wcy2", NYC_OPEN_DATA, "DOB Job Application Filings",
        "bbl >= '3' AND bbl < '5'",
        _cols("bbl, job__, doc__, job_type, job_status, job_status_descrp, pre__filing_date, latest_action_date, "
              "approved, fully_permitted, signoff_date, initial_cost, proposed_dwelling_units, "
              "existing_dwelling_units, enlargement_sq_footage, vertical_enlrgmt, horizontal_enlrgmt, "
              "job_description"),
        min_rows=580_000,
    ),
    Dataset(
        10, "w9ak-ipjd", NYC_OPEN_DATA, "DOB NOW: Build – Job Application Filings",
        "bbl >= '3' AND bbl < '5'",
        _cols("bbl, job_filing_number, job_type, filing_status, filing_date, first_permit_date, approved_date, "
              "signoff_date, current_status_date, initial_cost, existing_dwelling_units, proposed_dwelling_units, "
              "plumbing_work_type, general_construction_work_type_, structural_work_type_, "
              "mechanical_systems_work_type_, job_description"),
        min_rows=220_000,
    ),
    Dataset(
        11, "rbx6-tga4", NYC_OPEN_DATA, "DOB NOW: Build – Approved Permits",
        "bbl >= 3000000000 AND bbl < 5000000000",
        _cols("bbl, job_filing_number, work_permit, work_type, filing_reason, issued_date, permit_status, "
              "estimated_job_costs"),
        min_rows=220_000,
    ),
    Dataset(
        12, "dm9a-ab7w", NYC_OPEN_DATA, "DOB NOW: Electrical Permit Applications",
        "borough in ('Brooklyn','Queens','BROOKLYN','QUEENS')",
        _cols("job_filing_number, filing_date, filing_status, job_status, permit_issued_date, completion_date, "
              "borough, block, lot, building_use_type, general_wiring, lighting_work, hvac_wiring, new_meters, "
              "job_description"),
        min_rows=140_000,
    ),
    Dataset(
        13, "3h2n-5cm9", NYC_OPEN_DATA, "DOB Violations",
        "boro in ('3','4')",
        _cols("boro, block, lot, bin, isn_dob_bis_viol, issue_date, violation_category, violation_type, "
              "disposition_date"),
        min_rows=590_000,
    ),
    Dataset(
        14, "6bgk-3dad", NYC_OPEN_DATA, "DOB ECB Violations",
        "boro in ('3','4')",
        _cols("boro, block, lot, bin, ecb_violation_number, ecb_violation_status, issue_date, severity, "
              "violation_type, hearing_status"),
        min_rows=520_000,
    ),
    Dataset(
        15, "wvxf-dwi5", NYC_OPEN_DATA, "Housing Maintenance Code Violations",
        "bbl >= '3' AND bbl < '5'",
        _cols("bbl, violationid, class, inspectiondate, novissueddate, currentstatus, currentstatusdate, "
              "violationstatus, rentimpairing"),
        min_rows=2_800_000,
    ),
    Dataset(
        16, "5zhs-2jue", NYC_OPEN_DATA, "BUILDING",  # the building footprints dataset
        "base_bbl >= '3' AND base_bbl < '5'",
        _cols("bin, base_bbl, mappluto_bbl, shape_area, height_roof, ground_elevation, construction_year, "
              "last_edited_date, last_status_type, feature_code"),
        min_rows=390_000,
    ),
    Dataset(
        17, "muvi-b6kx", NYC_OPEN_DATA, "Property Exemption Detail",
        "exmp_code like '51%' AND parid >= '3' AND parid < '5' AND year >= '2024'",
        _cols("parid, year, period, exmp_code, benftstart, no_years"),
        min_rows=190_000,
    ),
    Dataset(
        18, "39hk-dx4f", NY_STATE_OPEN_DATA, "MTA Subway Stations",
        None,
        _cols("station_id, complex_id, stop_name, borough, daytime_routes, gtfs_latitude, gtfs_longitude"),
        min_rows=240,
    ),
)

# In section 2 order.
DATASETS: dict[str, Dataset] = {d.id: d for d in _DATASET_LIST}


@dataclass(frozen=True)
class StaticFile:
    """One of the 26 DOF annualized-sales Excel files (#1). History, never changes."""

    year: int
    borough: str  # "brooklyn" or "queens"
    path: str  # on www.nyc.gov

    @property
    def name(self) -> str:
        return self.path.rsplit("/", 1)[1]

    @property
    def url(self) -> str:
        return f"https://{NYC_GOV}{self.path}"

    @property
    def out_path(self) -> str:
        return f"raw/dof_annual/{self.name}"

    @property
    def label(self) -> str:
        return f"#1 DOF annualized sales {self.name}"


def _dof_path(year: int, borough: str) -> str:
    base = "/assets/finance/downloads"
    if year <= 2006:
        return f"{base}/sales_{borough}_{year % 100:02d}.xls"
    if year == 2007:
        return f"{base}/excel/rolling_sales/sales_2007_{borough}.xls"
    if year == 2008:
        return f"{base}/pdf/09pdf/rolling_sales/sales_2008_{borough}.xls"
    if year == 2009:
        return f"{base}/pdf/rolling_sales/annualized-sales/2009_{borough}.xls"
    return f"{base}/pdf/rolling_sales/annualized-sales/{year}/{year}_{borough}.xls"


DOF_FILES: tuple[StaticFile, ...] = tuple(
    StaticFile(year, borough, _dof_path(year, borough))
    for year in range(2003, 2016)
    for borough in ("brooklyn", "queens")
)
DOF_ONLY = "dof"  # what --only calls the 26 static files

_DOF_PATHS = frozenset(f.path for f in DOF_FILES)
_DATASET_PATHS = {
    (d.host, path): (d, kind)
    for d in _DATASET_LIST
    for path, kind in ((d.resource_path, "data"), (d.metadata_path, "metadata"))
}


def default_newest_roll_year(today: dt.date) -> int:
    # DOF publishes the tentative roll for fiscal year Y+1 each January, so in
    # calendar year Y the newest roll year is Y+1 (2027 during 2026).
    return today.year + 1


def check_newest_roll_year(newest: int, today: dt.date) -> None:
    if not today.year - 1 <= newest <= today.year + 1:
        raise NotAllowed(
            f"newest roll year {newest} is outside {today.year - 1}-{today.year + 1}; "
            "#7 takes the newest roll year and the three before it"
        )


def roll_years(newest: int) -> tuple[str, ...]:
    return tuple(str(y) for y in range(newest - 3, newest + 1))


def where_for(ds: Dataset, newest_roll_year: int) -> str | None:
    if ds.where is None or not ds.uses_roll_years:
        return ds.where
    return ds.where.replace("{years}", ",".join(f"'{y}'" for y in roll_years(newest_roll_year)))


def check_query(dataset_id: str, columns, where: str | None, newest_roll_year: int) -> Dataset:
    """Refuse, before any request, a dataset, column or filter that isn't on the list."""
    ds = DATASETS.get(dataset_id)
    if ds is None:
        raise NotAllowed(f"{dataset_id}: not a dataset on the allow-list (Brief 44.1 section 2)")
    columns = tuple(columns)
    unknown = [c for c in columns if c not in ds.columns]
    if unknown:
        raise NotAllowed(f"{ds.label}: column(s) not on its allow-list: {', '.join(unknown)}")
    if columns != ds.columns:
        raise NotAllowed(f"{ds.label}: $select must be exactly its allow-listed columns, in order")
    if where != where_for(ds, newest_roll_year):
        raise NotAllowed(f"{ds.label}: $where is not its allow-listed filter")
    return ds


def check_request(url: str, params: Mapping[str, str] | None, newest_roll_year: int) -> None:
    """Refuse any request that isn't an allow-listed address with allow-listed parameters."""
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.query or parts.fragment or parts.port or parts.username:
        raise NotAllowed(f"not an allowed address: {url}")
    params = {k: str(v) for k, v in (params or {}).items()}
    if parts.hostname == NYC_GOV:
        if parts.path not in _DOF_PATHS:
            raise NotAllowed(f"{url}: www.nyc.gov is allowed for the 26 DOF files only")
        if params:
            raise NotAllowed(f"{url}: the DOF files are fetched whole, with no parameters")
        return
    found = _DATASET_PATHS.get((parts.hostname, parts.path))
    if found is None:
        raise NotAllowed(f"{url}: not an allow-listed dataset address")
    ds, kind = found
    if kind == "metadata":
        if params:
            raise NotAllowed(f"{ds.label}: the metadata address takes no parameters")
        return
    allowed_keys = {"$select", "$order", "$limit", "$offset"} | ({"$where"} if ds.where is not None else set())
    if set(params) != allowed_keys:
        raise NotAllowed(f"{ds.label}: parameters must be exactly {', '.join(sorted(allowed_keys))}")
    check_query(ds.id, params["$select"].split(","), params.get("$where"), newest_roll_year)
    if params["$order"] != ORDER:
        raise NotAllowed(f"{ds.label}: pages must be ordered by {ORDER}")
    limit, offset = params["$limit"], params["$offset"]
    if not (limit.isdigit() and 0 < int(limit) <= PAGE_SIZE and offset.isdigit()):
        raise NotAllowed(f"{ds.label}: $limit must be 1-{PAGE_SIZE} and $offset a whole number")
