#!/usr/bin/env python3
"""Focused stdlib tests for the GNM scale comparison report."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compare_gnm_quality_scales import compare, main


FEATURES = (
    "craniumWidth", "cheekWidth", "jawWidth", "chinWidth", "faceHeight",
    "foreheadHeight", "eyeSpacing", "eyeWidth", "eyeHeight", "noseLength",
    "noseWidth", "mouthWidth", "earSpan", "templeSlope",
)
LANDMARKS = (
    "top", "templeLeft", "templeRight", "cheekLeft", "cheekRight", "jawLeft", "jawRight",
    "chin", "chinLeft", "chinRight", "eyeLeft", "eyeRight", "eyeLeftOuter", "eyeLeftInner",
    "eyeLeftTop", "eyeLeftBottom", "eyeRightOuter", "eyeRightInner", "eyeRightTop",
    "eyeRightBottom", "noseBridge", "noseTip", "noseLeft", "noseRight", "mouthLeft",
    "mouthRight", "hairlineLeft", "hairlineCenter", "hairlineRight", "earLeft", "earRight",
)


def landmark_sample(index: int, duplicate: bool = False) -> dict:
    offset = 0 if duplicate else index
    points = {
        "top": (0, -offset), "templeLeft": (10 + offset, 20), "templeRight": (-10 - offset, 20),
        "cheekLeft": (9 + offset, 35), "cheekRight": (-9 - offset, 35),
        "jawLeft": (7 + offset, 48), "jawRight": (-7 - offset, 48), "chin": (0, 60 + offset),
        "chinLeft": (3 + offset, 56 + offset), "chinRight": (-3 - offset, 56 + offset),
        "eyeLeft": (5 + offset, 28 + offset), "eyeRight": (-5 - offset, 28 + offset),
        "eyeLeftOuter": (7 + offset, 28 + offset), "eyeLeftInner": (4 + offset, 28 + offset),
        "eyeLeftTop": (5.5 + offset, 27 - offset), "eyeLeftBottom": (5.5 + offset, 29 + offset),
        "eyeRightOuter": (-7 - offset, 28 + offset), "eyeRightInner": (-4 - offset, 28 + offset),
        "eyeRightTop": (-5.5 - offset, 27 - offset), "eyeRightBottom": (-5.5 - offset, 29 + offset),
        "noseBridge": (0, 30 + offset), "noseTip": (0, 36 + 2 * offset),
        "noseLeft": (-2 - offset / 2, 36 + 2 * offset), "noseRight": (2 + offset / 2, 36 + 2 * offset),
        "mouthLeft": (-4 - offset / 2, 44 + offset), "mouthRight": (4 + offset / 2, 44 + offset),
        "hairlineLeft": (-7, 10 + offset), "hairlineCenter": (0, 8 + offset), "hairlineRight": (7, 10 + offset),
        "earLeft": (14 + offset, 32), "earRight": (-14 - offset, 32),
    }
    return {"id": f"sample-{index}", "landmarks": {key: {"x": x, "y": y} for key, (x, y) in points.items()}}


def documents(sample_count: int = 4, duplicate: bool = False) -> tuple[dict, dict]:
    samples = [landmark_sample(index, duplicate and index == sample_count - 1) for index in range(sample_count)]
    rows = []
    for sample in samples:
        offset = sample["landmarks"]["templeLeft"]["x"] - 10
        rows.append({key: round(1 + offset / 100 + index / 1000, 6) for index, key in enumerate(FEATURES)})
    families = [
        {
            "id": "family-a", "memberCount": len(samples) // 2,
            "members": [sample["id"] for sample in samples[: len(samples) // 2]],
            "centroid": {key: sum(row[key] for row in rows[: len(samples) // 2]) / (len(samples) // 2) for key in FEATURES},
        },
        {
            "id": "family-b", "memberCount": len(samples) - len(samples) // 2,
            "members": [sample["id"] for sample in samples[len(samples) // 2:]],
            "centroid": {key: sum(row[key] for row in rows[len(samples) // 2:]) / (len(samples) - len(samples) // 2) for key in FEATURES},
        },
    ]
    pack = {
        "schema": "sports-face-morphology-pack/v1",
        "source": {"kind": "synthetic", "sampling": {"seed": 7, "sigma": 1.15}},
        "clustering": {"seed": 7, "features": list(FEATURES)},
        "families": families,
    }
    return pack, {"schema": "sports-face-landmark-samples/v1", "samples": samples}


class ScaleComparisonTest(unittest.TestCase):
    def write_case(self, root: Path, name: str, pack: dict, landmarks: dict) -> tuple[Path, Path]:
        pack_path = root / f"{name}-pack.json"
        landmarks_path = root / f"{name}-landmarks.json"
        pack_path.write_text(json.dumps(pack), encoding="utf-8")
        landmarks_path.write_text(json.dumps(landmarks), encoding="utf-8")
        return pack_path, landmarks_path

    def test_pass_reports_metrics_and_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pack, landmarks = documents()
            canonical_pack, canonical_landmarks = self.write_case(root, "canonical", pack, landmarks)
            candidate_pack, candidate_landmarks = self.write_case(root, "candidate", pack, landmarks)
            report = compare(candidate_pack, canonical_pack, candidate_landmarks, canonical_landmarks, expected_count=4)
            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["candidates"][0]["counts"]["samples"], 4)
            self.assertEqual(report["candidates"][0]["exactDuplicateFeatureVectors"]["count"], 0)
            self.assertEqual(report["candidates"][0]["provenance"]["sigma"], 1.15)

    def test_duplicate_is_warning_and_strict_cli_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pack, landmarks = documents(duplicate=True)
            canonical_pack, canonical_landmarks = self.write_case(root, "canonical", pack, landmarks)
            candidate_pack, candidate_landmarks = self.write_case(root, "candidate", pack, landmarks)
            report = compare(candidate_pack, canonical_pack, candidate_landmarks, canonical_landmarks, expected_count=4)
            self.assertEqual(report["status"], "warn")
            self.assertGreater(report["candidates"][0]["exactDuplicateFeatureVectors"]["count"], 0)
            output = root / "report.json"
            self.assertEqual(main([
                "--candidate-pack", str(candidate_pack), "--candidate-landmarks", str(candidate_landmarks),
                "--canonical-pack", str(canonical_pack), "--canonical-landmarks", str(canonical_landmarks),
                "--count", "4", "--output", str(output), "--strict",
            ]), 1)

    def test_missing_candidate_is_bounded_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pack, landmarks = documents()
            canonical_pack, canonical_landmarks = self.write_case(root, "canonical", pack, landmarks)
            report = compare(
                root / "missing-pack.json", canonical_pack, root / "missing-landmarks.json", canonical_landmarks,
                expected_count=4, unavailable_reason="external GNM/NumPy environment unavailable",
            )
            self.assertEqual(report["status"], "unavailable")
            self.assertNotIn("nearestNeighbor", report["candidates"][0])
            self.assertIn("external GNM", report["candidates"][0]["reasons"][0])

    def test_deterministic_output_is_byte_stable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pack, landmarks = documents()
            canonical_pack, canonical_landmarks = self.write_case(root, "canonical", pack, landmarks)
            candidate_pack, candidate_landmarks = self.write_case(root, "candidate", pack, landmarks)
            rerun_pack, rerun_landmarks = self.write_case(root, "rerun", pack, landmarks)
            first = compare(candidate_pack, canonical_pack, candidate_landmarks, canonical_landmarks, rerun_pack, rerun_landmarks, 4)
            second = compare(candidate_pack, canonical_pack, candidate_landmarks, canonical_landmarks, rerun_pack, rerun_landmarks, 4)
            self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
            self.assertEqual(first["deterministicRerun"]["status"], "pass")


if __name__ == "__main__":
    unittest.main()
