"""Extractor tests — the pure heart of the Thread 7 worker.

``extract_figure`` turns a financial profile plus the womblex table cells of a
topic's matched (already-deduped) chunks into one ``ExtractionFigure``:
a currency-normalised amount with provenance, or a description-only fallback when
no currency cell was matched (build plan §1/§6). No I/O — trivially unit-testable.
"""

from __future__ import annotations

from numbatch_financial.extractor import MatchedCell, extract_figure
from numbatch_financial.models import CostBasis, FinancialProfile, LineItemGranularity


def _profile(
    target_currency: str = "AUD",
    granularity: LineItemGranularity = LineItemGranularity.BUNDLE,
) -> FinancialProfile:
    return FinancialProfile(
        topic_id="topic-support",
        name="Support & SLA costs",
        target_currency=target_currency,
        cost_basis=CostBasis.RECURRING,
        granularity=granularity,
    )


def test_bundle_sums_matched_currency_cells_into_one_figure() -> None:
    cells = [
        MatchedCell(elem_order=7, raw_value="$1,200.50", is_currency=True),
        MatchedCell(elem_order=9, raw_value="$300.00", is_currency=True),
        MatchedCell(elem_order=8, raw_value="Annual support", is_currency=False),
    ]

    figure = extract_figure(_profile(), cells, fallback_text="Support costs")

    assert figure.amount == 1500.50
    assert figure.currency == "AUD"
    # Provenance points at the first matched currency cell, in document order.
    assert figure.source_elem_order == 7


def test_line_item_takes_the_first_currency_cell_not_the_sum() -> None:
    cells = [
        MatchedCell(elem_order=9, raw_value="$300.00", is_currency=True),
        MatchedCell(elem_order=7, raw_value="$1,200.50", is_currency=True),
    ]

    figure = extract_figure(
        _profile(granularity=LineItemGranularity.LINE_ITEM),
        cells,
        fallback_text="Support costs",
    )

    # Ordered by elem_order: the first line item's figure, with its provenance.
    assert figure.amount == 1200.50
    assert figure.source_elem_order == 7


def test_no_currency_cell_falls_back_to_description() -> None:
    cells = [
        MatchedCell(elem_order=4, raw_value="Priced on application", is_currency=False),
    ]

    figure = extract_figure(
        _profile(),
        cells,
        fallback_text="Priced on application; see section 4.",
    )

    assert figure.amount is None
    assert figure.currency is None
    assert figure.description == "Priced on application; see section 4."
    assert figure.source_elem_order is None


def test_no_matched_cells_at_all_falls_back_to_description() -> None:
    figure = extract_figure(_profile(), [], fallback_text="No costing provided.")

    assert figure.amount is None
    assert figure.description == "No costing provided."


def test_unparseable_currency_cells_are_ignored() -> None:
    cells = [
        MatchedCell(elem_order=5, raw_value="TBC", is_currency=True),
        MatchedCell(elem_order=6, raw_value="$500.00", is_currency=True),
    ]

    figure = extract_figure(_profile(), cells, fallback_text="Support costs")

    assert figure.amount == 500.00
    assert figure.source_elem_order == 6


def test_description_is_always_populated_even_with_a_figure() -> None:
    cells = [MatchedCell(elem_order=7, raw_value="$1,200.50", is_currency=True)]

    figure = extract_figure(_profile(), cells, fallback_text="Annual support fee")

    assert figure.amount == 1200.50
    assert figure.description == "Annual support fee"
