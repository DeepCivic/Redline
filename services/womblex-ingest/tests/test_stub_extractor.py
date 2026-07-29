"""Tests for the built-in deterministic (non-womblex) extractor.

The stub path is what the Isaacus-optional / air-gap mode leans on and
what the Thread 3 exit test exercises when the real womblex dependency is absent.
"""

from __future__ import annotations

from womblex_ingest.extraction import StubWomblexExtractor


def test_stub_emits_a_manifest_and_a_shard_pair_per_document() -> None:
    extractor = StubWomblexExtractor()

    result = extractor.extract("eval-1", ["one.pdf", "two.pdf"])

    assert result.document_count == 2
    filenames = sorted(shard.filename for shard in result.shards)
    # The embeddings shard is a *sibling* of the elements shard, mirroring the
    # layout womblex's embed stage writes (ADR-0014).
    assert filenames == [
        "_manifest.parquet",
        "one.pdf.elements.parquet",
        "one.pdf.embeddings.parquet",
        "two.pdf.elements.parquet",
        "two.pdf.embeddings.parquet",
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


def test_stub_emits_a_json_read_model_per_document() -> None:
    extractor = StubWomblexExtractor()

    result = extractor.extract("eval-1", ["one.pdf", "two.pdf"])

    assert len(result.documents) == 2
    for document in result.documents:
        # documentId is a womblex-style source_hash, and chunk ids are derived
        # from it ("{source_hash}:{chunk_index}").
        assert document.documentId
        assert document.chunks[0].chunkId == f"{document.documentId}:0"
        assert document.chunks[0].documentId == document.documentId
        assert all(e.documentId == document.documentId for e in document.elements)
        assert document.tableCells[0].isCurrency is True


def test_stub_read_model_is_deterministic() -> None:
    extractor = StubWomblexExtractor()

    first = extractor.extract("eval-1", ["one.pdf"])
    second = extractor.extract("eval-1", ["one.pdf"])

    assert first.documents[0].to_json() == second.documents[0].to_json()


def test_stub_emits_embeddings_joined_to_its_own_chunks() -> None:
    extractor = StubWomblexExtractor()

    result = extractor.extract("eval-1", ["one.pdf", "two.pdf"])

    assert len(result.embeddings) == 2
    for document, embeddings in zip(result.documents, result.embeddings):
        assert embeddings.documentId == document.documentId
        assert [v.chunkId for v in embeddings.vectors] == [
            chunk.chunkId for chunk in document.chunks
        ]
        assert all(len(v.values) == embeddings.dimensions for v in embeddings.vectors)


def test_stub_embeds_the_same_chunk_to_the_same_vector() -> None:
    # Content-addressed identity: re-ingesting unchanged content must yield the
    # same vector, or a captured fixture drifts between runs.
    extractor = StubWomblexExtractor()

    first = extractor.extract("eval-1", ["one.pdf"])
    second = extractor.extract("eval-1", ["one.pdf"])

    assert first.embeddings[0].to_json() == second.embeddings[0].to_json()


def test_stub_embeds_different_chunks_to_different_vectors() -> None:
    extractor = StubWomblexExtractor()

    result = extractor.extract("eval-1", ["one.pdf", "two.pdf"])

    assert result.embeddings[0].vectors[0].values != result.embeddings[1].vectors[0].values
