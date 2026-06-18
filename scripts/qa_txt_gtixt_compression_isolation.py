#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT_JSON = ROOT / "TXT_GTIXT_COMPRESSION_ISOLATION_001.json"
REPORT_MD = ROOT / "TXT_GTIXT_COMPRESSION_ISOLATION_001.md"
REPORT_CSV = ROOT / "TXT_GTIXT_COMPRESSION_ISOLATION_001.csv"

GTIXT_CONFIG = Path("/opt/shared-ingress/gtixt-tls.conf")
TXT_TLS_CONFIG = ROOT / "docker" / "mission-control-tls.conf"
TXT_BRIDGE_CONFIG = ROOT / "docker" / "bridge-tls.conf"
TXT_GATEWAY_CONFIG = ROOT / "docker" / "mission-control-gateway.conf"


def run(args: list[str]) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def assert_condition(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read(path: Path) -> str:
    assert_condition(path.exists(), f"{path} must exist")
    return path.read_text(encoding="utf-8")


def active_gzip_on(config: str) -> bool:
    return any(re.match(r"^\s*gzip\s+on\s*;", line) for line in config.splitlines())


def parse_headers(raw: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in raw.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower()
        value = value.strip()
        headers[key] = f"{headers[key]}, {value}" if key in headers else value
    return headers


def curl_headers(url: str, websocket: bool = False) -> tuple[int, dict[str, str]]:
    args = [
        "curl",
        "-k",
        "--http1.1" if websocket else "--http2",
        "-sSI",
        "-H",
        "Accept-Encoding: br,gzip,zstd",
    ]
    if websocket:
        args.extend([
            "-H",
            "Connection: Upgrade",
            "-H",
            "Upgrade: websocket",
            "-H",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "-H",
            "Sec-WebSocket-Version: 13",
        ])
    args.append(url)

    proc = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    status_match = re.search(r"^HTTP/\S+\s+(\d+)", proc.stdout, flags=re.MULTILINE)
    assert_condition(status_match, f"{url} must return an HTTP status line")
    return int(status_match.group(1)), parse_headers(proc.stdout)


def main() -> None:
    report = json.loads(read(REPORT_JSON))
    markdown = read(REPORT_MD)
    csv = read(REPORT_CSV)

    assert_condition(report["schema"] == "txt.gtixt-compression-isolation/v1", "unexpected schema")
    assert_condition(report["status"] == "TXT_GTIXT_COMPRESSION_ISOLATION_001", "unexpected status")
    assert_condition("NO-TXT-IMPACT-OBSERVED" in report["closedStatus"], "closed status must record no TXT impact")
    for key, value in report["scope"].items():
        assert_condition(value is False, f"{key} must remain false")

    assert_condition(active_gzip_on(read(GTIXT_CONFIG)), "GTIXT config must retain active gzip")
    assert_condition("server_name gtixt.com admin.gtixt.com data.gtixt.com;" in read(GTIXT_CONFIG), "GTIXT gzip config must stay in GTIXT server file")
    assert_condition(not active_gzip_on(read(TXT_TLS_CONFIG)), "TXT TLS config must not enable active gzip")
    assert_condition(not active_gzip_on(read(TXT_BRIDGE_CONFIG)), "TXT bridge config must not enable active gzip")
    assert_condition(not active_gzip_on(read(TXT_GATEWAY_CONFIG)), "TXT gateway config must not enable active gzip")

    nginx_config = run(["docker", "exec", "mission-control-tls", "sh", "-lc", "nginx -T 2>/dev/null"])
    assert_condition("#gzip  on;" in nginx_config, "global nginx gzip should remain commented in base config")
    assert_condition("server_name bridge.txt.gtixt.com;" in nginx_config, "bridge TXT vhost must remain present")
    assert_condition("server_name api.txt.gtixt.com;" in nginx_config, "TXT API vhost must remain present")

    for row in report["liveChecks"]:
        status, headers = curl_headers(row["url"])
        assert_condition(status == row["status"], f"{row['url']} status mismatch")
        assert_condition("content-encoding" not in headers, f"{row['url']} must not return accidental Content-Encoding")

    for row in report["webSocketChecks"]:
        status, headers = curl_headers(row["url"], websocket=True)
        assert_condition(status == row["status"], f"{row['url']} websocket probe status mismatch")
        assert_condition("content-encoding" not in headers, f"{row['url']} websocket probe must not return accidental Content-Encoding")

    assert_condition(report["findings"]["gtixtGzipScope"] == "ISOLATED_SERVER_BLOCK", "GTIXT gzip scope must be isolated")
    assert_condition(report["findings"]["txtRestAccidentalGzipObserved"] is False, "TXT REST accidental gzip must be false")
    assert_condition(report["findings"]["txtWebSocketAccidentalGzipObserved"] is False, "TXT WS accidental gzip must be false")
    assert_condition(report["decision"]["txtCompressionChangeNeeded"] is False, "TXT compression change must not be needed")

    assert_condition("GTIXT gzip scope: isolated to GTIXT server block" in markdown, "markdown must record isolated scope")
    assert_condition("txtRestAccidentalGzipObserved,false" in csv, "csv must record no TXT REST gzip")

    print("[qa-txt-gtixt-compression-isolation] OK", json.dumps({
        "gtixtGzipScope": report["findings"]["gtixtGzipScope"],
        "txtRestAccidentalGzipObserved": report["findings"]["txtRestAccidentalGzipObserved"],
        "txtWebSocketAccidentalGzipObserved": report["findings"]["txtWebSocketAccidentalGzipObserved"],
    }))


if __name__ == "__main__":
    main()
