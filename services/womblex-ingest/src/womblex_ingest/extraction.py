"""The womblex extraction seam.

`Extractor` is the protocol the API depends on. Two implementations exist:

- `StubWomblexExtractor` — deterministic, dependency-free shards. This is the
  default and is what runs in air-gapped / no-womblex environments and in the
  Thread 3 exit test.
- `RealWomblexExtractor` — invokes the actual womblex pipeline. Imported lazily
  (inside `build_extractor`) so the heavy dependency is only required when
  `WOMBLEX_MODE=real`.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import List, Protocol


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


class Extractor(Protocol):
    def extract(self, evaluation_id: str, document_names: List[str]) -> ExtractionResult: ...


class StubWomblexExtractor:
    """Deterministic stand-in producing the shard *shape* womblex emits.

    We do not fake the full Parquet schema here — Thread 4 owns the real
    Parquet/JSON boundary. The stub exists so the sidecar's HTTP + storage
    behaviour is provable end-to-end without the heavy womblex/Isaacus stack.
    """

    def extract(self, evaluation_id: str, document_names: List[str]) -> ExtractionResult:
        shards: List[Shard] = [
            Shard(
                filename="_manifest.parquet",
                body=self._deterministic_body("manifest", evaluation_id, document_names),
            )
        ]
        for name in document_names:
            shards.append(
                Shard(
                    filename=f"{name}.elements.parquet",
                    body=self._deterministic_body("elements", evaluation_id, [name]),
                )
            )
        return ExtractionResult(document_count=len(document_names), shards=shards)

    @staticmethod
    def _deterministic_body(kind: str, evaluation_id: str, names: List[str]) -> bytes:
        seed = "|".join([kind, evaluation_id, *names]).encode()
        return hashlib.sha256(seed).digest()


def build_extractor(mode: str) -> Extractor:
    if mode == "real":
        # Imported lazily so `pip install womblex` is only required in real mode.
        from womblex_ingest.real_extractor import RealWomblexExtractor

        return RealWomblexExtractor()
    return StubWomblexExtractor()
