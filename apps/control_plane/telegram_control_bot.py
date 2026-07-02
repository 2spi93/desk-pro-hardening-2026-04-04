from __future__ import annotations

import argparse
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


DEFAULT_CONFIG_PATH = "/opt/txt/config/telegram_control_bot.json"


@dataclass
class ControlBotConfig:
    token: str
    chat_id: str
    api_base_url: str = "https://api.telegram.org"
    poll_timeout_seconds: int = 25
    request_timeout_seconds: int = 45
    idle_sleep_seconds: float = 1.0
    auth_failure_sleep_seconds: float = 300.0
    state_path: Path = Path("/opt/txt/data/telegram-control-bot/state.json")
    log_path: Path = Path("/opt/txt/logs/telegram-control-bot.jsonl")
    clear_webhook_on_start: bool = True
    control_plane_url: str = "http://127.0.0.1:8000"


@dataclass
class BotState:
    next_update_id: int | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_text(path: str | Path | None) -> str:
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def _load_json(path: str | Path) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if isinstance(payload, dict):
        return payload
    return {}


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _coerce_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _coerce_float(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def load_config(path: str | Path = DEFAULT_CONFIG_PATH) -> ControlBotConfig:
    raw = _load_json(path)
    token = str(raw.get("token") or os.getenv("TELEGRAM_BOT_TOKEN") or _read_text(raw.get("token_file") or os.getenv("TELEGRAM_BOT_TOKEN_FILE")) or "").strip()
    chat_id = str(raw.get("chat_id") or os.getenv("TELEGRAM_CHAT_ID") or _read_text(raw.get("chat_id_file") or os.getenv("TELEGRAM_CHAT_ID_FILE")) or "").strip()
    poll_timeout = _coerce_int(raw.get("poll_timeout_seconds") or os.getenv("TELEGRAM_POLL_TIMEOUT_SECONDS"), 25, 1, 50)
    request_timeout = _coerce_int(raw.get("request_timeout_seconds") or os.getenv("TELEGRAM_REQUEST_TIMEOUT_SECONDS"), poll_timeout + 20, poll_timeout + 5, 120)
    return ControlBotConfig(
        token=token,
        chat_id=chat_id,
        api_base_url=str(raw.get("api_base_url") or os.getenv("TELEGRAM_API_BASE_URL") or "https://api.telegram.org").rstrip("/"),
        poll_timeout_seconds=poll_timeout,
        request_timeout_seconds=request_timeout,
        idle_sleep_seconds=_coerce_float(raw.get("idle_sleep_seconds"), 1.0, 0.0, 30.0),
        auth_failure_sleep_seconds=_coerce_float(raw.get("auth_failure_sleep_seconds"), 300.0, 30.0, 3600.0),
        state_path=Path(str(raw.get("state_path") or "/opt/txt/data/telegram-control-bot/state.json")),
        log_path=Path(str(raw.get("log_path") or "/opt/txt/logs/telegram-control-bot.jsonl")),
        clear_webhook_on_start=_coerce_bool(raw.get("clear_webhook_on_start"), True),
        control_plane_url=str(raw.get("control_plane_url") or os.getenv("CONTROL_PLANE_URL") or "http://127.0.0.1:8000").rstrip("/"),
    )


def log_event(config: ControlBotConfig, payload: dict[str, Any]) -> None:
    config.log_path.parent.mkdir(parents=True, exist_ok=True)
    record = {"logged_at": _now_iso(), **payload}
    with config.log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def load_state(config: ControlBotConfig) -> BotState:
    raw = _load_json(config.state_path)
    value = raw.get("next_update_id")
    try:
        next_update_id = int(value) if value is not None else None
    except (TypeError, ValueError):
        next_update_id = None
    return BotState(next_update_id=next_update_id)


def save_state(config: ControlBotConfig, state: BotState) -> None:
    config.state_path.parent.mkdir(parents=True, exist_ok=True)
    config.state_path.write_text(json.dumps({"next_update_id": state.next_update_id, "updated_at": _now_iso()}, sort_keys=True) + "\n", encoding="utf-8")


def telegram_api_call(config: ControlBotConfig, method: str, params: dict[str, Any] | None = None, *, timeout: int | None = None) -> dict[str, Any]:
    if not config.token:
        raise RuntimeError("telegram_bot_token_missing")
    encoded = urllib.parse.urlencode({key: value for key, value in (params or {}).items() if value is not None}).encode("utf-8")
    request = urllib.request.Request(
        f"{config.api_base_url}/bot{config.token}/{method}",
        data=encoded if encoded else None,
        method="POST" if encoded else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout or config.request_timeout_seconds) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("telegram_invalid_response")
    return payload


def ensure_polling_allowed(config: ControlBotConfig) -> None:
    if not config.clear_webhook_on_start:
        return
    try:
        webhook = telegram_api_call(config, "getWebhookInfo", timeout=15)
        result = webhook.get("result") if isinstance(webhook.get("result"), dict) else {}
        if str(result.get("url") or "").strip():
            telegram_api_call(config, "deleteWebhook", {"drop_pending_updates": "false"}, timeout=20)
            log_event(config, {"status": "info", "reason": "telegram_webhook_cleared"})
    except Exception as exc:  # noqa: BLE001
        log_event(config, {"status": "warning", "reason": "telegram_webhook_check_failed", "error": str(exc)})


def fetch_updates(config: ControlBotConfig, next_update_id: int | None) -> list[dict[str, Any]]:
    params = {
        "timeout": config.poll_timeout_seconds,
        "allowed_updates": json.dumps(["message"]),
    }
    if next_update_id is not None:
        params["offset"] = next_update_id
    payload = telegram_api_call(config, "getUpdates", params, timeout=config.request_timeout_seconds)
    result = payload.get("result")
    return result if isinstance(result, list) else []


def send_message(config: ControlBotConfig, text: str) -> None:
    if not config.chat_id:
        return
    telegram_api_call(config, "sendMessage", {"chat_id": config.chat_id, "text": text[:3500]})


def _http_json(url: str, timeout: int = 8) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload if isinstance(payload, dict) else {}


def render_status(config: ControlBotConfig) -> str:
    try:
        health = _http_json(f"{config.control_plane_url}/health")
    except Exception as exc:  # noqa: BLE001
        return f"TXT status: control-plane unreachable ({exc})"
    gate = health.get("opportunity_gate") if isinstance(health.get("opportunity_gate"), dict) else {}
    return "\n".join(
        [
            "TXT status",
            f"control-plane: {health.get('status')}",
            f"system_mode: {health.get('system_mode')}",
            f"opportunity: {gate.get('status')} score={gate.get('health_score')}",
            f"recommended_mode: {gate.get('recommended_mode')}",
            f"host: {socket.gethostname()}",
        ]
    )


def handle_message(config: ControlBotConfig, message: dict[str, Any]) -> None:
    chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
    chat_id = str(chat.get("id") or "").strip()
    if config.chat_id and chat_id != config.chat_id:
        log_event(config, {"status": "warning", "reason": "telegram_unauthorized_chat", "chat_id": chat_id})
        return
    text = str(message.get("text") or "").strip().lower()
    if text in {"/status", "status", "/health", "health"}:
        send_message(config, render_status(config))
    elif text in {"/start", "/help", "help"}:
        send_message(config, "TXT control bot ready. Available read-only commands: /status, /help")


def drain_pending_updates(config: ControlBotConfig, state: BotState, fetcher: Callable[[ControlBotConfig, int | None], list[dict[str, Any]]] = fetch_updates) -> None:
    updates = fetcher(config, state.next_update_id)
    for update in updates:
        update_id = update.get("update_id")
        try:
            parsed_update_id = int(update_id)
        except (TypeError, ValueError):
            continue
        message = update.get("message") if isinstance(update.get("message"), dict) else {}
        if message:
            handle_message(config, message)
        state.next_update_id = parsed_update_id + 1
    if updates:
        save_state(config, state)
        log_event(config, {"status": "ok", "reason": "telegram_updates_processed", "count": len(updates), "next_update_id": state.next_update_id})


def run_bot(config: ControlBotConfig, *, once: bool = False) -> int:
    if not config.token:
        log_event(config, {"status": "error", "reason": "telegram_bot_token_missing"})
        return 3
    ensure_polling_allowed(config)
    state = load_state(config)
    while True:
        try:
            drain_pending_updates(config, state)
        except urllib.error.HTTPError as exc:
            if exc.code in {401, 403}:
                log_event(config, {"status": "error", "reason": "telegram_auth_failed", "http_status": exc.code, "error": str(exc)})
                if once:
                    return 4
                time.sleep(config.auth_failure_sleep_seconds)
                continue
            reason = "telegram_poll_conflict" if exc.code == 409 else "telegram_http_error"
            log_event(config, {"status": "warning", "reason": reason, "http_status": exc.code, "error": str(exc)})
            if exc.code == 409:
                ensure_polling_allowed(config)
        except (TimeoutError, urllib.error.URLError) as exc:
            error_text = str(exc)
            status = "info" if "timed out" in error_text.lower() else "warning"
            reason = "telegram_poll_timeout" if status == "info" else "telegram_network_error"
            log_event(config, {"status": status, "reason": reason, "error": error_text})
        except Exception as exc:  # noqa: BLE001
            log_event(config, {"status": "error", "reason": "telegram_bot_loop_error", "error": str(exc)})
        if once:
            return 0
        if config.idle_sleep_seconds > 0:
            time.sleep(config.idle_sleep_seconds)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="TXT Telegram control bot")
    parser.add_argument("--config", default=os.getenv("TXT_TELEGRAM_CONTROL_CONFIG", DEFAULT_CONFIG_PATH))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    return run_bot(load_config(args.config), once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())
