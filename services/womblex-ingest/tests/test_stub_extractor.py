"""Tests for the built-in deterministic (non-womblex) extractor.

The stub path is what the Isaacus-optional / air-gap mode (Thread 15) leans on and
what the Thread 3 exit test exercises when the real womblex dependency is absent.
"""

from __future__ import annotations

from womblex_ingest.extraction import StubWomblexExtractor


def test_stub_emits_a_manifest_and_one_elements_shard_per_document() -> None:
    extractor = StubWomblexExtractor()

    result = extractor.extract("eval-1", ["one.pdf", "two.pdf"])

    assert result.document_count == 2
    filenames = sorted(shard.filename for shard in result.shards)
    assert filenames == [
        "_manifest.parquet",
        "one.pdf.elements.parquet",
        "two.pdf.elements.parquet",
    ]


def test_stub_is_deterministic_for_the_same_input() -> None:
    extractor = StubWomblexExtractor()

    first = extractor.extract("eval-1", ["one.pdf"])
    second = extractor.extract("eval-1", ["one.pdf"])

    first_bodies = {shard.filename: shard.body for shard in first.shards}
    second_bodies = {shard.filename: shard.body for shard in second.shards}
    assert first_bodies == second_bodies


def test_stub_shards_are_non_empty() -> None:
    extractor = StubWomblexExtractor()

    result = extractor.extract("eval-1", ["one.pdf"])

    assert all(len(shard.body) > 0 for shard in result.shards)
