"""Shared fixtures: a small invented data folder in valuation/fetch's layout, and no network.

Everything here is made up: invented streets ("EXAMPLE STREET"), invented lots and prices.
"""
from __future__ import annotations

import json
import os
import socket

import numpy as np
import pandas as pd
import pytest

from valuation.dfval import config
from valuation.dfval.raw import Raw


@pytest.fixture(scope="session", autouse=True)
def no_network():
    """Engineering precaution: no test may open a connection."""
    def refuse(*a, **k):
        raise RuntimeError("network access in a test")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(socket.socket, "connect", refuse)
        mp.setattr(socket, "create_connection", refuse)
        yield


def _txt(df: pd.DataFrame) -> pd.DataFrame:
    """valuation/fetch stores every column as text, missing values empty."""
    return df.astype(object).where(df.notna(), None).map(lambda v: None if v is None else str(v))


STREETS = ["EXAMPLE STREET", "SAMPLE AVENUE", "TEST PLACE", "DEMO ROAD"]
NBS = ["BEDFORD STUYVESANT", "BUSHWICK", "FLATBUSH", "BAY RIDGE"]


def make_world(seed: int = 7, n_lots: int = 240, start="2021-01-01", end="2026-09-30"):
    """Invented lots and sales with a simple, learnable price pattern."""
    rng = np.random.default_rng(seed)
    lots = []
    for i in range(n_lots):
        boro = 3 if i < n_lots * 3 // 4 else 4
        block = 1000 + i // 12
        lot = 1 + i % 12
        nb = NBS[(i // 60) % len(NBS)]
        street = STREETS[(i // 12) % len(STREETS)]
        number = 100 + 2 * (i % 60)
        cls = ["A1", "B1", "B2", "C0", "C3"][i % 5]
        units = {"A1": 1, "B1": 2, "B2": 2, "C0": 3, "C3": 4}[cls]
        sqft = float(rng.integers(1200, 4200))
        lat = 40.68 + (i // 12) * 0.0012 + rng.normal(0, 0.0002)
        lon = -73.95 + (i % 12) * 0.0012 + rng.normal(0, 0.0002)
        lots.append(dict(boro=boro, block=block, lot=lot, nb=nb, street=street, number=number, cls=cls, units=units,
                         sqft=sqft, lat=lat, lon=lon, zip="11216" if boro == 3 else "11385"))
    # three lots the model doesn't value: a 6-unit building, a condo billing lot, a garage
    lots += [dict(boro=3, block=2001, lot=1, nb=NBS[0], street="SPARE STREET", number=10, cls="C1", units=6, sqft=6000.0, lat=40.70, lon=-73.94, zip="11216"),
             dict(boro=3, block=2001, lot=7501, nb=NBS[0], street="SPARE STREET", number=20, cls="R4", units=8, sqft=9000.0, lat=40.701, lon=-73.94, zip="11216"),
             dict(boro=3, block=2001, lot=5, nb=NBS[0], street="SPARE STREET", number=30, cls="G1", units=0, sqft=800.0, lat=40.702, lon=-73.94, zip="11216")]
    L = pd.DataFrame(lots)
    L["bbl"] = L["boro"].astype(str) + L["block"].astype(str).str.zfill(5) + L["lot"].astype(str).str.zfill(4)
    L["ppsf0"] = L["nb"].map({NBS[0]: 600.0, NBS[1]: 520.0, NBS[2]: 450.0, NBS[3]: 700.0})
    days = pd.date_range(start, end, freq="D")
    sales = []
    fam = L[L["cls"].str.match(r"^(A|B|C0|C3)")]
    for _ in range(2600):
        r = fam.iloc[int(rng.integers(0, len(fam)))]
        d = days[int(rng.integers(0, len(days)))]
        growth = 1.0 + 0.04 * (d - pd.Timestamp(start)).days / 365.25
        price = round(r["sqft"] * r["ppsf0"] * growth * float(np.exp(rng.normal(0, 0.12))), -3)
        sales.append(dict(bbl=r["bbl"], date=d, price=price))
    Sx = pd.DataFrame(sales).drop_duplicates(["bbl", "date"]).merge(L, on="bbl")
    return L, Sx.sort_values("date").reset_index(drop=True)


def write_folder(root: str, L: pd.DataFrame, Sx: pd.DataFrame, cutover="2025-10-01") -> str:
    raw = os.path.join(root, "raw")
    os.makedirs(os.path.join(raw, "dof_annual"), exist_ok=True)
    files = {}

    def put(ds, df):
        _txt(df).to_parquet(os.path.join(raw, f"{ds}.parquet"), index=False)
        files[f"raw/{ds}.parquet"] = {"rows": len(df), "source_updated_at": "2026-10-10T00:00:00Z"}

    def sales_cols(s, annual):
        df = pd.DataFrame({
            "borough": s["boro"], "neighborhood": s["nb"], "building_class_category": "01 ONE FAMILY DWELLINGS",
            ("tax_class_as_of_final_roll" if annual else "tax_class_at_present"): np.where(s["cls"] == "C3", "2", "1"),
            "block": s["block"], "lot": s["lot"], ("building_class_as_of_final" if annual else "building_class_at_present"): s["cls"],
            "address": s["number"].astype(str) + " " + s["street"], "apartment_number": None, "zip_code": s["zip"],
            "residential_units": s["units"], "commercial_units": 0, "total_units": s["units"], "land_square_feet": "2,000",
            "gross_square_feet": s["sqft"].round().astype(int), "year_built": 1910, "tax_class_at_time_of_sale": np.where(s["cls"] == "C3", "2", "1"),
            "building_class_at_time_of": s["cls"], "sale_price": s["price"].astype(int), "sale_date": s["date"].dt.strftime("%Y-%m-%dT00:00:00.000")})
        if annual:
            df["latitude"], df["longitude"], df["bbl"], df["bin"], df["nta"] = None, None, s["bbl"], None, None
        return df

    cut = pd.Timestamp(cutover)
    put(config.DATASETS["sales_annual"], sales_cols(Sx[(Sx["date"] < "2026-01-01") & (Sx["date"] >= "2016-01-01")], True))   # overlaps rolling by 3 months
    put(config.DATASETS["sales_rolling"], sales_cols(Sx[Sx["date"] >= cut], False))
    put(config.DATASETS["pluto"], pd.DataFrame({
        "bbl": L["bbl"] + ".00000000", "borough": np.where(L["boro"] == 3, "BK", "QN"), "block": L["block"], "lot": L["lot"],
        "address": L["number"].astype(str) + " " + L["street"], "zipcode": L["zip"], "latitude": L["lat"], "longitude": L["lon"],
        "bldgclass": L["cls"], "landuse": "1", "bldgarea": L["sqft"].round().astype(int), "resarea": L["sqft"].round().astype(int), "comarea": 0,
        "unitsres": L["units"], "unitstotal": L["units"], "numbldgs": 1, "numfloors": "3.0000000", "yearbuilt": 1910, "yearalter1": 0, "yearalter2": 0,
        "lotarea": 2000, "lotfront": "20.0000000", "lotdepth": "100.0000000", "bldgfront": "20.0000000", "bldgdepth": "50.0000000",
        "builtfar": "1.5", "residfar": "2.0", "zonedist1": "R6B", "histdist": None, "landmark": None, "proxcode": "2", "irrlotcode": "false",
        "bsmtcode": "2", "ext": None, "condono": np.where(L["cls"] == "R4", "1", None), "version": "26v2"}))
    a = Sx[Sx["date"] >= config.ACRIS_START].reset_index(drop=True)
    ids = [f"20{d:%y%m%d}{i:08d}" for i, d in enumerate(a["date"])]
    master = pd.DataFrame({"document_id": ids, "doc_type": "DEED", "document_date": (a["date"] - pd.Timedelta(days=2)).dt.strftime("%Y-%m-%dT00:00:00.000"),
                           "document_amt": a["price"].map(lambda p: f"{p:.2f}"), "recorded_datetime": (a["date"] + pd.Timedelta(days=9)).dt.strftime("%Y-%m-%dT00:00:00.000"),
                           "recorded_borough": "1", "percent_trans": "100.000000"})
    master.loc[::40, "percent_trans"] = "50.000000"  # partial-interest transfers: not arm's length
    put(config.DATASETS["acris_master"], master)
    put(config.DATASETS["acris_legals"], pd.DataFrame({"document_id": ids, "borough": a["boro"], "block": a["block"], "lot": a["lot"],
                                                       "property_type": "1F", "partial_lot": "E"}))
    roll = []
    for _, r in L.iterrows():
        for fy in (2024, 2025, 2026, 2027):
            for per in (1, 3):
                roll.append({"parid": r["bbl"], "year": fy, "period": per, "curmkttot": int(r["sqft"] * r["ppsf0"] * (1 + 0.04 * (fy - 2021))),
                             "curtaxclass": "2" if r["cls"] in ("C3", "C1") else "1", "bldg_class": r["cls"], "gross_sqft": int(r["sqft"]), "units": r["units"]})
    put(config.DATASETS["roll"], pd.DataFrame(roll))
    pick = L.iloc[::9]
    put(config.DATASETS["dob_permits"], pd.DataFrame({"bbl": pick["bbl"], "job__": range(len(pick)), "job_type": "A2", "work_type": "PL", "permit_type": "PL",
                                                      "permit_status": "ISSUED", "filing_status": "INITIAL", "filing_date": "03/01/2022",
                                                      "issuance_date": "03/15/2022", "job_start_date": "03/20/2022"}))
    put(config.DATASETS["dob_jobs"], pd.DataFrame({"bbl": pick["bbl"], "job__": range(len(pick)), "doc__": "01", "job_type": "A1", "job_status": "X",
                                                   "job_status_descrp": "SIGNED OFF", "pre__filing_date": "01/10/2022", "latest_action_date": "06/01/2022",
                                                   "approved": "02/01/2022", "fully_permitted": "02/15/2022", "signoff_date": "06/01/2022",
                                                   "initial_cost": "$90000.00", "proposed_dwelling_units": "2", "existing_dwelling_units": "2",
                                                   "enlargement_sq_footage": "0", "vertical_enlrgmt": None, "horizontal_enlrgmt": None,
                                                   "job_description": "INTERIOR RENOVATION OF KITCHEN AND BATH"}))
    put(config.DATASETS["dobnow_jobs"], pd.DataFrame({"bbl": pick["bbl"], "job_filing_number": [f"B0000{i:04d}-I1" for i in range(len(pick))], "job_type": "Alteration",
                                                      "filing_status": "Permit Entire", "filing_date": "2023-05-01T00:00:00.000", "first_permit_date": "2023-06-01T00:00:00.000",
                                                      "approved_date": "2023-05-20T00:00:00.000", "signoff_date": None, "current_status_date": "2023-06-01T00:00:00.000",
                                                      "initial_cost": "40000", "existing_dwelling_units": "2", "proposed_dwelling_units": "2", "plumbing_work_type": "YES",
                                                      "general_construction_work_type_": "YES", "structural_work_type_": "NO", "mechanical_systems_work_type_": "NO",
                                                      "job_description": "GENERAL CONSTRUCTION"}))
    put(config.DATASETS["dobnow_permits"], pd.DataFrame({"bbl": pick["bbl"], "job_filing_number": [f"B0000{i:04d}-I1" for i in range(len(pick))],
                                                         "work_permit": "x", "work_type": "General Construction", "filing_reason": "Initial Permit",
                                                         "issued_date": "2023-06-01T00:00:00.000", "permit_status": "Permit Issued", "estimated_job_costs": "40000"}))
    put(config.DATASETS["dobnow_electrical"], pd.DataFrame({"job_filing_number": "E1", "filing_date": "2024-01-01T00:00:00.000", "filing_status": "Approved",
                                                            "job_status": "Job in Process", "permit_issued_date": "2024-01-05T00:00:00.000", "completion_date": None,
                                                            "borough": "Brooklyn", "block": pick["block"], "lot": pick["lot"], "building_use_type": "x",
                                                            "general_wiring": "Yes", "lighting_work": "No", "hvac_wiring": "No", "new_meters": "0", "job_description": "x"}))
    put(config.DATASETS["dob_violations"], pd.DataFrame({"boro": pick["boro"], "block": pick["block"].astype(str).str.zfill(5), "lot": pick["lot"].astype(str).str.zfill(5),
                                                         "bin": "1", "isn_dob_bis_viol": range(len(pick)), "issue_date": "20240301",
                                                         "violation_category": "V-DOB VIOLATION - ACTIVE", "violation_type": "C-CONSTRUCTION", "disposition_date": None}))
    put(config.DATASETS["ecb_violations"], pd.DataFrame({"boro": pick["boro"], "block": pick["block"].astype(str).str.zfill(5), "lot": pick["lot"].astype(str).str.zfill(4),
                                                         "bin": "1", "ecb_violation_number": range(len(pick)), "ecb_violation_status": "ACTIVE", "issue_date": "20240301",
                                                         "severity": "CLASS - 1", "violation_type": "Construction", "hearing_status": "PENDING"}))
    put(config.DATASETS["hpd_violations"], pd.DataFrame({"bbl": pick["bbl"], "violationid": range(len(pick)), "class": "B", "inspectiondate": "2024-02-01T00:00:00.000",
                                                         "novissueddate": "2024-02-03T00:00:00.000", "currentstatus": "NOV SENT OUT", "currentstatusdate": "2024-02-03T00:00:00.000",
                                                         "violationstatus": "Open", "rentimpairing": "N"}))
    put(config.DATASETS["footprints"], pd.DataFrame({"bin": range(len(L)), "base_bbl": L["bbl"], "mappluto_bbl": L["bbl"], "shape_area": (L["sqft"] / 3 / 10.7639).round(2),
                                                     "height_roof": "35", "ground_elevation": "30", "construction_year": "1910",
                                                     "last_edited_date": "2017-08-17T16:16:44.000Z", "last_status_type": "Constructed", "feature_code": "2100"}))
    put(config.DATASETS["exemptions"], pd.DataFrame({"parid": [L["bbl"].iloc[3]], "year": ["2026"], "period": ["1"], "exmp_code": ["5113"], "benftstart": ["+2015"], "no_years": ["15"]}))
    put(config.DATASETS["stations"], pd.DataFrame({"station_id": [1, 2, 3], "complex_id": [1, 2, 3], "stop_name": ["A Av", "B Av", "C Av"], "borough": "Bk",
                                                   "daytime_routes": "A", "gtfs_latitude": [40.685, 40.70, 40.69], "gtfs_longitude": [-73.945, -73.94, -73.93]}))
    with open(os.path.join(root, "manifest.json"), "w") as fh:
        json.dump({"tool": "valuation.fetch", "format": 1, "run": {"status": "complete", "finished_at": "2026-10-18T18:32:40Z"}, "files": files}, fh)
    return root


@pytest.fixture(scope="session")
def world():
    return make_world()


@pytest.fixture(scope="session")
def data_dir(tmp_path_factory, world):
    L, Sx = world
    return write_folder(str(tmp_path_factory.mktemp("data")), L, Sx)


@pytest.fixture(scope="session", autouse=True)
def no_dof_excel():
    """The 26 DOF Excel files (2003-2015) aren't faked; the invented sales start in 2021."""
    cols = ["borough", "neighborhood", "bcc", "tax_class_present", "block", "lot", "bldg_class_present", "address", "apt", "zip", "res_units",
            "com_units", "tot_units", "land_sqft", "gross_sqft", "year_built", "tax_class_sale", "bldg_class_sale", "price", "date", "src"]
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(Raw, "dof_xls", lambda self: pd.DataFrame({c: pd.Series(dtype="datetime64[ns]" if c == "date" else object) for c in cols}))
        yield
