#!/usr/bin/env python3
"""Regression coverage for the complete generated GNM feature contract."""

from __future__ import annotations

import json
import math
from copy import deepcopy
from pathlib import Path
import unittest

from build_morphology_pack import FEATURE_KEYS, vector
from validate_morphology_pack import validate_document


ROOT = Path(__file__).resolve().parents[2]
LANDMARKS = ROOT / "tools" / "gnm" / "work" / "gnm-landmarks.json"
PACK = ROOT / "tools" / "gnm" / "work" / "gnm-morphology-pack.json"
EXPECTED_CANONICAL_SAMPLE_COUNT = 200


class GnmMorphologyPackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.landmarks = json.loads(LANDMARKS.read_text(encoding="utf-8"))
        cls.pack = json.loads(PACK.read_text(encoding="utf-8"))

    def test_all_fourteen_projected_features_are_positive_finite_and_variable(self) -> None:
        rows = [vector(sample) for sample in self.landmarks["samples"]]
        self.assertEqual(len(rows), EXPECTED_CANONICAL_SAMPLE_COUNT)
        self.assertEqual(self.pack["clustering"]["features"], list(FEATURE_KEYS))
        for key in FEATURE_KEYS:
            values = [row[key] for row in rows]
            self.assertTrue(all(math.isfinite(value) and value > 0 for value in values), key)
            self.assertGreater(max(values) - min(values), 1e-9, key)

    def test_canonical_landmarks_and_pack_share_provenance_and_members(self) -> None:
        landmark_source = self.landmarks["source"]
        pack_source = self.pack["source"]
        self.assertEqual(landmark_source["meshFile"], pack_source["meshFile"])

        sample_ids = [sample["id"] for sample in self.landmarks["samples"]]
        member_ids = [member for family in self.pack["families"] for member in family["members"]]
        self.assertEqual(len(sample_ids), EXPECTED_CANONICAL_SAMPLE_COUNT)
        self.assertEqual(len(member_ids), EXPECTED_CANONICAL_SAMPLE_COUNT)
        self.assertEqual(len(set(member_ids)), EXPECTED_CANONICAL_SAMPLE_COUNT)
        self.assertEqual(sum(family["memberCount"] for family in self.pack["families"]), len(sample_ids))
        self.assertEqual(set(member_ids), set(sample_ids))

    def test_pack_centroids_contain_the_same_fourteen_positive_features(self) -> None:
        for family in self.pack["families"]:
            self.assertEqual(set(family["centroid"]), set(FEATURE_KEYS))
            self.assertTrue(all(math.isfinite(family["centroid"][key]) and family["centroid"][key] > 0 for key in FEATURE_KEYS))

    def test_validator_rejects_nonfinite_zero_and_negative_centroid_values(self) -> None:
        for value in (math.nan, math.inf, 0.0, -1.0):
            document = deepcopy(self.pack)
            document["families"][0]["centroid"]["faceHeight"] = value
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    validate_document(document)

    def test_validator_requires_exact_fourteen_centroid_keys(self) -> None:
        missing = deepcopy(self.pack)
        del missing["families"][0]["centroid"][FEATURE_KEYS[-1]]
        with self.assertRaises(ValueError):
            validate_document(missing)

        extra = deepcopy(self.pack)
        extra["families"][0]["centroid"]["unexpected"] = 1.0
        with self.assertRaises(ValueError):
            validate_document(extra)

    def test_vector_rejects_nonfinite_and_degenerate_geometry(self) -> None:
        nonfinite = deepcopy(self.landmarks["samples"][0])
        nonfinite["landmarks"]["top"]["x"] = math.nan
        with self.assertRaises(ValueError):
            vector(nonfinite)

        zero_span = deepcopy(self.landmarks["samples"][0])
        zero_span["landmarks"]["chinLeft"] = deepcopy(zero_span["landmarks"]["chinRight"])
        with self.assertRaises(ValueError):
            vector(zero_span)

        zero_face_height = deepcopy(self.landmarks["samples"][0])
        zero_face_height["landmarks"]["chin"]["y"] = zero_face_height["landmarks"]["top"]["y"]
        with self.assertRaises(ValueError):
            vector(zero_face_height)

    def test_temple_slope_is_positive_finite_bounded_and_angular(self) -> None:
        rows = [vector(sample) for sample in self.landmarks["samples"]]
        values = [row["templeSlope"] for row in rows]
        self.assertTrue(all(math.isfinite(value) and value > 0 for value in values))
        self.assertLessEqual(max(values), math.pi / 2)

        sample = deepcopy(self.landmarks["samples"][0])
        landmarks = sample["landmarks"]
        landmarks["hairlineLeft"] = {
            "x": landmarks["templeLeft"]["x"],
            "y": landmarks["templeLeft"]["y"] + 1.0,
        }
        landmarks["hairlineRight"] = {
            "x": landmarks["templeRight"]["x"] + 1.0,
            "y": landmarks["templeRight"]["y"],
        }
        self.assertAlmostEqual(vector(sample)["templeSlope"], math.pi / 4)


if __name__ == "__main__":
    unittest.main()
