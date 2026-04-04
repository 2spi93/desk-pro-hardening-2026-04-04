from __future__ import annotations

import os
from pathlib import Path

SERVICE_NAME = "predictor-v8"
SERVICE_VERSION = "0.1.0"

MODEL_PATH = Path(os.getenv("PREDICTOR_V8_MODEL_PATH", "/workspace/data/predictor_v8/model.json"))
SAMPLES_LOG_PATH = Path(os.getenv("PREDICTOR_V8_SAMPLES_LOG_PATH", "/workspace/data/predictor_v8/samples.jsonl"))
BRAIN_STATE_PATH = Path(os.getenv("PREDICTOR_V8_BRAIN_STATE_PATH", "/workspace/data/predictor_v8/brain-state.json"))
EXPERIENCES_LOG_PATH = Path(os.getenv("PREDICTOR_V8_EXPERIENCES_LOG_PATH", "/workspace/data/predictor_v8/experiences.jsonl"))
FAILURE_LR_CALIBRATION_HISTORY_PATH = Path(os.getenv("PREDICTOR_V8_FAILURE_LR_CALIBRATION_HISTORY_PATH", "/workspace/data/predictor_v8/failure_lr_calibration_history.json"))
REALITY_GAP_STATE_PATH = Path(os.getenv("PREDICTOR_V8_REALITY_GAP_STATE_PATH", "/workspace/data/predictor_v8/reality_gap_state.json"))
KAIROS_FEATURE_FLAGS_PATH = Path(os.getenv("TXT_FEATURE_FLAGS_PATH", "/workspace/config/kairos_feature_flags.json"))

TRAINING_BATCH_SIZE = max(10, int(os.getenv("PREDICTOR_V8_TRAINING_BATCH_SIZE", "50")))
TRAINING_FLUSH_INTERVAL_MS = max(25, int(os.getenv("PREDICTOR_V8_TRAINING_FLUSH_INTERVAL_MS", "50")))
MAX_BUFFER_SIZE = max(TRAINING_BATCH_SIZE, int(os.getenv("PREDICTOR_V8_MAX_BUFFER_SIZE", "5000")))
BRAIN_REPLAY_CAPACITY = max(256, int(os.getenv("PREDICTOR_V8_BRAIN_REPLAY_CAPACITY", "100000")))
BRAIN_BATCH_SIZE = max(16, int(os.getenv("PREDICTOR_V8_BRAIN_BATCH_SIZE", "64")))
BRAIN_MIN_LEARN_BATCH = max(8, int(os.getenv("PREDICTOR_V8_BRAIN_MIN_LEARN_BATCH", "32")))
BRAIN_BOOTSTRAP_EXPERIENCES = max(64, int(os.getenv("PREDICTOR_V8_BRAIN_BOOTSTRAP_EXPERIENCES", "4096")))
FAILURE_LR_CALIBRATION_HISTORY_LIMIT = max(8, int(os.getenv("PREDICTOR_V8_FAILURE_LR_CALIBRATION_HISTORY_LIMIT", "48")))
PREDICTOR_V8_CAUSAL_STRICT_MIN_CONFIDENCE = min(1.0, max(0.0, float(os.getenv("PREDICTOR_V8_CAUSAL_STRICT_MIN_CONFIDENCE", "0.34"))))
PREDICTOR_V8_SAFE_DREAM_MIN_REWARD = max(0.0, float(os.getenv("PREDICTOR_V8_SAFE_DREAM_MIN_REWARD", "0.25")))

MAX_ALLOWED_LATENCY_MS = max(50, int(os.getenv("PREDICTOR_V8_MAX_ALLOWED_LATENCY_MS", "300")))
MAX_ALLOWED_BACKLOG = max(64, int(os.getenv("PREDICTOR_V8_MAX_ALLOWED_BACKLOG", "384")))
MIN_RENDERABLE_ROWS = max(5, int(os.getenv("PREDICTOR_V8_MIN_RENDERABLE_ROWS", "20")))
