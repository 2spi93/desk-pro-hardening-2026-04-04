from __future__ import annotations

import base64
import json
import hashlib
import hmac
import os
import time
from dataclasses import dataclass


def _secret_env(name: str, default: str) -> str:
    file_path = os.getenv(f"{name}_FILE", "").strip()
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass
    value = os.getenv(name, "").strip()
    return value or default

@dataclass
class AuthContext:
    user_id: int
    principal: str
    username: str
    role: str
    session_id: str | None = None


def _secret() -> bytes:
    return _secret_env("APPROVAL_HMAC_SECRET", "mission-control-secret").encode()


def hash_password(password: str, salt: str | None = None) -> str:
    actual_salt = salt or os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), actual_salt.encode(), 240000)
    return f"pbkdf2_sha256${actual_salt}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        _algo, salt, digest = stored_hash.split("$", 2)
    except ValueError:
        return False
    check = hash_password(password, salt)
    return hmac.compare_digest(check, f"pbkdf2_sha256${salt}${digest}")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64url_decode(value: str) -> bytes:
    pad = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode((value + pad).encode())


def issue_access_token(user_id: int, username: str, role: str, session_id: str, ttl_seconds: int = 12 * 3600) -> tuple[str, int]:
    expires_at = int(time.time()) + ttl_seconds
    payload = {
        "uid": user_id,
        "sub": username,
        "role": role,
        "sid": session_id,
        "exp": expires_at,
    }
    payload_part = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signature = hmac.new(_secret(), payload_part.encode(), hashlib.sha256).hexdigest()
    token = f"{payload_part}.{signature}"
    return token, expires_at


def parse_access_token(token: str) -> dict | None:
    if "." not in token:
        return None
    payload_part, signature = token.split(".", 1)
    expected = hmac.new(_secret(), payload_part.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_part).decode())
    except Exception:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


def auth_context_from_token(token: str) -> AuthContext | None:
    payload = parse_access_token(token)
    if not payload:
        return None
    return AuthContext(
        user_id=int(payload["uid"]),
        principal=str(payload["sub"]),
        username=str(payload["sub"]),
        role=str(payload["role"]),
        session_id=str(payload.get("sid") or ""),
    )


def sign_approval_payload(payload: str) -> str:
    return hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()


def verify_approval_signature(payload: str, signature: str) -> bool:
    expected = sign_approval_payload(payload)
    return hmac.compare_digest(expected, signature)