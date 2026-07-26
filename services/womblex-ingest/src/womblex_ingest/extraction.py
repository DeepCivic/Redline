"""The womblex extraction seam.

`Extractor` is the protocol the API depends on. Two implementations exist:

- `StubWomblexExtractor` — deterministic, dependency-free shards. This is the
  default and is what runs in air-gapped / no-womblex environments and in the
  Thread 3 exit test.
- `RealWomblexExtractor` — invokes the actual womblex pipeline. Imported lazily
  (inside `build_extractor`) so the heavy dependency is only required when
  `WOMBLEX_MODE=real`.

Every `ExtractionResult` carries both the durable Parquet `shards` and a JSON
`documents` read model (see `records.py`). Thread 4 locks build-plan §8 decision
#2 on the side of a JSON seam: this service reads its own Parquet and serves JSON,
so the TypeScript adapter (`redline-adapters`) never links a Parquet reader.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import List, Protocol

from womblex_ingest.records import (
    ChunkRecord,
    DocumentEmbeddings,
    DocumentExtraction,
    ElementRecord,
    EmbeddingRecord,
    TableCellRecord,
    make_document_embeddings,
)

# The stub's embedding space. Small enough that a fixture stays readable, and
# named so a consumer can tell stub vectors from a real model's at the seam —
# vectors from different models are incomparable (ADR-0014).
STUB_EMBEDDING_MODEL = "stub-deterministic-v1"
STUB_EMBEDDING_DIMENSIONS = 8


@dataclass(frozen=True)
class Shard:
    """One Parquet shard womblex would write for a run.

    `filename` is the object key *suffix*; the storage layer prepends the
    `proc/{evaluationId}/` prefix so this stays transport-agnostic.
    """

    filename: str
    body: bytes
    content_type: str = "application/octet-stream"


@dataclass(frozen=True)
class ExtractionResult:
    document_count: int
    shards: List[Shard]
    # The JSON read model, keyed by documentId. This is what the Parquet→JSON
    # boundary serves to the TS adapter (Thread 4 decision #2); the Parquet
    # `shards` remain the durable MinIO record.
    documents: List[DocumentExtraction] = field(default_factory=list)
    # The embeddings sibling (ADR-0014). Empty when the embed stage did not run,
    # which is a legitimate outcome, not a failure: the extraction still serves
    # and only the embeddings resource reports NOT_FOUND.
    embeddings: List[DocumentEmbeddings] = field(default_factory=list)


class Extractor(Protocol):
    def extract(self, evaluation_id: str, document_names: List[str]) -> ExtractionResult: ...


class StubWomblexExtractor:
    """Deterministic stand-in producing the shard *shape* womblex emits.

    Emits the Parquet shard layout plus the JSON read model the Parquet→JSON
    boundary serves, without the heavy womblex/Isaacus stack — so the sidecar's
    HTTP + storage behaviour and the Thread 4 adapter contract are both provable
    end-to-end offline.
    """

    def extract(self, evaluation_id: str, document_names: List[str]) -> ExtractionResult:
        shards: List[Shard] = [
            Shard(
                filename="_manifest.parquet",
                body=self._deterministic_body("manifest", evaluation_id, document_names),
            )
        ]
        documents: List[DocumentExtraction] = []
        embeddings: List[DocumentEmbeddings] = []
        for name in document_names:
            shards.append(
                Shard(
                    filename=f"{name}.elements.parquet",
                    body=self._deterministic_body("elements", evaluation_id, [name]),
                )
            )
            document = self._document(evaluation_id, name)
            documents.append(document)
            shards.append(
                Shard(
                    filename=f"{name}.embeddings.parquet",
                    body=self._deterministic_body("embeddings", evaluation_id, [name]),
                )
            )
            embeddings.append(self._embeddings(document))
        return ExtractionResult(
            document_count=len(document_names),
            shards=shards,
            documents=documents,
            embeddings=embeddings,
        )

    def _embeddings(self, document: DocumentExtraction) -> DocumentEmbeddings:
        """One deterministic vector per chunk, joined on the chunk's own id.

        Derived from `chunkId` so the same chunk always embeds to the same
        vector — the content-addressed property the lens relies on — and so a
        fixture captured from this stub is stable across runs.
        """
        return make_document_embeddings(
            document_id=document.documentId,
            model=STUB_EMBEDDING_MODEL,
            vectors=[
                EmbeddingRecord(
                    chunkId=chunk.chunkId,
                    chunkIndex=index,
                    values=self._deterministic_vector(chunk.chunkId),
                )
                for index, chunk in enumerate(document.chunks)
            ],
        )

    @staticmethod
    def _deterministic_vector(chunk_id: str) -> List[float]:
        # Chunk and query vectors share one hashing scheme so they share a space
        # (embedding.py). The chunk keys on its id, a query on its text; both go
        # through `embedding|{key}`, so this reproduces the pre-20a bytes exactly.
        from womblex_ingest.embedding import _deterministic_vector

        return _deterministic_vector(chunk_id, STUB_EMBEDDING_DIMENSIONS)

    def _document(self, evaluation_id: str, name: str) -> DocumentExtraction:
        """A deterministic read model whose documentId is a stable `source_hash`.

        The stub does not run womblex; it emits the *shape* the JSON seam serves
        so the Thread 4 adapter's contract test has a real run to read.
        """
        document_id = self._source_hash(evaluation_id, name)
        elements = [
            ElementRecord(
                documentId=document_id,
                elementOrder=0,
                page=1,
                text=f"{name}: heading",
            ),
            ElementRecord(
                documentId=document_id,
                elementOrder=1,
                page=1,
                text=f"{name}: body paragraph",
            ),
        ]
        chunks = [
            ChunkRecord(
                chunkId=f"{document_id}:0",
                documentId=document_id,
                text=f"{name}: chunk 0",
            )
        ]
        table_cells = [
            TableCellRecord(
                documentId=document_id,
                elementOrder=2,
                page=1,
                rowIndex=0,
                columnIndex=1,
                rawValue="80000",
                isCurrency=True,
            )
        ]
        return DocumentExtraction(
            documentId=document_id,
            elements=elements,
            chunks=chunks,
            tableCells=table_cells,
        )

    @staticmethod
    def _source_hash(evaluation_id: str, name: str) -> str:
        seed = "|".join(["source_hash", evaluation_id, name]).encode()
        return hashlib.sha256(seed).hexdigest()[:16]

    @staticmethod
    def _deterministic_body(kind: str, evaluation_id: str, names: List[str]) -> bytes:
        seed = "|".join([kind, evaluation_id, *names]).encode()
        return hashlib.sha256(seed).digest()


def build_extractor(mode: str, *, storage=None, bucket: str = "redline") -> Extractor:
    if mode == "real":
        # Imported lazily so `pip install womblex`/pyarrow is only required in real
        # mode. The real extractor reads the womblex pod's shards (Thread 37a) from
        # object storage, so it needs the same storage handle + bucket the API
        # writes JSON through (Thread 37b).
        from womblex_ingest.real_extractor import RealWomblexExtractor

        if storage is None:
            raise ValueError(
                "real mode needs an ObjectStorage to read the womblex pod's shards; "
                "pass storage= (build_app_from_env wires it from Settings)"
            )
        return RealWomblexExtractor(storage, bucket)
    return StubWomblexExtractor()
