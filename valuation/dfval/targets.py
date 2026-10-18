"""CRM sellers -> city tax lots, found locally in the downloaded files (Brief 44 revision 4).

The job never asks the city about a particular property or seller. Each seller's tax lot comes
from DealFlow's cached lot (a lot an earlier published run matched), or else from matching the
property address against PLUTO's lot addresses and the DOF sales records' addresses. A seller
that can't be matched gets "not_found".

Only the property address is used: DealFlow's targets address never sends a name, phone, email
or mailing address (lib/valuations/targets.ts).
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .frame import class_group

SUFFIX = {
    "STREET": "ST", "STR": "ST", "AVENUE": "AVE", "AV": "AVE", "AVEN": "AVE", "PLACE": "PL", "ROAD": "RD", "BOULEVARD": "BLVD",
    "PARKWAY": "PKWY", "PKY": "PKWY", "COURT": "CT", "LANE": "LN", "TERRACE": "TER", "TERR": "TER", "DRIVE": "DR", "HIGHWAY": "HWY",
    "EXPRESSWAY": "EXPY", "TURNPIKE": "TPKE", "SQUARE": "SQ", "CIRCLE": "CIR", "WALK": "WALK", "LOOP": "LOOP", "CRESCENT": "CRES",
}
DIRECTION = {"EAST": "E", "WEST": "W", "NORTH": "N", "SOUTH": "S"}
UNIT = re.compile(r"(?:\s*,\s*|\s+)(?:#\s*|APT\.?\s*|APARTMENT\s+|UNIT\s+|STE\.?\s+|SUITE\s+|FL\.?\s+|FLOOR\s+|RM\s+)([A-Z0-9-]+)\s*$")
TRAILING_COMMA_UNIT = re.compile(r"\s*,\s*([A-Z0-9-]{1,6})\s*$")


@dataclass(frozen=True)
class Parsed:
    number: str      # house number, digits only ("59-14" -> "5914")
    letter: str      # a house-number letter ("123A" -> "A"), else ""
    street: str      # normalized street name ("EXAMPLE ST", "E 18 ST", "ST MARKS AVE")
    unit: str | None


def parse_address(addr: str | None) -> Parsed | None:
    a = re.sub(r"\s+", " ", (addr or "").upper().replace(".", " ").replace("'", "")).strip()
    if not a:
        return None
    unit = None
    m = UNIT.search(a)
    if m:
        unit, a = m.group(1), a[:m.start()].strip()
    else:
        m = TRAILING_COMMA_UNIT.search(a)
        if m:
            unit, a = m.group(1), a[:m.start()].strip()
    m = re.match(r"^(\d+)(?:\s*-\s*(\d+))?([A-Z])?\s+(.+)$", a)  # "123A" has a letter; "100 E 18 ST" doesn't
    if not m:
        return None
    number = m.group(1) + (m.group(2) or "")
    letter = m.group(3) or ""
    toks = []
    for t in m.group(4).replace(",", " ").split():
        t = re.sub(r"^(\d+)(ST|ND|RD|TH)$", r"\1", t)  # 57TH -> 57
        t = {"SAINT": "ST", "MOUNT": "MT", "FORT": "FT"}.get(t, t)
        toks.append(DIRECTION.get(t, t))
    # Street-type words in any position, so "AVENUE J" and "AVE J" agree (both sides are normalized alike).
    street = " ".join(SUFFIX.get(t, t) for t in toks)
    street = re.sub(r"\b(MC|MAC) (?=[A-Z])", r"\1", street)  # MC DONALD AVE -> MCDONALD AVE, MAC DONOUGH -> MACDONOUGH
    return Parsed(number=number.lstrip("0") or "0", letter=letter, street=street, unit=unit)


def _edit1(a: str, b: str) -> bool:
    """True when two street names differ by at most one inserted, deleted or changed letter."""
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    s, t = (a, b) if len(a) < len(b) else (b, a)
    return any(t[:i] + t[i + 1:] == s for i in range(len(t)))


def _spelling_twin(a: str, b: str) -> bool:
    """Two street names that differ only by a one-letter slip inside one word of 4+ letters
    ("EXMPLE ST" / "EXAMPLE ST"). Never a different number ("E 52 ST" / "E 51 ST" / "E 5 ST"),
    direction ("E 52 ST" / "W 52 ST") or suffix: those are other streets (engineering precaution)."""
    ta, tb = a.split(), b.split()
    if a == b or len(ta) != len(tb):
        return False
    diff = [(x, y) for x, y in zip(ta, tb) if x != y]
    return len(diff) == 1 and all(len(w) >= 4 and w.isalpha() for w in diff[0]) and _edit1(*diff[0])


class AddressIndex:
    """Property address -> tax lot, from PLUTO's lot addresses first, then DOF sales addresses.

    Matching order (each step must agree with the lead's ZIP when PLUTO knows the lot's ZIP):
    the exact house number and street; the same without a house-number letter; the street with or
    without a direction word ("5 ST" for "S 5 ST"); a one-letter street spelling difference at the
    same house number. Several lots at one address are told apart by the lead's own unit count and
    building size."""

    def __init__(self, pluto: pd.DataFrame, sales: pd.DataFrame):
        self.exact: dict[tuple, set[str]] = defaultdict(set)      # (boro, number+letter, street)
        self.loose: dict[tuple, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))  # (boro, number, street) -> {letter: lots}
        self.by_number: dict[tuple, set[tuple]] = defaultdict(set)  # (boro, number) -> {(street, bbl)}
        for src, df in (("pluto", pluto[["bbl", "address"]]), ("sales", sales[["bbl", "address"]].dropna().drop_duplicates())):
            for b, a in zip(df["bbl"], df["address"]):
                p = parse_address(a)
                if not p:
                    continue
                self.exact[(src, b[0], p.number + p.letter, p.street)].add(b)
                self.loose[(src, b[0], p.number, p.street)][p.letter].add(b)
                self.by_number[(src, b[0], p.number)].add((p.street, b))
        self.zip_of = dict(zip(pluto["bbl"], pluto["zipcode"]))
        self.lot = pluto.set_index("bbl")[["unitsres", "bldgarea", "bldgclass"]]
        # ZIP -> borough, by the most common borough of PLUTO's lots in that ZIP.
        z = pluto.assign(boro=pluto["bbl"].str[0]).dropna(subset=["zipcode"])
        self.zip_boro = z.groupby("zipcode")["boro"].agg(lambda x: x.value_counts().index[0]).to_dict()

    def borough(self, city: str | None, zip_: str | None) -> str | None:
        z = (zip_ or "").strip()[:5]
        if z in self.zip_boro:
            return self.zip_boro[z]
        return "3" if (city or "").strip().upper() == "BROOKLYN" else None

    def _zip_ok(self, bbls: set[str], zip_: str) -> set[str]:
        if not zip_:
            return bbls
        return {b for b in bbls if not self.zip_of.get(b) or str(self.zip_of[b])[:5] == zip_}

    def _street_variants(self, street: str) -> list[str]:
        first, _, rest = street.partition(" ")
        if first in DIRECTION.values() and rest:
            return [rest]
        return [f"{d} {street}" for d in ("N", "S", "E", "W")]

    def match(self, address: str | None, city: str | None, zip_: str | None,
              lead_units: float | None = None, lead_sqft: float | None = None) -> tuple[str | None, Parsed | None, str]:
        p = parse_address(address)
        boro = self.borough(city, zip_)
        if p is None:
            return None, None, "unparsed"
        if boro is None:
            return None, p, "no_borough"
        z = (zip_ or "").strip()[:5]
        # Each step finds lots grouped by the address they sit at. A step that finds lots at more
        # than one address (123A and 123B; North and South 5th St) is ambiguous: the seller gets
        # "not found" rather than a guess (engineering precaution: a wrong lot is worse than none,
        # and a published lot is reused as the cached lot every month after).
        steps = []
        for src in ("pluto", "sales"):
            steps.append((f"{src}", {"": self.exact.get((src, boro, p.number + p.letter, p.street), set())}))
            steps.append((f"{src}_no_letter", self.loose.get((src, boro, p.number, p.street), {})))
        for src in ("pluto", "sales"):
            steps.append((f"{src}_direction", {v: self.exact.get((src, boro, p.number + p.letter, v), set())
                                               | set().union(*self.loose.get((src, boro, p.number, v), {}).values())
                                               for v in self._street_variants(p.street)}))
        for src in ("pluto", "sales"):
            near: dict[str, set[str]] = defaultdict(set)
            for st, b in self.by_number.get((src, boro, p.number), set()):
                if _spelling_twin(st, p.street):
                    near[st].add(b)
            steps.append((f"{src}_spelling", near))
        for how, groups in steps:
            groups = {k: h for k, v in groups.items() if (h := self._zip_ok(v, z))}
            if len(groups) > 1:
                return None, p, how + "_ambiguous"
            if groups:
                hit = next(iter(groups.values()))
                return self.pick(hit, lead_units, lead_sqft), p, how + ("_multi" if len(hit) > 1 else "")
        return None, p, "no_match"

    def pick(self, bbls: set[str], lead_units: float | None, lead_sqft: float | None) -> str:
        """One lot from several at the same address: the closest to the lead's own unit count and
        building size, preferring a 1-4 family home, then the lowest lot number."""
        if len(bbls) == 1:
            return next(iter(bbls))

        def score(b: str):
            r = self.lot.loc[b] if b in self.lot.index else None
            fam = 0 if (r is not None and class_group(r["bldgclass"]) is not None) else 1
            du = abs((r["unitsres"] if r is not None and pd.notna(r["unitsres"]) else 0) - lead_units) if lead_units else 0
            ds = abs(np.log(r["bldgarea"] / lead_sqft)) if (lead_sqft and r is not None and pd.notna(r["bldgarea"]) and r["bldgarea"] > 0) else 0
            return (du, round(ds, 2), fam, b)

        return min(bbls, key=score)


def no_value_reason(pl: pd.Series | None, has_unit: bool) -> str | None:
    """Why a matched lot gets no model value (None = it's a 1-4 family home the model covers)."""
    if pl is None:
        return "not_found"
    cls = (pl.get("bldgclass") or "").upper()
    lot = int(str(pl["bbl"])[6:])
    if class_group(cls) is not None:
        return None
    condo = cls.startswith("R") or 7501 <= lot <= 7599 or pd.notna(pl.get("condono"))
    if condo:
        return "other_property_type" if has_unit else "condo_without_unit"
    units = pl.get("unitsres")
    if cls[:1] in ("C", "D") or (units is not None and np.isfinite(units) and units >= 5):
        return "five_plus_units"
    return "other_property_type"
