"""Pins allowlist.py to Brief 44.1 section 2.

SECTION_2 holds the first four cells of each Open Data row of that table,
copied exactly. Three filters differ from it on purpose (CHANGED_FILTERS):
Ryan's decisions of 2026-10-18, after the metadata check showed #8 and #11
store bbl as a number and #12 spells the boroughs two ways.
"""
import datetime as dt
import re

import pytest

from valuation.fetch import allowlist

SECTION_2 = """
| 2 | NYC Citywide Annualized Calendar Sales Update (`w2pb-icbu`) | `borough in ('3','4')` | `borough, neighborhood, building_class_category, tax_class_as_of_final_roll, block, lot, building_class_as_of_final, address, apartment_number, zip_code, residential_units, commercial_units, total_units, land_square_feet, gross_square_feet, year_built, tax_class_at_time_of_sale, building_class_at_time_of, sale_price, sale_date, latitude, longitude, bbl, bin, nta` |
| 3 | NYC Citywide Rolling Calendar Sales (`usep-8jbt`) | `borough in ('3','4')` | `borough, neighborhood, building_class_category, tax_class_at_present, block, lot, building_class_at_present, address, apartment_number, zip_code, residential_units, commercial_units, total_units, land_square_feet, gross_square_feet, year_built, tax_class_at_time_of_sale, building_class_at_time_of, sale_price, sale_date` |
| 4 | PLUTO (`64uk-42ks`) | `borough in ('BK','QN')` | `bbl, borough, block, lot, address, zipcode, latitude, longitude, bldgclass, landuse, bldgarea, resarea, comarea, unitsres, unitstotal, numbldgs, numfloors, yearbuilt, yearalter1, yearalter2, lotarea, lotfront, lotdepth, bldgfront, bldgdepth, builtfar, residfar, zonedist1, histdist, landmark, proxcode, irrlotcode, bsmtcode, ext, condono, version` |
| 5 | ACRIS Real Property Master (`bnx9-e6tj`), deeds only | `document_id >= '2022070100000000' AND document_id < '2099' AND doc_type in ('DEED','DEEDO','DEEDP','DEED, LE','DEED, RC','DEED, TS','IDED','REIT')` | `document_id, doc_type, document_date, document_amt, recorded_datetime, recorded_borough, percent_trans` |
| 6 | ACRIS Real Property Legals (`8h5j-fqxa`) | `document_id >= '2022070100000000' AND document_id < '2099' AND borough in (3,4)` | `document_id, borough, block, lot, property_type, partial_lot` |
| 7 | Property Valuation and Assessment Data (`8y4t-faws`) | `parid >= '3' AND parid < '5' AND year in ('2024','2025','2026','2027') AND period in ('1','3')`; the year list is a setting: the newest roll year and the three before it | `parid, year, period, curmkttot, curtaxclass, bldg_class, gross_sqft, units` |
| 8 | DOB Permit Issuance (`ipu4-2q9a`) | `job_type in ('A1','A2','A3') AND bbl >= '3' AND bbl < '5'` | `bbl, job__, job_type, work_type, permit_type, permit_status, filing_status, filing_date, issuance_date, job_start_date` |
| 9 | DOB Job Application Filings (`ic3t-wcy2`) | `bbl >= '3' AND bbl < '5'` | `bbl, job__, doc__, job_type, job_status, job_status_descrp, pre__filing_date, latest_action_date, approved, fully_permitted, signoff_date, initial_cost, proposed_dwelling_units, existing_dwelling_units, enlargement_sq_footage, vertical_enlrgmt, horizontal_enlrgmt, job_description` |
| 10 | DOB NOW: Build – Job Application Filings (`w9ak-ipjd`) | `bbl >= '3' AND bbl < '5'` | `bbl, job_filing_number, job_type, filing_status, filing_date, first_permit_date, approved_date, signoff_date, current_status_date, initial_cost, existing_dwelling_units, proposed_dwelling_units, plumbing_work_type, general_construction_work_type_, structural_work_type_, mechanical_systems_work_type_, job_description` |
| 11 | DOB NOW: Build – Approved Permits (`rbx6-tga4`) | `bbl >= '3' AND bbl < '5'` | `bbl, job_filing_number, work_permit, work_type, filing_reason, issued_date, permit_status, estimated_job_costs` |
| 12 | DOB NOW: Electrical Permit Applications (`dm9a-ab7w`) | `borough in ('Brooklyn','Queens')`; check the exact spelling in the metadata | `job_filing_number, filing_date, filing_status, job_status, permit_issued_date, completion_date, borough, block, lot, building_use_type, general_wiring, lighting_work, hvac_wiring, new_meters, job_description` |
| 13 | DOB Violations (`3h2n-5cm9`) | `boro in ('3','4')` | `boro, block, lot, bin, isn_dob_bis_viol, issue_date, violation_category, violation_type, disposition_date` |
| 14 | DOB ECB Violations (`6bgk-3dad`) | `boro in ('3','4')` | `boro, block, lot, bin, ecb_violation_number, ecb_violation_status, issue_date, severity, violation_type, hearing_status` |
| 15 | HPD Housing Maintenance Code Violations (`wvxf-dwi5`) | `bbl >= '3' AND bbl < '5'` | `bbl, violationid, class, inspectiondate, novissueddate, currentstatus, currentstatusdate, violationstatus, rentimpairing` |
| 16 | Building Footprints (`5zhs-2jue`) | `base_bbl >= '3' AND base_bbl < '5'` | `bin, base_bbl, mappluto_bbl, shape_area, height_roof, ground_elevation, construction_year, last_edited_date, last_status_type, feature_code` (never the geometry column) |
| 17 | Property Exemption Detail (`muvi-b6kx`) | `exmp_code like '51%' AND parid >= '3' AND parid < '5' AND year >= '2024'` | `parid, year, period, exmp_code, benftstart, no_years` |
| 18 | MTA Subway Stations (`39hk-dx4f` on `data.ny.gov`) | none (whole list) | `station_id, complex_id, stop_name, borough, daytime_routes, gtfs_latitude, gtfs_longitude` |
"""

# Ryan's decisions, 2026-10-18: dataset id -> (filter in the brief, filter used).
CHANGED_FILTERS = {
    "ipu4-2q9a": ("job_type in ('A1','A2','A3') AND bbl >= '3' AND bbl < '5'",
                  "job_type in ('A1','A2','A3') AND bbl >= 3000000000 AND bbl < 5000000000"),
    "rbx6-tga4": ("bbl >= '3' AND bbl < '5'",
                  "bbl >= 3000000000 AND bbl < 5000000000"),
    "dm9a-ab7w": ("borough in ('Brooklyn','Queens')",
                  "borough in ('Brooklyn','Queens','BROOKLYN','QUEENS')"),
}

# The brief's DOF URL patterns, {b} = brooklyn or queens.
DOF_PATTERNS = {
    range(2003, 2007): "/assets/finance/downloads/sales_{b}_{yy}.xls",
    range(2007, 2008): "/assets/finance/downloads/excel/rolling_sales/sales_2007_{b}.xls",
    range(2008, 2009): "/assets/finance/downloads/pdf/09pdf/rolling_sales/sales_2008_{b}.xls",
    range(2009, 2010): "/assets/finance/downloads/pdf/rolling_sales/annualized-sales/2009_{b}.xls",
    range(2010, 2016): "/assets/finance/downloads/pdf/rolling_sales/annualized-sales/{yyyy}/{yyyy}_{b}.xls",
}


def _code(cell, n=0):
    found = re.findall(r"`([^`]*)`", cell)
    return found[n] if len(found) > n else None


def _table():
    rows = []
    for line in SECTION_2.strip().splitlines():
        number, dataset, where, select = (c.strip() for c in line.strip().strip("|").split("|"))
        rows.append({
            "number": int(number),
            "id": _code(dataset),
            "host": _code(dataset, 1) or allowlist.NYC_OPEN_DATA,
            "where": _code(where),
            "columns": tuple(c.strip() for c in _code(select).split(",")),
        })
    return rows


TABLE = _table()


def test_same_datasets_in_the_same_order():
    assert [r["id"] for r in TABLE] == list(allowlist.DATASETS)
    assert [r["number"] for r in TABLE] == [d.number for d in allowlist.DATASETS.values()]


@pytest.mark.parametrize("row", TABLE, ids=lambda r: r["id"])
def test_column_lists_match_section_2(row):
    assert allowlist.DATASETS[row["id"]].columns == row["columns"]


@pytest.mark.parametrize("row", TABLE, ids=lambda r: r["id"])
def test_filters_match_section_2(row):
    ds = allowlist.DATASETS[row["id"]]
    expected = row["where"]
    if ds.id in CHANGED_FILTERS:
        brief, used = CHANGED_FILTERS[ds.id]
        assert expected == brief
        expected = used
    # #7 in the brief uses newest roll year 2027 (the newest on 2026-10-17).
    assert allowlist.where_for(ds, 2027) == expected


@pytest.mark.parametrize("row", TABLE, ids=lambda r: r["id"])
def test_hosts_match_section_2(row):
    assert allowlist.DATASETS[row["id"]].host == row["host"]


def test_dof_urls_match_the_brief():
    expected = []
    for years, pattern in DOF_PATTERNS.items():
        for year in years:
            for b in ("brooklyn", "queens"):
                path = pattern.format(b=b, yy=f"{year % 100:02d}", yyyy=year)
                expected.append(f"https://www.nyc.gov{path}")
    assert len(expected) == 26
    assert [f.url for f in allowlist.DOF_FILES] == expected


def test_roll_year_setting():
    assert allowlist.default_newest_roll_year(dt.date(2026, 10, 17)) == 2027
    assert allowlist.roll_years(2027) == ("2024", "2025", "2026", "2027")
    today = dt.date(2026, 10, 17)
    for newest in (2025, 2026, 2027):
        allowlist.check_newest_roll_year(newest, today)
    for newest in (2024, 2028):
        with pytest.raises(allowlist.NotAllowed):
            allowlist.check_newest_roll_year(newest, today)
