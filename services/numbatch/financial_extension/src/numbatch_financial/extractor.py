"""The pure extraction logic — no I/O, so it is trivially unit-testable.

Given a topic's :class:`FinancialProfile` and the womblex table cells of that
topic's matched (already-deduped) chunks, produce one
:class:`~numbatch_financial.extraction_repository.ExtractionFigure`:

- a currency-normalised ``amount`` with provenance to womblex's ``elem_order``,
  when at least one matched cell carries a parseable currency value, or
- a description-only fallback (``amount``/``currency`` = ``None``) when none does
  — the "dollar estimate OR a short description of costs" rule (build plan §1).

``granularity`` decides whether a *bundle* sums the matched currency cells into
one total, or a *line item* takes the first (lowest ``elem_order``) figure.
Numbatch already guarantees a chunk feeds a topic at most once, so the caller
passes the deduped matched set and there is no re-extraction per requirement
(build plan §6).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .extraction_repository import ExtractionFigure
from .models import FinancialProfile, LineItemGranularity

# Strips grouping separators and any currency symbol/code so "$1,200.50",
# "AUD 1200.50" and "1200.50" all parse to the same Decimal-safe float. A cell
# that carries no digits (e.g. "TBC") yields no figure and is ignored.
_NON_NUMERIC = re.compile(r"[^0-9.]")


@dataclass(frozen=True)
class MatchedCell:
    """One womblex table cell from a topic's matched chunk.

    ``elem_order`` is womblex's provenance key; ``is_currency`` is the sidecar's
    currency-typing (``TableCellRecord.isCurrency``). Only currency cells with a
    parseable value contribute to the figure.
    """

    elem_order: int
    raw_value: str
    is_currency: bool


def _parse_amount(raw_value: str) -> float | None:
    cleaned = _NON_NUMERIC.sub("", raw_value)
    if not cleaned or cleaned == ".":
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def extract_figure(
    profile: FinancialProfile,
    matched_cells: list[MatchedCell],
    fallback_text: str,
) -> ExtractionFigure:
    parseable = [
        (cell.elem_order, amount)
        for cell in sorted(matched_cells, key=lambda cell: cell.elem_order)
        if cell.is_currency and (amount := _parse_amount(cell.raw_value)) is not None
    ]

    if not parseable:
        return ExtractionFigure(
            amount=None,
            currency=None,
            description=fallback_text,
            source_elem_order=None,
        )

    first_elem_order, first_amount = parseable[0]
    if profile.granularity == LineItemGranularity.LINE_ITEM:
        amount = first_amount
    else:
        amount = sum(amount for _, amount in parseable)

    return ExtractionFigure(
        amount=round(amount, 2),
        currency=profile.target_currency,
        description=fallback_text,
        source_elem_order=first_elem_order,
    )
