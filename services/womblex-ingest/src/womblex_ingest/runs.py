"""In-memory run registry.

The sidecar runs extraction synchronously within the request (womblex on a small
document set is fast enough for the review flow, and this keeps Thread 3
dependency-free). `status` therefore reports terminal states; a queue/worker split
is a later concern if runs grow long. State is process-local and non-durable —
acceptable because MinIO is the durable record of a run's output.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional

RunStatus = Literal["running", "succeeded", "failed"]


@dataclass
class Run:
    run_id: str
    evaluation_id: str
    status: RunStatus
    document_count: int = 0
    shard_keys: List[str] = field(default_factory=list)
    error_message: Optional[str] = None


class RunRegistry:
    def __init__(self) -> None:
        self._runs: Dict[str, Run] = {}

    def start(self, evaluation_id: str) -> Run:
        run = Run(run_id=str(uuid.uuid4()), evaluation_id=evaluation_id, status="running")
        self._runs[run.run_id] = run
        return run

    def mark_succeeded(self, run_id: str, document_count: int, shard_keys: List[str]) -> None:
        run = self._runs[run_id]
        run.status = "succeeded"
        run.document_count = document_count
        run.shard_keys = shard_keys

    def mark_failed(self, run_id: str, error_message: str) -> None:
        run = self._runs[run_id]
        run.status = "failed"
        run.error_message = error_message

    def get(self, run_id: str) -> Optional[Run]:
        return self._runs.get(run_id)
