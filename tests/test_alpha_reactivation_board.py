from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "alpha_reactivation_board.py"

# Pin the recency window to just after the fixtures below so these tests are
# deterministic regardless of wall-clock time (fixtures are dated 2026-06-05).
FIXED_NOW = datetime(2026, 6, 5, 12, 0, 0, tzinfo=timezone.utc)


def _load_module():
    spec = importlib.util.spec_from_file_location("alpha_reactivation_board", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class AlphaReactivationBoardTests(unittest.TestCase):
    def test_board_next_action_is_fill_when_ack_outcome_gap_exist(self) -> None:
        mod = _load_module()
        proof_payload = {
            "ack": [{"broker_ticket": "a1", "created_at": "2026-06-05T10:00:00+00:00"}],
            "fill": [],
            "outcome": [{"decision_id": "o1", "created_at": "2026-06-05T10:00:00+00:00"}],
            "gap": [{"decision_id": "g1", "created_at": "2026-06-05T10:00:00+00:00"}],
        }

        board = mod.build_board(proof_payload=proof_payload, money_rows=[], window_hours=720, alpha_days=30, now=FIXED_NOW)

        self.assertEqual(board["status"], "ALPHA_REACTIVATION_PENDING")
        self.assertEqual(board["next"]["id"], "FILL")
        self.assertEqual(board["alpha_v2"]["status"], "ALPHA_V2_BLOCKED")
        self.assertIn("real_100_required", board["alpha_v2"]["missing"])
        self.assertIn("active_20d_required", board["alpha_v2"]["missing"])
        self.assertIn("profit_factor_gt_1_required", board["alpha_v2"]["missing"])
        self.assertEqual(board["alpha_v2"]["first_engine"], "Alpha Attribution Engine")
        self.assertEqual(board["alpha_v2"]["summit_objective"], "Beat the market with sustained real-money alpha")
        self.assertIn("alpha-decay guard", board["alpha_v2"]["survival_rule"])

    def test_board_marks_alpha_done_only_after_real_trades_and_positive_metrics(self) -> None:
        mod = _load_module()
        proof_payload = {
            "ack": [{"broker_ticket": "d1", "created_at": "2026-06-05T10:00:00+00:00"}],
            "fill": [{"decision_id": "d1", "venue": "mt5", "notional_usd": 5, "filled_at": "2026-06-05T10:00:01+00:00"}],
            "outcome": [{"decision_id": "d1", "created_at": "2026-06-05T10:00:02+00:00"}],
            "gap": [{"decision_id": "d1", "created_at": "2026-06-05T10:00:03+00:00"}],
        }
        money_rows = [
            {"venue": "mt5", "strategy_id": "alpha", "requested_notional_usd": 10, "pnl_usd_5m": 1.0}
            for _ in range(60)
        ] + [
            {"venue": "mt5", "strategy_id": "alpha", "requested_notional_usd": 10, "pnl_usd_5m": -0.2}
            for _ in range(10)
        ]

        board = mod.build_board(proof_payload=proof_payload, money_rows=money_rows, window_hours=720, alpha_days=30, now=FIXED_NOW)

        self.assertEqual(board["status"], "ALPHA_REACTIVATION_PENDING")
        alpha_row = next(row for row in board["rows"] if row["id"] == "ALPHA_30D")
        self.assertEqual(alpha_row["status"], "DONE")
        self.assertEqual(board["next"]["id"], "REAL_100")
        self.assertEqual(board["alpha_v2"]["status"], "ALPHA_V2_BLOCKED")
        self.assertEqual(board["alpha_v2"]["real_trades"], 70)

    def test_alpha_v2_gate_stays_blocked_for_100_single_active_day_real_trades(self) -> None:
        mod = _load_module()
        proof_payload = {
            "ack": [{"broker_ticket": "d1", "created_at": "2026-06-05T10:00:00+00:00"}],
            "fill": [{"decision_id": "d1", "venue": "mt5", "notional_usd": 5, "filled_at": "2026-06-05T10:00:01+00:00"}],
            "outcome": [{"decision_id": "d1", "created_at": "2026-06-05T10:00:02+00:00"}],
            "gap": [{"decision_id": "d1", "created_at": "2026-06-05T10:00:03+00:00"}],
        }
        money_rows = [
            {
                "venue": "mt5",
                "strategy_id": "alpha",
                "requested_notional_usd": 10,
                "pnl_usd_5m": 1.0,
                "ts_fill_final": "2026-06-05T10:00:00+00:00",
            }
            for _ in range(100)
        ]

        board = mod.build_board(proof_payload=proof_payload, money_rows=money_rows, window_hours=720, alpha_days=30, now=FIXED_NOW)

        self.assertEqual(board["alpha_v2"]["status"], "ALPHA_V2_BLOCKED")
        self.assertIn("active_20d_required", board["alpha_v2"]["missing"])
        self.assertEqual(board["alpha_v2"]["real_trades"], 100)
        self.assertEqual(board["alpha_v2"]["active_days"], 1)

    def test_alpha_v2_gate_opens_only_after_100_real_trades_20_active_days_and_pf_gt_1(self) -> None:
        mod = _load_module()
        proof_payload = {
            "ack": [{"broker_ticket": "d1", "created_at": "2026-06-05T10:00:00+00:00"}],
            "fill": [{"decision_id": "d1", "venue": "mt5", "notional_usd": 5, "filled_at": "2026-06-05T10:00:01+00:00"}],
            "outcome": [{"decision_id": "d1", "created_at": "2026-06-05T10:00:02+00:00"}],
            "gap": [{"decision_id": "d1", "created_at": "2026-06-05T10:00:03+00:00"}],
        }
        money_rows = [
            {
                "venue": "mt5",
                "strategy_id": "alpha",
                "requested_notional_usd": 10,
                "pnl_usd_5m": 1.0,
                "ts_fill_final": f"2026-05-{day:02d}T10:00:00+00:00",
            }
            for day in range(1, 21)
            for _ in range(5)
        ]

        board = mod.build_board(proof_payload=proof_payload, money_rows=money_rows, window_hours=720, alpha_days=30, now=FIXED_NOW)

        self.assertEqual(board["status"], "ALPHA_REACTIVATED")
        self.assertEqual(board["alpha_v2"]["status"], "ALPHA_V2_READY")
        self.assertIsNone(board["alpha_v2"]["blocked_reason"])
        self.assertEqual(board["alpha_v2"]["active_days"], 20)
        self.assertGreater(board["alpha_v2"]["profit_factor"], 1.0)
        self.assertEqual(
            board["alpha_v2"]["engine_order"][:7],
            [
                "Alpha Attribution Engine",
                "Capital Allocation Engine",
                "Opportunity Cost Engine",
                "Strategy Competition Engine",
                "Opportunity Engine",
                "Regime Switching Engine V2",
                "Alpha Decay Engine",
            ],
        )
        self.assertEqual(
            board["alpha_v2"]["deferred_complexity"],
            [
                "Advanced Sentiment",
                "Geopolitics",
                "Macro News",
                "LLM Trading",
                "RL Trading",
                "Advanced Self-Evolution",
            ],
        )
        self.assertEqual(board["alpha_v2"]["post_real_100_audits"], ["Latency Audit", "Refusal Audit", "Attribution Audit"])

    def test_cli_check_fails_for_missing_fill(self) -> None:
        proof_payload = {
            "ack": [{"broker_ticket": "a1", "created_at": "2026-06-05T10:00:00+00:00"}],
            "fill": [],
            "outcome": [],
            "gap": [],
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            proof_path = Path(tmpdir) / "proof.json"
            labels_path = Path(tmpdir) / "labels.jsonl"
            proof_path.write_text(json.dumps(proof_payload), encoding="utf-8")
            labels_path.write_text("", encoding="utf-8")

            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--proof-json",
                    str(proof_path),
                    "--labels",
                    str(labels_path),
                    "--check",
                    "fill",
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

        self.assertEqual(result.returncode, 2)
        self.assertIn("NEXT FILL", result.stdout)
        self.assertIn("ALPHA_V2_GATE: status=ALPHA_V2_BLOCKED", result.stdout)
        self.assertIn("ALPHA_V2_OBJECTIVE: Beat the market with sustained real-money alpha", result.stdout)
        self.assertIn("failed_checks=fill", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_cli_alpha_v2_check_fails_before_100_real_trades(self) -> None:
        proof_payload = {
            "ack": [{"broker_ticket": "d1", "created_at": "2026-06-05T10:00:00+00:00"}],
            "fill": [{"decision_id": "d1", "venue": "mt5", "notional_usd": 5, "filled_at": "2026-06-05T10:00:01+00:00"}],
            "outcome": [{"decision_id": "d1", "created_at": "2026-06-05T10:00:02+00:00"}],
            "gap": [{"decision_id": "d1", "created_at": "2026-06-05T10:00:03+00:00"}],
        }
        rows = [
            {
                "venue": "mt5",
                "strategy_id": "alpha",
                "requested_notional_usd": 10,
                "pnl_usd_5m": 1.0,
                "ts_fill_final": "2026-06-05T10:00:00+00:00",
            }
            for _ in range(99)
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            proof_path = Path(tmpdir) / "proof.json"
            labels_path = Path(tmpdir) / "labels.jsonl"
            proof_path.write_text(json.dumps(proof_payload), encoding="utf-8")
            labels_path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")

            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--proof-json",
                    str(proof_path),
                    "--labels",
                    str(labels_path),
                    "--check",
                    "alpha-v2",
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

        self.assertEqual(result.returncode, 2)
        self.assertIn("ALPHA_V2_GATE: status=ALPHA_V2_BLOCKED", result.stdout)
        self.assertIn("active_20d_required", result.stdout)
        self.assertIn("failed_checks=alpha-v2", result.stdout)
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
