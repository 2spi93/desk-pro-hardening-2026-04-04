from __future__ import annotations

import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from apps.control_plane.telegram_control_bot import BotState, ControlBotConfig, drain_pending_updates, load_config, run_bot


class TelegramControlBotTests(unittest.TestCase):
    def test_load_config_uses_secret_files_without_embedding_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            token_file = root / "token"
            chat_file = root / "chat"
            config_file = root / "config.json"
            token_file.write_text("token-value\n", encoding="utf-8")
            chat_file.write_text("12345\n", encoding="utf-8")
            config_file.write_text(
                '{"token_file":"%s","chat_id_file":"%s","poll_timeout_seconds":25,"request_timeout_seconds":45}'
                % (token_file, chat_file),
                encoding="utf-8",
            )

            config = load_config(config_file)

        self.assertEqual(config.token, "token-value")
        self.assertEqual(config.chat_id, "12345")
        self.assertGreater(config.request_timeout_seconds, config.poll_timeout_seconds)

    def test_drain_pending_updates_advances_offset(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ControlBotConfig(token="token", chat_id="12345", state_path=Path(tmpdir) / "state.json", log_path=Path(tmpdir) / "bot.jsonl")
            state = BotState(next_update_id=10)

            def fake_fetcher(_config: ControlBotConfig, next_update_id: int | None) -> list[dict[str, object]]:
                self.assertEqual(next_update_id, 10)
                return [{"update_id": 10, "message": {"chat": {"id": 999}, "text": "/status"}}]

            drain_pending_updates(config, state, fetcher=fake_fetcher)

            self.assertEqual(state.next_update_id, 11)
            self.assertIn('"next_update_id": 11', config.state_path.read_text(encoding="utf-8"))

    def test_run_bot_classifies_auth_failure_without_generic_loop_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ControlBotConfig(token="token", chat_id="12345", state_path=Path(tmpdir) / "state.json", log_path=Path(tmpdir) / "bot.jsonl")
            error = urllib.error.HTTPError("https://api.telegram.org/botTOKEN/getUpdates", 401, "Unauthorized", hdrs=None, fp=None)

            with (
                mock.patch("apps.control_plane.telegram_control_bot.ensure_polling_allowed"),
                mock.patch("apps.control_plane.telegram_control_bot.drain_pending_updates", side_effect=error),
            ):
                exit_code = run_bot(config, once=True)

            self.assertEqual(exit_code, 4)
            log_text = config.log_path.read_text(encoding="utf-8")
            self.assertIn('"reason": "telegram_auth_failed"', log_text)
            self.assertIn('"http_status": 401', log_text)


if __name__ == "__main__":
    unittest.main()
