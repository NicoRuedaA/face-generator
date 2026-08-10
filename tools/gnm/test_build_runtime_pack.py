#!/usr/bin/env python3
"""Tests for orchestration planning that do not import GNM or NumPy."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import unittest

from build_runtime_pack import CANONICAL_PACK, build_plan, parse_args


class RuntimePackPlanningTest(unittest.TestCase):
    def test_defaults_plan_a_200_head_candidate_without_canonical_replacement(self) -> None:
        args = parse_args([])
        plan = build_plan(args)

        self.assertEqual(plan.count, 200)
        self.assertEqual(plan.families, 8)
        self.assertEqual(plan.seed, 400)
        self.assertEqual(plan.candidate, plan.work_dir / "gnm-morphology-pack-200.json")
        self.assertEqual(plan.canonical, CANONICAL_PACK)
        self.assertNotEqual(plan.candidate, plan.canonical)
        self.assertEqual(len(plan.commands), 4)
        self.assertTrue(all(command[0] == sys.executable for command in plan.commands))
        self.assertIn("sample_gnm_heads.py", plan.commands[0][1])
        self.assertIn("project_gnm_landmarks.py", plan.commands[1][1])
        self.assertIn("build_morphology_pack.py", plan.commands[2][1])
        self.assertIn("validate_morphology_pack.py", plan.commands[3][1])

    def test_custom_paths_are_planned_without_importing_gnm(self) -> None:
        args = parse_args([
            "--count", "32",
            "--seed", "17",
            "--sigma", "0.8",
            "--families", "4",
            "--work-dir", "/tmp/gnm-work",
            "--output", "/tmp/gnm-work/candidate.json",
        ])
        plan = build_plan(args)

        self.assertEqual(plan.work_dir, Path("/tmp/gnm-work"))
        self.assertEqual(plan.candidate, Path("/tmp/gnm-work/candidate.json"))
        self.assertIn("--sigma", plan.commands[0])
        self.assertIn("0.8", plan.commands[0])

    def test_invalid_arguments_are_rejected(self) -> None:
        cases = (
            (["--count", "0"], "--count must be positive"),
            (["--seed", "-1"], "--seed must be zero or greater"),
            (["--sigma", "nan"], "--sigma must be a positive finite number"),
            (["--families", "0"], "--families must be positive"),
            (["--count", "3", "--families", "4"], "--families cannot exceed --count"),
        )
        for argv, message in cases:
            with self.subTest(argv=argv):
                with self.assertRaisesRegex(ValueError, message):
                    parse_args(argv)

    def test_canonical_output_is_rejected_without_a_candidate_boundary(self) -> None:
        args = argparse.Namespace(
            count=200,
            seed=400,
            sigma=1.15,
            families=8,
            output=CANONICAL_PACK,
            work_dir=None,
            promote=True,
            dry_run=False,
        )
        with self.assertRaisesRegex(ValueError, "canonical runtime pack"):
            build_plan(args)


if __name__ == "__main__":
    unittest.main()
