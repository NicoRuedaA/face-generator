#!/usr/bin/env python3
"""Regression coverage for stable GNM landmark normalization."""

from __future__ import annotations

import unittest

import numpy as np

from project_gnm_landmarks import project_samples


class StableNormalizationTest(unittest.TestCase):
    def test_different_sample_heights_remain_different(self) -> None:
        points = {
            "top": [0],
            "left": [1],
            "right": [2],
            "chin": [3],
        }
        template = np.array([
            [0.0, 4.0, 0.0],
            [-2.0, 2.0, 0.0],
            [2.0, 2.0, 0.0],
            [0.0, 0.0, 0.0],
        ])
        short = template.copy()
        short[[0, 3], 1] = [3.0, 1.0]
        tall = template.copy()
        tall[[0, 3], 1] = [4.0, -2.0]

        samples, metadata = project_samples(
            np.stack([short, tall]),
            points,
            horizontal_axis=0,
            vertical_axis=1,
            flip_vertical=False,
            template=template,
        )

        short_height = samples[0]["landmarks"]["chin"]["y"] - samples[0]["landmarks"]["top"]["y"]
        tall_height = samples[1]["landmarks"]["chin"]["y"] - samples[1]["landmarks"]["top"]["y"]
        self.assertNotEqual(short_height, tall_height)
        self.assertEqual(metadata["normalization"]["frame"], "template")


if __name__ == "__main__":
    unittest.main()
