#!/usr/bin/env python3
"""Orchestrate the offline GNM-to-runtime-pack pipeline.

This module intentionally imports only Python's standard library. The active
Python interpreter is passed to each pipeline stage, so GNM and NumPy stay
outside the browser/runtime and outside the normal npm test dependencies.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import math
from pathlib import Path
import shlex
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
GNM_DIR = ROOT / "tools" / "gnm"
DEFAULT_WORK_DIR = GNM_DIR / "work"
CANONICAL_PACK = DEFAULT_WORK_DIR / "gnm-morphology-pack.json"
VERTEX_MAP = DEFAULT_WORK_DIR / "gnm-vertex-map.json"


@dataclass(frozen=True)
class RuntimePackPlan:
    count: int
    seed: int
    sigma: float
    families: int
    work_dir: Path
    meshes: Path
    landmarks: Path
    candidate: Path
    canonical: Path
    commands: tuple[tuple[str, ...], ...]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate and validate a provisional GNM morphology pack. "
            "Promotion to the runtime pack requires --promote."
        )
    )
    parser.add_argument("--count", type=int, default=200, help="neutral GNM heads to sample (default: 200)")
    parser.add_argument("--seed", type=int, default=400, help="deterministic sampler seed (default: 400)")
    parser.add_argument("--sigma", type=float, default=1.15, help="identity sampling standard deviation (default: 1.15)")
    parser.add_argument("--families", type=int, default=8, help="morphology families to cluster (default: 8)")
    parser.add_argument(
        "--output",
        type=Path,
        help="provisional pack path (default: <work-dir>/gnm-morphology-pack-<count>.json)",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        help=f"intermediate artifact directory (default: {DEFAULT_WORK_DIR})",
    )
    parser.add_argument(
        "--promote",
        action="store_true",
        help=f"copy the validated candidate to {CANONICAL_PACK} after explicit review",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the planned commands without running GNM or changing files",
    )
    args = parser.parse_args(argv)
    validate_args(args)
    return args


def validate_args(args: argparse.Namespace) -> None:
    if args.count < 1:
        raise ValueError("--count must be positive")
    if args.seed < 0:
        raise ValueError("--seed must be zero or greater")
    if not math.isfinite(args.sigma) or args.sigma <= 0:
        raise ValueError("--sigma must be a positive finite number")
    if args.families < 1:
        raise ValueError("--families must be positive")
    if args.families > args.count:
        raise ValueError("--families cannot exceed --count")


def absolute_path(path: Path) -> Path:
    return path if path.is_absolute() else (Path.cwd() / path).resolve()


def build_plan(args: argparse.Namespace) -> RuntimePackPlan:
    validate_args(args)
    work_dir = absolute_path(args.work_dir) if args.work_dir else DEFAULT_WORK_DIR
    candidate = absolute_path(args.output) if args.output else work_dir / f"gnm-morphology-pack-{args.count}.json"
    canonical = CANONICAL_PACK
    if candidate == canonical:
        raise ValueError("--output cannot be the canonical runtime pack; use a provisional candidate and --promote")

    meshes = work_dir / f"gnm-heads-{args.count}.npz"
    landmarks = work_dir / f"gnm-landmarks-{args.count}.json"
    python = sys.executable
    commands = (
        (
            python,
            str(GNM_DIR / "sample_gnm_heads.py"),
            "--count", str(args.count),
            "--seed", str(args.seed),
            "--sigma", str(args.sigma),
            "--output", str(meshes),
        ),
        (
            python,
            str(GNM_DIR / "project_gnm_landmarks.py"),
            "--meshes", str(meshes),
            "--vertex-map", str(VERTEX_MAP),
            "--horizontal-axis", "x",
            "--vertical-axis", "y",
            "--flip-vertical",
            "--output", str(landmarks),
        ),
        (
            python,
            str(GNM_DIR / "build_morphology_pack.py"),
            "--input", str(landmarks),
            "--families", str(args.families),
            "--seed", str(args.seed),
            "--output", str(candidate),
        ),
        (python, str(GNM_DIR / "validate_morphology_pack.py"), str(candidate)),
    )
    return RuntimePackPlan(
        count=args.count,
        seed=args.seed,
        sigma=args.sigma,
        families=args.families,
        work_dir=work_dir,
        meshes=meshes,
        landmarks=landmarks,
        candidate=candidate,
        canonical=canonical,
        commands=commands,
    )


def command_text(command: tuple[str, ...] | list[str]) -> str:
    return shlex.join(str(part) for part in command)


def promotion_command(args: argparse.Namespace) -> str:
    values = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--count", str(args.count),
        "--seed", str(args.seed),
        "--sigma", str(args.sigma),
        "--families", str(args.families),
        "--promote",
    ]
    if args.output:
        values.extend(("--output", str(args.output)))
    if args.work_dir:
        values.extend(("--work-dir", str(args.work_dir)))
    return command_text(values)


def print_follow_up_commands() -> None:
    print("Follow-up commands after reviewing the promoted pack:")
    print("  npm run build:offline")
    print("  npm test")
    print("  npm run refresh:release")
    print("  python3 -m json.tool docs/release-manifest-v040.json >/dev/null")


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        plan = build_plan(args)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print(f"Using Python: {sys.executable}")
    print(f"Candidate: {plan.candidate}")
    print(f"Runtime pack (unchanged unless --promote): {plan.canonical}")
    for command in plan.commands:
        print(f"$ {command_text(command)}")
    if args.dry_run:
        if args.promote:
            print(f"$ cp {shlex.quote(str(plan.candidate))} {shlex.quote(str(plan.canonical))}")
            print_follow_up_commands()
        else:
            print("Dry run only; no candidate was generated or promoted.")
        return 0

    plan.work_dir.mkdir(parents=True, exist_ok=True)
    for command in plan.commands:
        try:
            subprocess.run(command, cwd=ROOT, check=True)
        except subprocess.CalledProcessError as error:
            print(
                f"Pipeline stage failed with exit code {error.returncode}: {command_text(command)}",
                file=sys.stderr,
            )
            return error.returncode or 1

    if not args.promote:
        print(f"Validated candidate retained for review: {plan.candidate}")
        print(f"To promote it after review, rerun with --promote: {promotion_command(args)}")
        return 0

    shutil.copyfile(plan.candidate, plan.canonical)
    print(f"Promoted validated candidate to runtime pack: {plan.canonical}")
    print_follow_up_commands()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
