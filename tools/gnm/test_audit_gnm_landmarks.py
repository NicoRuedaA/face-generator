#!/usr/bin/env python3
"""Focused stdlib tests for the report-only GNM landmark audit helpers."""

from __future__ import annotations

import unittest

from audit_gnm_landmarks import (
    EXPECTED_LANDMARKS,
    raw_mesh_extrema,
    source_filename_entries,
    projection_metrics,
)


def sample(sample_id: str, *, chin_y: float = 300.0) -> dict:
    landmarks = {
        name: {"x": 300.0, "y": 300.0}
        for name in EXPECTED_LANDMARKS
    }
    landmarks["templeLeft"]["x"] = 250.0
    landmarks["templeRight"]["x"] = 350.0
    landmarks["chin"]["y"] = chin_y
    return {"id": sample_id, "landmarks": landmarks}


class AuditHelperTests(unittest.TestCase):
    def test_projection_reports_sample_percentage_and_worst_axis(self) -> None:
        report = projection_metrics([sample("gnm-0001", chin_y=721.3187), sample("gnm-0002")])

        self.assertEqual(report["samplesWithWarnings"], 1)
        self.assertEqual(report["samplePercentage"], 50.0)
        self.assertEqual(len(report["outOfBounds"]), 1)
        self.assertEqual(report["worstExcursion"], {
            "sample": "gnm-0001",
            "landmark": "chin",
            "axis": "y",
            "value": 721.3187,
            "distanceOutsideFrame": 65.3187,
        })

    def test_source_entries_keep_exact_paths_and_filename_drift(self) -> None:
        from pathlib import Path

        entries = source_filename_entries(
            {"source": {"mesh": "heads-test.npz"}},
            {"source": {"meshFile": "gnm-heads-200.npz"}},
            {"source": {"meshFile": "gnm-heads-200.npz"}},
            vertex_map_path=Path("/repo/tools/gnm/work/gnm-vertex-map.json"),
            landmarks_path=Path("/repo/tools/gnm/work/gnm-landmarks.json"),
            retained_path=Path("/repo/tools/gnm/work/gnm-landmarks-200.json"),
            mesh_path=Path("/repo/tools/gnm/work/gnm-heads-200.npz"),
        )

        self.assertFalse(entries[0]["filenameMatch"])
        self.assertEqual(entries[0]["expectedPath"], "/repo/tools/gnm/work/gnm-heads-200.npz")
        self.assertEqual(entries[0]["actualPath"], "/repo/tools/gnm/work/heads-test.npz")
        self.assertTrue(entries[-1]["filenameMatch"])

    def test_raw_mesh_extrema_are_not_normalized(self) -> None:
        try:
            import numpy as np
        except ImportError:
            self.skipTest("NumPy unavailable")

        extrema = raw_mesh_extrema(np.array([[[
            -0.1, 0.04, -0.12,
        ], [0.15, 0.42, 0.16]]], dtype=np.float32))

        self.assertEqual(extrema, {
            "x": {"min": -0.1, "max": 0.15},
            "y": {"min": 0.04, "max": 0.42},
            "z": {"min": -0.12, "max": 0.16},
        })


if __name__ == "__main__":
    unittest.main()
