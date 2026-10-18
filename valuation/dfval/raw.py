"""Readers for the public-record files written by valuation/fetch (Brief 44.1).

Every Parquet column arrives as text, exactly as the city published it. Each reader here
types its columns and returns the table in the shape the valuation research built, so the
ported steps (sales.py, deeds.py, features.py) can follow the research code closely.

Nothing here downloads anything, and no file read here holds a person's name: valuation/fetch
selects allow-listed columns only (Brief 44.1 §2).
"""
from __future__ import annotations

import glob
import json
import os
import re
from functools import cached_property

import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from . import config

# The research matched DOF sales to these ACRIS deed types (acris_window.py). valuation/fetch
# also downloads 'DEED, TS' (timeshare deeds), which no 1-4 family sale uses.
DEED_TYPES = ("DEED", "DEEDO", "DEEDP", "DEED, LE", "DEED, RC", "IDED", "REIT")

_BBL = re.compile(r"^[1-5]\d{9}$")


def to_num(s: pd.Series) -> pd.Series:
    """Text to number the way the research's build_sales did: strip $ , and spaces."""
    t = s.astype("string").str.replace(r"[,$\s]", "", regex=True)
    return pd.to_numeric(t.replace({"-": None, "": None}), errors="coerce")


def bbl_from_parts(boro, block, lot) -> pd.Series:
    """Borough + block + lot -> the 10-digit tax-lot number ("3" + 5 + 4 digits).

    Rows whose block or lot isn't a whole number get no tax lot."""
    b = pd.to_numeric(pd.Series(boro), errors="coerce")
    k = pd.to_numeric(pd.Series(block), errors="coerce")
    lo = pd.to_numeric(pd.Series(lot), errors="coerce")
    ok = b.notna() & k.notna() & lo.notna() & (k % 1 == 0) & (lo % 1 == 0) & (k >= 0) & (lo >= 0) & (k < 100000) & (lo < 10000)
    out = pd.Series(pd.NA, index=b.index, dtype="string")
    out[ok] = (b[ok].astype(int).astype(str) + k[ok].astype(int).astype(str).str.zfill(5)
               + lo[ok].astype(int).astype(str).str.zfill(4))
    return out


def clean_bbl(s: pd.Series) -> pd.Series:
    """A city tax-lot column as text: '4000120034.00000000' -> '4000120034'; anything that isn't
    a 10-digit Brooklyn/Queens-style lot number becomes missing."""
    t = s.astype("string").str.strip().str.replace(r"\.0+$", "", regex=True)
    return t.where(t.str.match(_BBL), pd.NA)


class Raw:
    """One data folder written by valuation/fetch."""

    def __init__(self, data_dir: str):
        self.dir = data_dir
        self.raw = os.path.join(data_dir, "raw")
        if not os.path.isdir(self.raw):
            raise FileNotFoundError(f"no raw/ folder in {data_dir}: run valuation/fetch first")

    # ---- the manifest ----------------------------------------------------------------
    @cached_property
    def manifest(self) -> dict:
        with open(os.path.join(self.dir, "manifest.json")) as fh:
            m = json.load(fh)
        if (m.get("run") or {}).get("status") != "complete":
            # Engineering precaution: a half-finished download must never be valued from.
            raise RuntimeError("the data folder's download did not complete (manifest run.status)")
        return m

    def entry(self, dataset_id: str) -> dict:
        return self.manifest["files"][f"raw/{dataset_id}.parquet"]

    def _read(self, key: str, columns: list[str], filt=None) -> pd.DataFrame:
        path = os.path.join(self.raw, f"{config.DATASETS[key]}.parquet")
        t = pq.read_table(path, columns=columns)
        if filt is not None:
            t = t.filter(filt(t))
        return t.to_pandas()

    # ---- DOF sales ---------------------------------------------------------------------
    def dof_xls(self) -> pd.DataFrame:
        """The 26 DOF annualized-sales Excel files, 2003-2015, as the research read them."""
        cols = ["borough", "neighborhood", "bcc", "tax_class_present", "block", "lot", "bldg_class_present", "address", "apt", "zip",
                "res_units", "com_units", "tot_units", "land_sqft", "gross_sqft", "year_built", "tax_class_sale", "bldg_class_sale", "price", "date"]
        norm = lambda c: re.sub(r"[^A-Z]", "", str(c).upper())  # noqa: E731
        names = {"BOROUGH": "borough", "NEIGHBORHOOD": "neighborhood", "BUILDINGCLASSCATEGORY": "bcc", "TAXCLASSATPRESENT": "tax_class_present",
                 "TAXCLASSASOFFINALROLL": "tax_class_present", "BLOCK": "block", "LOT": "lot", "BUILDINGCLASSATPRESENT": "bldg_class_present",
                 "BUILDINGCLASSASOFFINALROLL": "bldg_class_present", "ADDRESS": "address", "APARTMENTNUMBER": "apt", "APARTMENTNUMBERS": "apt",
                 "ZIPCODE": "zip", "RESIDENTIALUNITS": "res_units", "COMMERCIALUNITS": "com_units", "TOTALUNITS": "tot_units",
                 "LANDSQUAREFEET": "land_sqft", "GROSSSQUAREFEET": "gross_sqft", "YEARBUILT": "year_built", "TAXCLASSATTIMEOFSALE": "tax_class_sale",
                 "BUILDINGCLASSATTIMEOFSALE": "bldg_class_sale", "SALEPRICE": "price", "SALEDATE": "date"}
        frames = []
        files = sorted(glob.glob(os.path.join(self.raw, "dof_annual", "*.xls*")))
        if len(files) != 26:
            raise RuntimeError(f"expected 26 DOF annualized-sales files, found {len(files)}")
        for f in files:
            raw = pd.read_excel(f, header=None, dtype=str)
            hdr = next(i for i in range(15) if any(norm(x) == "SALEPRICE" for x in raw.iloc[i].tolist()))
            df = raw.iloc[hdr + 1:].copy()
            df.columns = [names.get(norm(c), norm(c)) for c in raw.iloc[hdr]]
            df = df[[c for c in cols if c in df.columns]]
            df["src"] = "xls:" + os.path.basename(f)
            frames.append(df)
        out = pd.concat(frames, ignore_index=True)
        out["date"] = pd.to_datetime(out["date"], errors="coerce")
        return out[out["date"] < "2016-01-01"]

    _SALES_RENAME = {"building_class_category": "bcc", "tax_class_as_of_final_roll": "tax_class_present", "building_class_as_of_final": "bldg_class_present",
                     "tax_class_at_present": "tax_class_present", "building_class_at_present": "bldg_class_present",
                     "apartment_number": "apt", "zip_code": "zip", "residential_units": "res_units", "commercial_units": "com_units", "total_units": "tot_units",
                     "land_square_feet": "land_sqft", "gross_square_feet": "gross_sqft", "tax_class_at_time_of_sale": "tax_class_sale",
                     "building_class_at_time_of": "bldg_class_sale", "sale_price": "price", "sale_date": "date"}

    def sales_open_data(self, key: str) -> pd.DataFrame:
        """DOF annualized (w2pb-icbu, 2016 on) or rolling (usep-8jbt, the last 12 months) sales."""
        path = os.path.join(self.raw, f"{config.DATASETS[key]}.parquet")
        df = pd.read_parquet(path).rename(columns=self._SALES_RENAME)
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df["src"] = config.DATASETS[key]
        return df

    # ---- PLUTO -------------------------------------------------------------------------
    def pluto(self) -> pd.DataFrame:
        """All Brooklyn and Queens tax lots. PLUTO's owner-name column is never downloaded
        (Ryan's decision, 2026-10-17: PLUTO owner names stay erased)."""
        df = pd.read_parquet(os.path.join(self.raw, f"{config.DATASETS['pluto']}.parquet"))
        df["bbl"] = clean_bbl(df["bbl"]).astype(object)
        df = df[df["bbl"].notna()].copy()
        for c in ["latitude", "longitude", "bldgarea", "resarea", "comarea", "unitsres", "unitstotal", "numbldgs", "yearbuilt",
                  "yearalter1", "yearalter2", "lotarea", "numfloors"]:
            df[c] = pd.to_numeric(df[c], errors="coerce")
        # The research read irrlotcode as a JSON boolean ('True'/'False'); the files spell it in lower case.
        df["irrlotcode"] = df["irrlotcode"].map({"true": "True", "false": "False"}).astype(object).where(df["irrlotcode"].notna(), None)
        for c in ["zipcode", "zonedist1", "histdist", "landmark", "proxcode", "bsmtcode", "ext", "condono", "address", "bldgclass", "landuse",
                  "lotfront", "lotdepth", "bldgfront", "bldgdepth", "builtfar", "residfar", "version"]:
            df[c] = df[c].astype(object).where(df[c].notna(), None)
        return df.reset_index(drop=True)

    # ---- ACRIS (deeds only; no parties dataset, Brief 44 revision 3) --------------------
    def acris_master(self) -> pd.DataFrame:
        df = self._read("acris_master", ["document_id", "doc_type", "document_date", "document_amt", "recorded_datetime", "recorded_borough", "percent_trans"])
        df = df[df["doc_type"].isin(DEED_TYPES)]
        # The city repeats some documents (Brief 44.1: 1,102 ids). Exact repeats are dropped; repeats
        # that differ in amount or share stay as candidates, and each sale's deed match (deeds.py)
        # picks the one agreeing with the DOF price, as the research did.
        return df.drop_duplicates().reset_index(drop=True)

    def acris_legals(self) -> pd.DataFrame:
        df = self._read("acris_legals", ["document_id", "borough", "block", "lot", "property_type", "partial_lot"])
        df["bbl"] = bbl_from_parts(df["borough"], df["block"], df["lot"]).astype(object)
        return df[df["bbl"].notna()].reset_index(drop=True)

    # ---- DOF assessment roll -------------------------------------------------------------
    def roll(self, lots: set[str] | None = None) -> pd.DataFrame:
        cols = ["parid", "year", "period", "curmkttot", "curtaxclass", "bldg_class", "gross_sqft", "units"]
        filt = (lambda t: pc.is_in(t["parid"], value_set=pa.array(sorted(lots)))) if lots is not None else None
        df = self._read("roll", cols, filt)
        df["year"] = pd.to_numeric(df["year"], errors="coerce")
        df["period"] = pd.to_numeric(df["period"], errors="coerce")
        df = df.dropna(subset=["year", "period"])
        df["year"] = df["year"].astype(int)
        df["period"] = df["period"].astype(int)
        df["mv"] = pd.to_numeric(df["curmkttot"], errors="coerce")
        return df.reset_index(drop=True)

    # ---- DOB permits and job filings ---------------------------------------------------------
    def dob_permits(self) -> pd.DataFrame:
        """DOB BIS alteration permits (A1-A3), the research's bt_dob_bis columns."""
        df = self._read("dob_permits", ["bbl", "job__", "job_type", "work_type", "issuance_date", "permit_status"])
        df["bbl"] = clean_bbl(df["bbl"]).astype(object)
        return df[df["bbl"].notna()].drop_duplicates().reset_index(drop=True)

    def dobnow_permits(self) -> pd.DataFrame:
        df = self._read("dobnow_permits", ["bbl", "job_filing_number", "work_type", "issued_date", "permit_status"])
        df["bbl"] = clean_bbl(df["bbl"]).astype(object)
        return df[df["bbl"].notna()].drop_duplicates().reset_index(drop=True)

    def dobnow_jobs(self) -> pd.DataFrame:
        cols = ["bbl", "job_filing_number", "job_type", "filing_status", "filing_date", "first_permit_date", "approved_date", "signoff_date",
                "current_status_date", "initial_cost", "existing_dwelling_units", "proposed_dwelling_units", "plumbing_work_type",
                "general_construction_work_type_", "structural_work_type_", "mechanical_systems_work_type_", "job_description"]
        df = self._read("dobnow_jobs", cols)
        df["bbl"] = clean_bbl(df["bbl"]).astype(object)
        df = df[df["bbl"].notna()]
        # The city repeats a few filing numbers (Brief 44.1: 88); keep each filing's latest state.
        df = df.assign(_s=pd.to_datetime(df["current_status_date"], errors="coerce"))
        df = df.sort_values(["job_filing_number", "_s"], na_position="first").drop_duplicates("job_filing_number", keep="last")
        return df.drop(columns="_s").reset_index(drop=True)

    def dob_jobs(self) -> pd.DataFrame:
        cols = ["bbl", "job__", "doc__", "job_type", "job_status", "job_status_descrp", "pre__filing_date", "latest_action_date", "approved",
                "fully_permitted", "signoff_date", "initial_cost", "existing_dwelling_units", "proposed_dwelling_units", "horizontal_enlrgmt",
                "vertical_enlrgmt", "enlargement_sq_footage", "job_description"]
        df = self._read("dob_jobs", cols)
        df["bbl"] = clean_bbl(df["bbl"]).astype(object)
        return df[df["bbl"].notna()].drop_duplicates().reset_index(drop=True)

    def dobnow_electrical(self) -> pd.DataFrame:
        cols = ["job_filing_number", "filing_date", "filing_status", "job_status", "permit_issued_date", "completion_date", "block", "lot", "borough"]
        df = self._read("dobnow_electrical", cols)
        boro = df["borough"].str.strip().str.upper().map({"BROOKLYN": 3, "QUEENS": 4})
        df["bbl_key"] = bbl_from_parts(boro, df["block"], df["lot"]).astype(object)
        return df[df["bbl_key"].notna()].reset_index(drop=True)

    # ---- violations ---------------------------------------------------------------------------
    def dob_violations(self) -> pd.DataFrame:
        df = self._read("dob_violations", ["boro", "block", "lot", "issue_date", "violation_category", "violation_type", "disposition_date"])
        df["bbl_key"] = bbl_from_parts(df["boro"], df["block"], df["lot"]).astype(object)
        return df[df["bbl_key"].notna()].reset_index(drop=True)

    def ecb_violations(self) -> pd.DataFrame:
        # The money-owed column was never downloaded (Brief 44.1 §2).
        df = self._read("ecb_violations", ["boro", "block", "lot", "issue_date", "ecb_violation_status", "severity", "violation_type", "hearing_status"])
        df["bbl_key"] = bbl_from_parts(df["boro"], df["block"], df["lot"]).astype(object)
        return df[df["bbl_key"].notna()].reset_index(drop=True)

    def hpd_violations(self, lots: set[str] | None = None) -> pd.DataFrame:
        cols = ["bbl", "violationid", "class", "inspectiondate", "novissueddate", "currentstatus", "currentstatusdate", "violationstatus"]
        filt = (lambda t: pc.is_in(t["bbl"], value_set=pa.array(sorted(lots)))) if lots is not None else None
        df = self._read("hpd_violations", cols, filt)
        df["bbl"] = clean_bbl(df["bbl"]).astype(object)
        return df[df["bbl"].notna()].reset_index(drop=True)

    # ---- footprints, 421-a, subway ------------------------------------------------------------
    def footprints(self) -> pd.DataFrame:
        df = self._read("footprints", ["bin", "base_bbl", "shape_area", "height_roof", "last_edited_date"])
        df["base_bbl"] = clean_bbl(df["base_bbl"]).astype(object)
        return df[df["base_bbl"].notna()].reset_index(drop=True)

    def exemptions_421a(self) -> pd.DataFrame:
        """421-a property-tax exemption codes (51xx) only: no personal exemptions (Brief 39B)."""
        df = self._read("exemptions", ["parid", "year", "period", "exmp_code"])
        df = df[df["exmp_code"].astype(str).str.startswith("51")]
        df["year"] = pd.to_numeric(df["year"], errors="coerce")
        return df.dropna(subset=["year"]).reset_index(drop=True)

    def stations(self) -> pd.DataFrame:
        df = self._read("stations", ["stop_name", "gtfs_latitude", "gtfs_longitude"])
        df["lat"] = pd.to_numeric(df["gtfs_latitude"], errors="coerce")
        df["lon"] = pd.to_numeric(df["gtfs_longitude"], errors="coerce")
        return df.dropna(subset=["lat", "lon"]).reset_index(drop=True)

    # ---- provenance for the run's sources footer -------------------------------------------
    def sources(self) -> dict:
        """Dataset versions for the CRM card's sources footer: dates and row counts only."""
        files = self.manifest["files"]
        day = lambda s: (s or "")[:10] or None  # noqa: E731
        ds = {}
        for path, e in files.items():
            if path.startswith("raw/dof_annual/"):
                ds.setdefault("dof_annual", {"updatedOn": None, "rows": 0})
                continue
            m = re.match(r"^raw/([a-z0-9]{4}-[a-z0-9]{4})\.parquet$", path)
            if m:
                ds[m.group(1)] = {"updatedOn": day(e.get("source_updated_at")), "rows": int(e.get("rows") or 0)}
        return {"downloadedOn": day(self.manifest["run"].get("finished_at")), "datasets": ds}

