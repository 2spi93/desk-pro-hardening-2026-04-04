from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

# pyarrow est OPTIONNEL : son absence ne doit jamais tuer la rotation/compression.
# Sans pyarrow, on retombe sur une archive JSONL gzip (stdlib, toujours disponible).
try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    PARQUET_AVAILABLE = True
    PARQUET_UNAVAILABLE_REASON = ""
except Exception as _pa_exc:  # noqa: BLE001
    pa = None  # type: ignore[assignment]
    pq = None  # type: ignore[assignment]
    PARQUET_AVAILABLE = False
    PARQUET_UNAVAILABLE_REASON = repr(_pa_exc)


JsonMap = dict[str, Any]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _utc_now()).isoformat().replace("+00:00", "Z")


def _load_json(path: Path) -> JsonMap:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"config root must be an object: {path}")
    return value


def _write_json(path: Path, payload: JsonMap) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp_path, path)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_rel(path: Path, root: Path) -> Path:
    try:
        return path.resolve().relative_to(root.resolve())
    except ValueError:
        return Path(path.name)


def _iter_json_lines(path: Path, max_bad_lines: int) -> tuple[list[JsonMap], int]:
    rows: list[JsonMap] = []
    bad_lines = 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            raw = line.strip()
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                bad_lines += 1
                if bad_lines > max_bad_lines:
                    raise
                continue
            if isinstance(parsed, dict):
                rows.append(parsed)
            else:
                rows.append({"value": parsed})
    return rows, bad_lines


def _glob_policy_files(policy: JsonMap) -> Iterable[Path]:
    source_root = Path(str(policy.get("source_root", "."))).expanduser()
    patterns = policy.get("patterns") or ["**/*.jsonl"]
    if not isinstance(patterns, list):
        patterns = [patterns]
    seen: set[Path] = set()
    for pattern in patterns:
        for candidate in source_root.glob(str(pattern)):
            if candidate in seen or not candidate.is_file():
                continue
            seen.add(candidate)
            yield candidate


def _target_paths(policy: JsonMap, source_path: Path) -> tuple[Path, Path]:
    source_root = Path(str(policy.get("source_root", "."))).expanduser()
    output_root = Path(str(policy.get("parquet_root", "artifacts/jsonl-parquet"))).expanduser()
    archive_root = Path(str(policy.get("archive_root", "artifacts/jsonl-archive"))).expanduser()
    relative = _safe_rel(source_path, source_root)
    stem = source_path.name.removesuffix(".jsonl")
    timestamp = datetime.fromtimestamp(source_path.stat().st_mtime, timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    parent = relative.parent
    parquet_path = output_root / parent / f"{stem}.{timestamp}.parquet"
    manifest_path = archive_root / parent / f"{stem}.{timestamp}.manifest.json"
    return parquet_path, manifest_path


def _manifest_matches(manifest_path: Path, source_path: Path) -> bool:
    if not manifest_path.exists():
        return False
    try:
        manifest = _load_json(manifest_path)
        stat = source_path.stat()
        return (
            str(manifest.get("source_path")) == str(source_path)
            and int(manifest.get("source_size", -1)) == int(stat.st_size)
            and int(manifest.get("source_mtime_ns", -1)) == int(stat.st_mtime_ns)
        )
    except Exception:
        return False


def _archive_target_path(manifest_path: Path) -> Path:
    # Même dossier/horodatage que le manifest, en .jsonl.gz (chemin de repli sans Parquet).
    name = manifest_path.name.removesuffix(".manifest.json")
    return manifest_path.parent / f"{name}.jsonl.gz"


def _write_gzip_archive(source_path: Path, archive_path: Path) -> int:
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = archive_path.with_suffix(archive_path.suffix + ".tmp")
    try:
        with source_path.open("rb") as src, gzip.open(tmp_path, "wb", compresslevel=6) as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
        os.replace(tmp_path, archive_path)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()
        raise
    return archive_path.stat().st_size


def _rotate_source_to_tail(source_path: Path, keep_lines: int) -> bool:
    # Tronque la source à ses N dernières lignes (swap atomique). Course possible avec un
    # writer O_APPEND : au pire 1-2 lignes en vol perdues à l'instant du swap. OPT-IN via config
    # (rotate_source_keep_lines) — désactivé par défaut, donc aucun effet tant qu'on ne l'active pas.
    if keep_lines <= 0:
        return False
    try:
        with source_path.open("r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except Exception:
        return False
    if len(lines) <= keep_lines:
        return False
    tail = lines[-keep_lines:]
    tmp_path = source_path.with_suffix(source_path.suffix + ".rot.tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        handle.writelines(tail)
    os.replace(tmp_path, source_path)
    return True


def _write_parquet(rows: list[JsonMap], path: Path, compression: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        table = pa.Table.from_pylist(rows)
    except Exception:
        table = pa.Table.from_pylist([
            {"json": json.dumps(row, sort_keys=True, default=str, separators=(",", ":"))}
            for row in rows
        ])
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    for codec in [compression, "snappy", None]:
        try:
            pq.write_table(table, tmp_path, compression=codec)
            os.replace(tmp_path, path)
            return
        except Exception:
            if tmp_path.exists():
                tmp_path.unlink()
            if codec is None:
                raise


def compact_policy(policy: JsonMap, *, dry_run: bool = False) -> JsonMap:
    name = str(policy.get("name") or "unnamed")
    min_age_seconds = int(policy.get("min_age_seconds", 600))
    max_files = int(policy.get("max_files_per_run", 25))
    max_bad_lines = int(policy.get("max_bad_lines", 20))
    compression = str(policy.get("compression", "zstd"))
    now = _utc_now().timestamp()
    result: JsonMap = {
        "name": name,
        "compacted": [],
        "skipped": [],
        "errors": [],
        "parquet_pruned": [],
        "raw_pruned": [],
        "rotated": [],
    }

    processed = 0
    for source_path in sorted(_glob_policy_files(policy), key=lambda p: p.stat().st_mtime):
        if processed >= max_files:
            break
        try:
            stat = source_path.stat()
            age_seconds = max(0.0, now - stat.st_mtime)
            if stat.st_size <= 0:
                result["skipped"].append({"source_path": str(source_path), "reason": "empty"})
                continue
            if age_seconds < min_age_seconds:
                result["skipped"].append({"source_path": str(source_path), "reason": "too_fresh"})
                continue
            parquet_path, manifest_path = _target_paths(policy, source_path)
            # Le manifest (source_size/mtime/sha) suffit à décider du skip, indépendamment
            # du format d'archive (parquet OU gzip).
            if _manifest_matches(manifest_path, source_path):
                result["skipped"].append({"source_path": str(source_path), "reason": "already_compacted"})
                continue
            rows, bad_lines = _iter_json_lines(source_path, max_bad_lines=max_bad_lines)
            if not rows:
                result["skipped"].append({"source_path": str(source_path), "reason": "no_json_rows"})
                continue
            archive_kind = "parquet" if PARQUET_AVAILABLE else "jsonl_gzip"
            archive_path = parquet_path if PARQUET_AVAILABLE else _archive_target_path(manifest_path)
            if not dry_run:
                if PARQUET_AVAILABLE:
                    _write_parquet(rows, parquet_path, compression=compression)
                    archive_size = parquet_path.stat().st_size
                else:
                    archive_size = _write_gzip_archive(source_path, archive_path)
                manifest = {
                    "schema": "txt-jsonl-compaction/v1",
                    "policy": name,
                    "source_path": str(source_path),
                    "source_size": stat.st_size,
                    "source_mtime_ns": stat.st_mtime_ns,
                    "source_sha256": _sha256_file(source_path),
                    "archive_kind": archive_kind,
                    "archive_path": str(archive_path),
                    "archive_size": archive_size,
                    "parquet_path": str(parquet_path) if PARQUET_AVAILABLE else None,
                    "parquet_size": archive_size if PARQUET_AVAILABLE else None,
                    "parquet_available": PARQUET_AVAILABLE,
                    "parquet_status": "ok" if PARQUET_AVAILABLE else "skipped_missing_pyarrow",
                    "row_count": len(rows),
                    "bad_line_count": bad_lines,
                    "compression": compression if PARQUET_AVAILABLE else "gzip",
                    "compacted_at": _iso(),
                }
                _write_json(manifest_path, manifest)
                # Rotation source OPT-IN : ne tronque que si la policy le demande explicitement.
                keep_lines = int(policy.get("rotate_source_keep_lines", 0) or 0)
                if keep_lines > 0 and _rotate_source_to_tail(source_path, keep_lines):
                    result["rotated"].append({"source_path": str(source_path), "kept_lines": keep_lines})
            result["compacted"].append({
                "source_path": str(source_path),
                "archive_kind": archive_kind,
                "archive_path": str(archive_path),
                "parquet_path": str(parquet_path) if PARQUET_AVAILABLE else None,
                "manifest_path": str(manifest_path),
                "row_count": len(rows),
                "bad_line_count": bad_lines,
                "dry_run": dry_run,
            })
            processed += 1
        except Exception as exc:
            result["errors"].append({"source_path": str(source_path), "error": str(exc)})
    return result


def load_config(config_path: str | os.PathLike[str]) -> JsonMap:
    path = Path(config_path).expanduser()
    if not path.exists() and not path.is_absolute():
        workspace_path = Path("/workspace") / path
        if workspace_path.exists():
            path = workspace_path
    config = _load_json(path)
    config["config_path"] = str(path)
    return config


def run_compaction(config_path: str, *, policy_names: set[str] | None = None, dry_run: bool = False) -> JsonMap:
    config = load_config(config_path)
    policies = config.get("policies") or []
    if not isinstance(policies, list):
        raise ValueError("config.policies must be a list")
    selected = []
    for policy in policies:
        if not isinstance(policy, dict):
            continue
        name = str(policy.get("name") or "")
        if policy_names and name not in policy_names:
            continue
        selected.append(policy)
    summary = {
        "status": "ok",
        "started_at": _iso(),
        "config_path": str(config.get("config_path")),
        "dry_run": dry_run,
        "parquet_available": PARQUET_AVAILABLE,
        "parquet_status": "ok" if PARQUET_AVAILABLE else "skipped_missing_pyarrow",
        "parquet_unavailable_reason": PARQUET_UNAVAILABLE_REASON or None,
        "archive_format": "parquet" if PARQUET_AVAILABLE else "jsonl_gzip",
        "policies": [compact_policy(policy, dry_run=dry_run) for policy in selected],
    }
    if any(policy.get("errors") for policy in summary["policies"]):
        summary["status"] = "partial"
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Compact TXT JSONL files to Parquet with manifests.")
    parser.add_argument("--config", default="config/jsonl_compactor.json")
    parser.add_argument("--policy", action="append", default=[])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    summary = run_compaction(args.config, policy_names=set(args.policy or []), dry_run=args.dry_run)
    print(json.dumps(summary, indent=2, sort_keys=True))
    if summary.get("status") not in {"ok", "partial"}:
        raise SystemExit(1)


if __name__ == "__main__":
    main()