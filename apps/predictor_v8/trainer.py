from __future__ import annotations

import asyncio
from typing import Any

from .config import MAX_BUFFER_SIZE, TRAINING_BATCH_SIZE, TRAINING_FLUSH_INTERVAL_MS
from .storage import append_jsonl


class Trainer:
    def __init__(self, model: Any, samples_log_path: Any, save_model_cb: Any) -> None:
        self.model = model
        self.samples_log_path = samples_log_path
        self.save_model_cb = save_model_cb
        self.buffer: list[dict[str, Any]] = []
        self.lock = asyncio.Lock()

    async def add_samples(self, items: list[dict[str, Any]]) -> int:
        accepted = 0
        async with self.lock:
          for item in items:
                if not isinstance(item, dict):
                    continue
                self.buffer.append(item)
                accepted += 1
          if len(self.buffer) > MAX_BUFFER_SIZE:
                del self.buffer[:-MAX_BUFFER_SIZE]
        return accepted

    async def loop(self) -> None:
        while True:
            await asyncio.sleep(TRAINING_FLUSH_INTERVAL_MS / 1000.0)
            batch: list[dict[str, Any]] = []
            async with self.lock:
                if len(self.buffer) >= TRAINING_BATCH_SIZE:
                    batch = self.buffer[:TRAINING_BATCH_SIZE]
                    self.buffer = self.buffer[TRAINING_BATCH_SIZE:]
            if not batch:
                continue
            append_jsonl(self.samples_log_path, batch)
            for item in batch:
                ctx = item.get("features") if isinstance(item.get("features"), dict) else {}
                label = float(item.get("label") or 0.0)
                self.model.update(ctx, label)
            self.save_model_cb()

    async def pending_count(self) -> int:
        async with self.lock:
            return len(self.buffer)
