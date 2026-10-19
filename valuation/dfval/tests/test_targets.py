import pandas as pd

from valuation.dfval.targets import AddressIndex, no_value_reason, parse_address


def test_parse_address_variants():
    p = parse_address("6120 Sample Ave")
    assert (p.number, p.letter, p.street, p.unit) == ("6120", "", "SAMPLE AVE", None)
    assert parse_address("61-20 SAMPLE AVENUE").number == "6120"  # Queens hyphenated numbers
    p = parse_address("123A Example St # 4")
    assert (p.number, p.letter, p.street, p.unit) == ("123", "A", "EXAMPLE ST", "4")
    assert parse_address("12 Example Street, Apt 3F").unit == "3F"
    assert parse_address("100 East 18th Street").street == "E 18 ST"
    assert parse_address("100 E 18 ST").street == "E 18 ST"
    assert parse_address("40 Mac Donough St").street == "MACDONOUGH ST"
    assert parse_address("40 MacDonough Street").street == "MACDONOUGH ST"
    assert parse_address("7 Saint Marks Pl").street == "ST MARKS PL"
    assert parse_address("12 A Street").letter == ""  # a street named A, not house 12A
    assert parse_address("100 E 18th St").street == "E 18 ST" and parse_address("100 E 18th St").letter == ""
    assert parse_address("") is None and parse_address(None) is None and parse_address("Example Street") is None


def _index():
    pluto = pd.DataFrame({
        "bbl": ["3010000001", "3010000002", "3020000001", "3020000002", "3030000001", "3030000002", "4040000001"],
        "address": ["100 EXAMPLE STREET", "102 EXAMPLE STREET", "50 SOUTH 5 STREET", "50 5 STREET", "200 SAMPLE AVENUE", "200 SAMPLE AVENUE",
                    "59-14 DEMO AVENUE"],
        "zipcode": ["11216", "11216", "11211", "11215", "11221", "11221", "11385"],
        "unitsres": [2, 2, 3, 3, 1, 3, 2], "bldgarea": [2400, 2400, 3000, 3000, 900, 3300, 2200],
        "bldgclass": ["B1", "B1", "C0", "C0", "A1", "C0", "B2"],
    })
    sales = pd.DataFrame({"bbl": ["3010000002"], "address": ["104 EXAMPLE STREET"]})  # a second address of lot 2, known from a sale
    return AddressIndex(pluto, sales)


def test_match_exact_hyphen_and_sales_address():
    ix = _index()
    assert ix.match("100 Example St", "Brooklyn", "11216")[0] == "3010000001"
    assert ix.match("5914 Demo Ave", "Ridgewood", "11385")[0] == "4040000001"
    bbl, _, how = ix.match("104 Example St", "Brooklyn", "11216")
    assert (bbl, how) == ("3010000002", "sales")


def test_zip_decides_between_same_named_streets():
    ix = _index()
    # "50 5 St" exists in 11215; in 11211 the lead means South 5th Street.
    assert ix.match("50 5th St", "Brooklyn", "11211")[0] == "3020000001"
    assert ix.match("50 5th St", "Brooklyn", "11215")[0] == "3020000002"


def test_one_letter_spelling_and_unmatched():
    ix = _index()
    assert ix.match("100 Exampel St", "Brooklyn", "11216")[0] is None  # two letters swapped: not a one-letter change
    assert ix.match("100 Exmple St", "Brooklyn", "11216")[0] == "3010000001"
    assert ix.match("999 Nowhere St", "Brooklyn", "11216")[0] is None


def test_several_lots_at_one_address_use_the_leads_facts():
    ix = _index()
    assert ix.match("200 Sample Ave", "Brooklyn", "11221", lead_units=3, lead_sqft=3300)[0] == "3030000002"
    assert ix.match("200 Sample Ave", "Brooklyn", "11221", lead_units=1, lead_sqft=900)[0] == "3030000001"


def test_no_value_reasons():
    row = lambda cls, lot="0001", units=2, condo=None: pd.Series({"bbl": "301000" + lot, "bldgclass": cls, "unitsres": units, "condono": condo})  # noqa: E731
    assert no_value_reason(None, False) == "not_found"
    assert no_value_reason(row("B1"), False) is None
    assert no_value_reason(row("C3", units=4), False) is None
    assert no_value_reason(row("C1", units=8), False) == "five_plus_units"
    assert no_value_reason(row("D4", units=40), False) == "five_plus_units"
    assert no_value_reason(row("R4", lot="7501", units=9, condo="1"), False) == "condo_without_unit"
    assert no_value_reason(row("R4", lot="7501", units=9, condo="1"), True) == "other_property_type"
    assert no_value_reason(row("G1", units=0), False) == "other_property_type"
