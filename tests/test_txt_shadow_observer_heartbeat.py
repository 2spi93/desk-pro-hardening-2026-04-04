from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_shadow_observer_heartbeat.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_shadow_observer_heartbeat", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


NOW = datetime(2026, 7, 4, 12, 0, 0, tzinfo=timezone.utc)


def _row(
    scan_at: datetime,
    *,
    decision: str = "OPPORTUNITY",
    strategy: str = "liquidity_confirmed_momentum",
    side: str = "buy",
    regime: str = "BREAKOUT",
    lcb: float = 12.5,
) -> dict:
    return {
        "decision": decision,
        "status": decision,
        "scan_at": scan_at.isoformat(),
        "selected_strategy_id": strategy if decision == "OPPORTUNITY" else None,
        "side": side if decision == "OPPORTUNITY" else None,
        "market_regime": regime,
        "edge_lower_confidence_bound_bps": lcb if decision == "OPPORTUNITY" else None,
        "net_expected_edge_bps": lcb + 1.5 if decision == "OPPORTUNITY" else None,
        "venue_basis_bps": -2.1,
        "snapshot_digest": f"digest-{scan_at.timestamp()}",
        "latest_bar_at": scan_at.strftime("%Y-%m-%d %H:%M:00+00:00"),
    }


def _append(path: Path, rows: list[dict], *, newline_end: bool = True) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for index, row in enumerate(rows):
            handle.write(json.dumps(row, sort_keys=True))
            if newline_end or index < len(rows) - 1:
                handle.write("\n")


class TxtShadowObserverHeartbeatAlertTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = _load_module()
        self.tmpdir = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmpdir.name)
        self.jsonl = self.dir / "run.jsonl"
        self.alert = self.dir / "alert.json"

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _pass(self, state: dict, *, now: datetime = NOW, run_id: str = "run-A") -> tuple[dict, str, str | None]:
        return self.mod.process_episode_alerts(
            now=now, run_id=run_id, jsonl_path=self.jsonl, state=state, alert_path=self.alert
        )

    def test_fresh_opportunity_opens_alert_with_passive_contract(self) -> None:
        _append(self.jsonl, [_row(NOW - timedelta(seconds=60))])
        state, action, episode_key = self._pass({})

        self.assertEqual(action, "opened")
        self.assertIsNotNone(episode_key)
        alert = json.loads(self.alert.read_text(encoding="utf-8"))
        self.assertEqual(alert["schema"], "txt.shadow-fresh-episode-alert.v1")
        self.assertEqual(alert["status"], "FRESH_SHADOW_EPISODE")
        self.assertEqual(alert["run_id"], "run-A")
        self.assertEqual(alert["strategy_id"], "liquidity_confirmed_momentum")
        self.assertEqual(alert["side"], "buy")
        self.assertLessEqual(alert["age_seconds"], 300)
        self.assertEqual(
            alert["non_actions"],
            {"broker_call": False, "order": False, "signal_consumption": False, "campaign_authorization": False},
        )

    def test_same_episode_over_eight_scans_yields_single_open(self) -> None:
        base = NOW - timedelta(seconds=8 * 60)
        _append(self.jsonl, [_row(base + timedelta(seconds=60 * i)) for i in range(4)])
        state, first_action, first_key = self._pass({})
        self.assertEqual(first_action, "opened")

        _append(self.jsonl, [_row(base + timedelta(seconds=60 * i)) for i in range(4, 8)])
        state, second_action, second_key = self._pass(state)

        self.assertEqual(second_action, "updated")
        self.assertEqual(first_key, second_key)
        # a pass with no new rows must not re-alert
        state, third_action, _ = self._pass(state)
        self.assertEqual(third_action, "none")

    def test_distinct_new_episode_opens_new_alert(self) -> None:
        _append(self.jsonl, [_row(NOW - timedelta(seconds=240))])
        state, action, first_key = self._pass({})
        self.assertEqual(action, "opened")

        _append(
            self.jsonl,
            [
                _row(NOW - timedelta(seconds=180), decision="NO_OPPORTUNITY"),
                _row(NOW - timedelta(seconds=60), strategy="volatility_breakout", side="sell"),
            ],
        )
        state, action, second_key = self._pass(state)

        self.assertEqual(action, "opened")
        self.assertNotEqual(first_key, second_key)
        alert = json.loads(self.alert.read_text(encoding="utf-8"))
        self.assertEqual(alert["strategy_id"], "volatility_breakout")

    def test_old_opportunity_never_alerts(self) -> None:
        _append(self.jsonl, [_row(NOW - timedelta(seconds=600))])
        state, action, episode_key = self._pass({})

        self.assertEqual(action, "none")
        self.assertIsNone(episode_key)
        self.assertFalse(self.alert.exists())

    def test_rotation_resets_offset_without_duplicate_alert(self) -> None:
        _append(self.jsonl, [_row(NOW - timedelta(seconds=60))])
        state, action, _ = self._pass({})
        self.assertEqual(action, "opened")
        old_offset = state["last_read_offset"]
        self.assertGreater(old_offset, 0)

        # rotation: new run id, new (shorter) file
        self.jsonl.unlink()
        _append(self.jsonl, [_row(NOW - timedelta(seconds=30), side="sell")])
        state, action, _ = self._pass(state, run_id="run-B")

        self.assertEqual(state["run_id"], "run-B")
        self.assertEqual(action, "opened")
        # re-pass with no new data: no duplicate
        state, action, _ = self._pass(state, run_id="run-B")
        self.assertEqual(action, "none")

    def test_partial_line_is_fail_closed_then_processed_once_complete(self) -> None:
        _append(self.jsonl, [_row(NOW - timedelta(seconds=60))], newline_end=False)
        state, action, _ = self._pass({})

        self.assertEqual(action, "none")
        self.assertEqual(state["last_read_offset"], 0)
        self.assertFalse(self.alert.exists())

        with self.jsonl.open("a", encoding="utf-8") as handle:
            handle.write("\n")
        state, action, _ = self._pass(state)
        self.assertEqual(action, "opened")

    def test_invalid_json_line_never_alerts(self) -> None:
        self.jsonl.write_text('{"decision": "OPPORTUNITY", broken\n', encoding="utf-8")
        state, action, _ = self._pass({})

        self.assertEqual(action, "none")
        self.assertFalse(self.alert.exists())
        self.assertEqual(state["read_info"]["invalid_lines"], 1)

    def test_restart_preserves_dedup_via_persisted_state(self) -> None:
        _append(self.jsonl, [_row(NOW - timedelta(seconds=60))])
        state, action, _ = self._pass({})
        self.assertEqual(action, "opened")

        state_path = self.dir / "state.json"
        self.mod._atomic_write_json(state_path, state)
        reloaded = self.mod._load_json(state_path)

        reloaded, action, _ = self._pass(reloaded)
        self.assertEqual(action, "none")

    def test_alert_expires_once_when_episode_goes_stale(self) -> None:
        _append(self.jsonl, [_row(NOW - timedelta(seconds=60))])
        state, action, _ = self._pass({})
        self.assertEqual(action, "opened")

        later = NOW + timedelta(seconds=600)
        state, action, episode_key = self._pass(state, now=later)
        self.assertEqual(action, "expired")
        self.assertIsNotNone(episode_key)
        alert = json.loads(self.alert.read_text(encoding="utf-8"))
        self.assertEqual(alert["status"], "EXPIRED")
        self.assertEqual(
            alert["non_actions"],
            {"broker_call": False, "order": False, "signal_consumption": False, "campaign_authorization": False},
        )

        state, action, _ = self._pass(state, now=later + timedelta(seconds=120))
        self.assertEqual(action, "none")

    def test_alert_write_is_atomic_no_tmp_left_behind(self) -> None:
        _append(self.jsonl, [_row(NOW - timedelta(seconds=60))])
        self._pass({})
        self.assertFalse(self.alert.with_name(self.alert.name + ".tmp").exists())
        json.loads(self.alert.read_text(encoding="utf-8"))


class TelegramPassiveDeliveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = _load_module()
        self.tmpdir = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmpdir.name)
        self.token = self.dir / "token"
        self.chat = self.dir / "chat"
        self.token.write_text("123:abc\n", encoding="utf-8")
        self.chat.write_text("-100999\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _send(self, opener) -> str:
        return self.mod._send_telegram_passive_notice(
            "test", token_file=self.token, chat_id_file=self.chat, opener=opener
        )

    def test_message_is_passive_and_carries_countdown(self) -> None:
        alert = {
            "strategy_id": "liquidity_confirmed_momentum",
            "side": "sell",
            "market_regime": "BREAKOUT",
            "edge_lower_confidence_bound_bps": 19.1,
            "venue_basis_bps": -2.0,
            "scan_count": 8,
            "episode_key": "liquidity_confirmed_momentum|sell|BREAKOUT@2026-07-04T11:58:00+00:00",
            "expires_at": (NOW + timedelta(seconds=240)).isoformat(),
        }
        message = self.mod._format_fresh_episode_message(alert, NOW)

        self.assertIn("épisode shadow frais détecté", message)
        self.assertIn("Préflight read-only requis.", message)
        self.assertIn("Aucun ordre lancé.", message)
        self.assertIn("Autorisation live absente.", message)
        self.assertIn("Expiration dans 240 secondes.", message)
        # a passive notice must never carry an order-like instruction
        self.assertNotIn("GO", message)

    def test_delivery_statuses_degrade_cleanly(self) -> None:
        from contextlib import contextmanager
        from io import BytesIO
        from urllib.error import HTTPError

        @contextmanager
        def ok_opener(req, timeout=None):
            yield BytesIO(b'{"ok": true}')

        def auth_fail_opener(req, timeout=None):
            raise HTTPError(req.full_url, 401, "Unauthorized", None, None)

        def network_fail_opener(req, timeout=None):
            raise OSError("unreachable")

        self.assertEqual(self._send(ok_opener), "sent")
        self.assertEqual(self._send(auth_fail_opener), "failed_auth")
        self.assertEqual(self._send(network_fail_opener), "failed")

        self.token.unlink()
        self.assertEqual(self._send(ok_opener), "skipped_no_secrets")


if __name__ == "__main__":
    unittest.main()
