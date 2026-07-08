from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_incident_adjudication.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_incident_adjudication", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _runtime() -> dict:
    return {
        "control_plane": "ok",
        "system_mode": "guarded_auto",
        "gate": "go",
        "kill_recommended": False,
        "pending_intents": 0,
    }


def _healthy_certification(certified: int = 3, threshold: int = 100) -> dict:
    return {
        "projected_certified_total": certified,
        "scanner_certified_total": certified,
        "effective_certified_total": certified,
        "counter_delta": 0,
        "constitutional_threshold": threshold,
        "projection_health": "healthy",
        "scanner_health": "healthy",
        "projection_digest": "deadbeef",
        "certifier_version": "txt.certified_outcomes.proof_projection.v1",
    }


def _certified_outcomes_incident() -> dict:
    return {
        "ticket_key": "INC-444A3CCAFA",
        "severity": "critical",
        "status": "open",
        "source": "ops-chatbot",
        "title": "[Constitutional] Certified Outcomes Gate blocked on /constitutional/certified-outcomes",
        "payload": {"detail": "live promotion remains blocked"},
        "created_at": "2026-06-09T22:21:54+00:00",
    }


class TxtIncidentAdjudicationTests(unittest.TestCase):
    def test_certified_outcomes_title_alone_never_active_confirmed(self) -> None:
        # No runtime certification evidence: the frozen title must NOT latch a
        # critical active incident (it did previously).
        mod = _load_module()
        report = mod.build_report(
            {"runtime": _runtime(), "incidents": [_certified_outcomes_incident()]},
            now=mod.parse_time("2026-07-08T10:00:00+00:00"),
        )
        item = report["items"][0]
        self.assertNotEqual(item["classification"], mod.ACTIVE_CONFIRMED)
        self.assertEqual(item["classification"], mod.UNRESOLVED_INSUFFICIENT_EVIDENCE)
        self.assertEqual(item["detail"], "certification_runtime_evidence_absent")

    def test_certified_outcomes_healthy_below_threshold_is_resolved(self) -> None:
        # The real current state: pipeline healthy, scanner==projection==3,
        # certified 3/100 -> RESOLVED_BUT_UNCLOSED, block clears.
        mod = _load_module()
        runtime = {**_runtime(), "certification": _healthy_certification(3, 100)}
        report = mod.build_report(
            {"runtime": runtime, "incidents": [_certified_outcomes_incident()]},
            now=mod.parse_time("2026-07-08T10:00:00+00:00"),
        )
        item = report["items"][0]
        self.assertEqual(item["classification"], mod.RESOLVED_BUT_UNCLOSED)
        self.assertEqual(item["detail"], "threshold_progressing_normally")
        self.assertEqual(report["promotion_relevant_blockers"], 0)
        self.assertTrue(report["PROMOTION_INCIDENT_BLOCK_CLEAR"])
        # dead route annotated as a stale reference, not a live fault
        self.assertEqual(item["legacy_reference"]["legacy_endpoint_status"], "retired_or_missing")
        self.assertEqual(item["legacy_reference"]["classification"], "STALE_REFERENCE")

    def test_certified_outcomes_threshold_reached_is_resolved_reached(self) -> None:
        mod = _load_module()
        runtime = {**_runtime(), "certification": _healthy_certification(100, 100)}
        report = mod.build_report(
            {"runtime": runtime, "incidents": [_certified_outcomes_incident()]},
            now=mod.parse_time("2026-07-08T10:00:00+00:00"),
        )
        item = report["items"][0]
        self.assertEqual(item["classification"], mod.RESOLVED_BUT_UNCLOSED)
        self.assertEqual(item["detail"], "threshold_reached")
        self.assertEqual(report["promotion_relevant_blockers"], 0)

    def test_certified_outcomes_scanner_projection_divergence_is_active(self) -> None:
        mod = _load_module()
        cert = _healthy_certification(3, 100)
        cert.update({"scanner_certified_total": 2, "counter_delta": 1})
        runtime = {**_runtime(), "certification": cert}
        report = mod.build_report(
            {"runtime": runtime, "incidents": [_certified_outcomes_incident()]},
            now=mod.parse_time("2026-07-08T10:00:00+00:00"),
        )
        item = report["items"][0]
        self.assertEqual(item["classification"], mod.ACTIVE_CONFIRMED)
        self.assertEqual(item["detail"], "scanner_projection_counter_divergent")
        self.assertEqual(report["promotion_relevant_blockers"], 1)

    def test_certified_outcomes_pipeline_unavailable_is_active(self) -> None:
        mod = _load_module()
        for broken in (
            {"projection_health": "unavailable", "projected_certified_total": None},
            {"projection_health": "invalid"},
            {"scanner_health": "unavailable", "scanner_certified_total": None},
        ):
            cert = _healthy_certification(3, 100)
            cert.update(broken)
            runtime = {**_runtime(), "certification": cert}
            report = mod.build_report(
                {"runtime": runtime, "incidents": [_certified_outcomes_incident()]},
                now=mod.parse_time("2026-07-08T10:00:00+00:00"),
            )
            item = report["items"][0]
            self.assertEqual(item["classification"], mod.ACTIVE_CONFIRMED, broken)
            self.assertEqual(item["detail"], "certification_pipeline_unavailable_or_invalid", broken)

    def test_derive_certification_health_from_canonical_artifacts(self) -> None:
        mod = _load_module()
        projection = {
            "certified_total": 3,
            "blockers": [],
            "projection_digest": "abc",
            "certifier_version": "txt.certified_outcomes.proof_projection.v1",
        }
        scanner = {
            "certified_outcomes": {"required_total": 100, "certified_total": 3},
            "runtime_context": {
                "certified_outcomes_counter": {
                    "scanner_certified_total": 3,
                    "effective_certified_total": 3,
                }
            },
        }
        health = mod.derive_certification_health(projection, scanner)
        self.assertEqual(health["projection_health"], "healthy")
        self.assertEqual(health["scanner_health"], "healthy")
        self.assertEqual(health["counter_delta"], 0)
        self.assertEqual(health["constitutional_threshold"], 100)
        self.assertEqual(health["projected_certified_total"], 3)
        self.assertEqual(health["scanner_certified_total"], 3)

    def test_derive_certification_health_flags_projection_blockers_invalid(self) -> None:
        mod = _load_module()
        projection = {"certified_total": 3, "blockers": ["missing_reality_gap_sample"]}
        scanner = {"certified_outcomes": {"required_total": 100, "certified_total": 3}}
        health = mod.derive_certification_health(projection, scanner)
        self.assertEqual(health["projection_health"], "invalid")

    def test_derive_certification_health_empty_is_unavailable(self) -> None:
        mod = _load_module()
        health = mod.derive_certification_health({}, {})
        self.assertEqual(health["projection_health"], "unavailable")
        self.assertEqual(health["scanner_health"], "unavailable")
        self.assertIsNone(health["counter_delta"])

    def test_opportunity_gate_freeze_is_resolved_but_unclosed_when_runtime_clear(self) -> None:
        mod = _load_module()
        report = mod.build_report(
            {
                "runtime": _runtime(),
                "incidents": [
                    {
                        "ticket_key": "INC-2",
                        "severity": "critical",
                        "status": "assigned",
                        "source": "opportunity_gate",
                        "title": "Freeze runtime: deviation_kill_threshold",
                        "payload": {},
                        "created_at": "2026-05-21T10:00:00+00:00",
                    }
                ],
            },
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertEqual(report["items"][0]["classification"], mod.RESOLVED_BUT_UNCLOSED)
        self.assertEqual(report["promotion_relevant_blockers"], 0)

    def test_old_terminal_family_duplicates_are_stale_duplicates(self) -> None:
        mod = _load_module()
        report = mod.build_report(
            {
                "runtime": _runtime(),
                "incidents": [
                    {
                        "ticket_key": "INC-3",
                        "severity": "critical",
                        "status": "open",
                        "source": "ops-chatbot",
                        "title": "Terminal local hard fail BTCUSDT 1h",
                        "payload": {},
                        "created_at": "2026-05-20T10:00:00+00:00",
                    },
                    {
                        "ticket_key": "INC-4",
                        "severity": "critical",
                        "status": "open",
                        "source": "ops-chatbot",
                        "title": "Terminal local hard fail BTCUSDT 5m",
                        "payload": {},
                        "created_at": "2026-05-20T10:00:00+00:00",
                    },
                ],
            },
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertEqual({item["classification"] for item in report["items"]}, {mod.STALE_DUPLICATE})
        self.assertTrue(all(not item["relevant_to_execution_router"] for item in report["items"]))

    def test_old_non_execution_incident_is_unrelated(self) -> None:
        mod = _load_module()
        report = mod.build_report(
            {
                "runtime": _runtime(),
                "incidents": [
                    {
                        "ticket_key": "INC-5",
                        "severity": "high",
                        "status": "open",
                        "source": "ui",
                        "title": "Dashboard widget failed",
                        "payload": {},
                        "created_at": "2026-05-20T10:00:00+00:00",
                    }
                ],
            },
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertEqual(report["items"][0]["classification"], mod.UNRELATED_TO_EXECUTION_ROUTER)
        self.assertTrue(report["PROMOTION_INCIDENT_BLOCK_CLEAR"])


if __name__ == "__main__":
    unittest.main()
