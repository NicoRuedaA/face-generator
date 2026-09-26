#!/usr/bin/env python3
"""Build the portable GNM 3D player-generator payload (Phase 8).

The browser never runs GNM. This offline builder reads the exact official GNM
Head v3.0 NPZ (hash-pinned), the official sparse 68 landmark definition and the
official expression decoder of the GNM semantic sampler, and emits one compact
binary plus JSON metadata:

* the first ``IDENTITY_PRIOR_COUNT`` official head identity directions, which
  the runtime samples from the documented unit Gaussian prior;
* one full-model direction per landmark-measured anthropometric feature
  (normalized gradient over all 170 head components), stored as its "tail"
  beyond the prior components so the runtime can condition the prior sample
  on FaceDNA feature targets exactly (Matheron's rule for a linear Gaussian);
* official expression presets decoded from the semantic sampler CVAE at the
  latent mean (z = 0) for a small set of labelled classes;
* per-vertex appearance fields derived deterministically from official vertex
  groups and landmarks (iris angle, lips, brows, beard, scalp, ...). They are
  procedural painting coordinates, not official textures.

Vectors are int16 with one float32 scale each (meters); fields are uint8 with
a linear range recorded in the metadata. NumPy (and h5py for the decoder) are
offline-only dependencies of this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys

try:
    import numpy as np
except ImportError:  # pragma: no cover - reported explicitly below
    np = None


ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "tools/gnm/work"
GNM_ROOT = Path(os.environ.get("GNM_ROOT", "/home/nico/src/GNM"))
DEFAULT_NPZ = Path(os.environ.get("GNM_NPZ", GNM_ROOT / "gnm/shape/data/versions/v3_0/gnm_head.npz"))
DEFAULT_LANDMARKS = Path(os.environ.get("GNM_LANDMARKS", GNM_ROOT / "gnm/shape/data/landmarks/head_sparse_68.txt"))
DEFAULT_DECODER = Path(os.environ.get("GNM_EXPRESSION_DECODER", GNM_ROOT / "gnm/shape/data/semantic_sampler/expression_decoder_model.h5"))
DEFAULT_RENDER = WORK / "gnm-official-head-render.glb"
DEFAULT_LICENSE = WORK / "LICENSE-GNM.txt"
DEFAULT_OUTPUT = WORK / "gnm-player-generator.bin"
DEFAULT_OUTPUT_METADATA = WORK / "gnm-player-generator.json"

SCHEMA = "sports-face-gnm-player-generator/v1"
MAGIC = b"SFGNMPL1"
VERSION = 1
HEADER_STRUCT = struct.Struct("<8sIIIIIIIIIIIIII")
HEADER_BYTES = HEADER_STRUCT.size
MAX_BYTES = 6_815_744  # 6.5 MiB
SOURCE_REPOSITORY = "https://github.com/google/GNM"
NPZ_REVISION = "8ea2906a31aab7f8b550e33968f3c0a86051a92d"
NPZ_PATH = "gnm/shape/data/versions/v3_0/gnm_head.npz"
NPZ_SHA256 = "03649b09d1f756c94e8b3db709edcfa07ac367de0ba35e2d04c985ebcadbaf14"
NPZ_SIZE = 53305389
LANDMARKS_PATH = "gnm/shape/data/landmarks/head_sparse_68.txt"
LANDMARKS_REVISION = "0ae8cc7aa2ef3c08dbc7fd35d6772869380e7f96"
LANDMARKS_SHA256 = "d8b6066a87ca37c48bcf4d0834542db841709b65cb983e873fa1e441a22219d0"
LANDMARKS_PINNED_SHA256 = "8b4b759042cae8b67062794306dae9d60fc7ba11ddad60461ba3e2bfaaeac222"
LANDMARKS_FIX = "upstream 0ae8cc7 reverses lines 3-7 (anchors 2-6) so the jaw contour 0..16 is continuous (300-W iBUG 68 order); vertex topology is unchanged"
DECODER_PATH = "gnm/shape/data/semantic_sampler/expression_decoder_model.h5"
DECODER_REVISION = NPZ_REVISION
DECODER_SHA256 = "5eba165f8a414f73b24be96963d0a17e708c0856739ed85a19031f318dfb51e6"
RENDER_SHA256 = "081ddb9b1f6b26a76255fb1710b763bcb105941139cba1490a501b99c568e23f"
LICENSE_SHA256 = "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd"
COMPONENTS = ("skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue")
SOURCE_VERTEX_COUNT = 17821
HEAD_IDENTITY_COUNT = 170
IDENTITY_PRIOR_COUNT = 32
EXPRESSION_CLASSES = (
    "SURPRISE", "DISGUST", "SUCK", "COMPRESS_FACE", "STRETCH_FACE", "HAPPY", "SQUINT", "PLATYSMA", "BLOW", "FUNNELER",
    "SMILE_WIDE", "CORNERS_DOWN", "PUCKER", "WINK_LEFT", "WINK_RIGHT", "MOUTH_LEFT", "MOUTH_RIGHT", "LIPS_ROLL_IN", "SNARL", "TONGUE_CENTER",
)
EXPRESSION_PRESETS = (("surprise", "SURPRISE"), ("happy", "HAPPY"), ("squint", "SQUINT"))
DECODER_LATENT_DIM = 64
MM = 1000.0

# Linear anthropometric features over official landmarks (index into the
# fixed 68-point definition) and fixed template vertices. Every feature is a
# linear functional of vertex positions, so it is exactly linear in the GNM
# identity coefficients.
FEATURES = (
    ("faceWidth", "Bizygomatic-level contour width, landmarks 0-16", (("lm", 16, "x", 1.0), ("lm", 0, "x", -1.0))),
    ("jawWidth", "Lower jaw contour width, landmarks 4-12", (("lm", 12, "x", 1.0), ("lm", 4, "x", -1.0))),
    ("chinWidth", "Chin contour width, landmarks 6-10", (("lm", 10, "x", 1.0), ("lm", 6, "x", -1.0))),
    ("faceHeight", "Nasion to menton height, landmarks 27-8", (("lm", 27, "y", 1.0), ("lm", 8, "y", -1.0))),
    ("foreheadHeight", "Forehead-region top (midline) above nasion", (("vertex", "foreheadTop", "y", 1.0), ("lm", 27, "y", -1.0))),
    ("noseLength", "Nasion to subnasale height, landmarks 27-33", (("lm", 27, "y", 1.0), ("lm", 33, "y", -1.0))),
    ("noseWidth", "Alar width, landmarks 31-35", (("lm", 35, "x", 1.0), ("lm", 31, "x", -1.0))),
    ("noseProjection", "Tip projection ahead of the alar base, landmarks 30 vs 31/35", (("lm", 30, "z", 1.0), ("lm", 31, "z", -0.5), ("lm", 35, "z", -0.5))),
    ("bridgeHeight", "Nasal bridge ahead of the inner canthi, landmarks 28 vs 39/42", (("lm", 28, "z", 1.0), ("lm", 39, "z", -0.5), ("lm", 42, "z", -0.5))),
    ("mouthWidth", "Mouth corner width, landmarks 48-54", (("lm", 54, "x", 1.0), ("lm", 48, "x", -1.0))),
    ("lipThickness", "Outer lip height, landmarks 51-57", (("lm", 51, "y", 1.0), ("lm", 57, "y", -1.0))),
    ("mouthCornerLift", "Mouth corners above the inner lip midline, landmarks 48/54 vs 62/66", (("lm", 48, "y", 0.5), ("lm", 54, "y", 0.5), ("lm", 62, "y", -0.5), ("lm", 66, "y", -0.5))),
    ("eyeWidth", "Palpebral fissure width, landmarks 36-39 and 42-45", (("lm", 39, "x", 0.5), ("lm", 36, "x", -0.5), ("lm", 45, "x", 0.5), ("lm", 42, "x", -0.5))),
    ("eyeOpening", "Palpebral fissure height, landmarks 37/38-41/40 and 43/44-47/46", (("lm", 37, "y", 0.25), ("lm", 41, "y", -0.25), ("lm", 38, "y", 0.25), ("lm", 40, "y", -0.25), ("lm", 43, "y", 0.25), ("lm", 47, "y", -0.25), ("lm", 44, "y", 0.25), ("lm", 46, "y", -0.25))),
    ("canthalTilt", "Outer canthus above inner canthus, landmarks 36/39 and 45/42", (("lm", 36, "y", 0.5), ("lm", 39, "y", -0.5), ("lm", 45, "y", 0.5), ("lm", 42, "y", -0.5))),
    ("eyeDepth", "Brow ridge ahead of the upper lid, landmarks 19/37 and 24/44", (("lm", 19, "z", 0.5), ("lm", 37, "z", -0.5), ("lm", 24, "z", 0.5), ("lm", 44, "z", -0.5))),
    ("browHeight", "Brow above the upper lid, landmarks 19/37 and 24/44", (("lm", 19, "y", 0.5), ("lm", 37, "y", -0.5), ("lm", 24, "y", 0.5), ("lm", 44, "y", -0.5))),
    ("earHeight", "Ear top to lobule bottom (fixed template vertices)", (("vertex", "rightEarTop", "y", 0.5), ("vertex", "rightEarBottom", "y", -0.5), ("vertex", "leftEarTop", "y", 0.5), ("vertex", "leftEarBottom", "y", -0.5))),
    ("earProjection", "Outer helix beyond the face contour (fixed vertices vs landmarks 0/16)", (("lm", 0, "x", 0.5), ("vertex", "rightEarOuter", "x", -0.5), ("vertex", "leftEarOuter", "x", 0.5), ("lm", 16, "x", -0.5))),
)
AXES = {"x": 0, "y": 1, "z": 2}

# (key, min, max, unit, derivation). Field-major uint8 storage, linear range.
FIELDS = (
    ("lip", 0.0, 1.0, "mask", "official upper_lip | lower_lip, 2 mesh smoothing passes"),
    ("mouthSock", 0.0, 1.0, "mask", "official mouth_sock, 1 smoothing pass"),
    ("teeth", 0.0, 1.0, "mask", "official teeth (vs gums) inside the teeth components, 1 smoothing pass"),
    ("cornea", 0.0, 1.0, "mask", "official eye_exteriors (transparent cornea shell)"),
    ("irisAngle", 0.0, 180.0, "deg", "angle from the gaze axis (sclera sphere fit center -> official pupil centroid) per eye; 180 outside the eyes"),
    ("freckleZone", 0.0, 1.0, "mask", "official nose, infraorbital, cheek and zygomatic regions on the exterior skin, 3 smoothing passes"),
    ("ear", 0.0, 1.0, "mask", "official ears, 1 smoothing pass"),
    ("eyeSocket", 0.0, 1.0, "mask", "official eye_sockets, 1 smoothing pass"),
    ("scalpHeight", -64.0, 64.0, "mm", "height above a smooth baseline hairline h(azimuth) anchored to the official forehead region and ears; -64 on ears and non-exterior skin"),
    ("scalpFront", -1.0, 1.0, "cos", "cosine of the azimuth around the vertical head axis through the ear centroid (1 = face, -1 = nape); continuous, unlike the azimuth"),
    ("neckHeight", 0.0, 127.5, "mm", "height above the open neck boundary at the same azimuth"),
    ("scarDist", 0.0, 32.0, "mm", "distance to a fixed vertical segment through the subject-left brow (landmark 25)"),
    ("browT", -0.5, 1.5, "ratio", "arc-length parameter along the same-side brow landmarks (0 = inner end 21/22, 1 = outer end 17/26), linearly extrapolated; continuous"),
    ("browD", -24.0, 24.0, "mm", "vertical offset from the same-side brow landmark polyline at the closest point; continuous"),
    ("blushZone", 0.0, 1.0, "mask", "official cheek and zygomatic regions, 3 smoothing passes"),
    ("faceMask", 0.0, 1.0, "mask", "official hockey_mask, 2 smoothing passes"),
    ("beardUpper", -64.0, 64.0, "mm", "height above the cheek line anchored to landmarks 33, 48/54, 2/14 and the ear front"),
    ("beardLower", -64.0, 64.0, "mm", "height above the neck line (jaw contour landmarks 2..14 lowered 22-30 mm)"),
    ("mouthDX", -64.0, 64.0, "mm", "x offset from the mouth center (landmarks 48/54); continuous, gated by scalpFront at runtime"),
    ("mouthDY", -64.0, 64.0, "mm", "y offset from the inner lip midline (landmarks 62/66); continuous, gated by scalpFront at runtime"),
)


class PlayerGeneratorError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PlayerGeneratorError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def f32(value: float) -> float:
    return float(np.float32(value))


def f32_short(value: float) -> float:
    """Shortest decimal that round-trips to the same float32 (compact JSON)."""
    return float(str(np.float32(value)))


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    require(len(data) >= 20, f"{path.name} is shorter than a GLB header")
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    require(magic == b"glTF" and version == 2 and length == len(data), f"{path.name} GLB header is invalid")
    offset = 12
    document = None
    binary = None
    while offset < len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        start = offset + 8
        end = start + chunk_length
        require(end <= len(data), f"{path.name} chunk exceeds the file")
        if chunk_type == 0x4E4F534A:
            document = json.loads(data[start:end].decode("utf-8").rstrip(" \0"))
        elif chunk_type == 0x004E4942:
            binary = data[start:end]
        offset = end
    require(document is not None and binary is not None, f"{path.name} must contain JSON and BIN chunks")
    return document, binary


def accessor_array(document: dict, binary: bytes, index: int, dtype: str, components: int) -> "np.ndarray":
    accessor = document["accessors"][index]
    view = document["bufferViews"][accessor["bufferView"]]
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]
    array = np.frombuffer(binary, dtype=np.dtype(dtype).newbyteorder("<"), count=count * components, offset=offset)
    return array.reshape(count, components) if components > 1 else array


def render_source_ids(render_path: Path, template: "np.ndarray") -> tuple[list[dict], "np.ndarray"]:
    document, binary = read_glb(render_path)
    official = document.get("extras", {}).get("sportsFaceGnmOfficial", {})
    require(official.get("renderOnly") is True and official.get("basisIncluded") is False, "render GLB must be the render-only official asset")
    primitives = document["meshes"][0]["primitives"]
    require([primitive["extras"]["componentName"] for primitive in primitives] == list(COMPONENTS), "render GLB component order is invalid")
    records = []
    ids = []
    render_offset = 0
    for primitive in primitives:
        positions = accessor_array(document, binary, primitive["attributes"]["POSITION"], "f4", 3)
        source = accessor_array(document, binary, primitive["extras"]["sourceVertexIndicesAccessor"], "u4", 1).astype(np.int64)
        require(len(source) == len(positions), "render sourceVertexId count differs from POSITION")
        require(int(source.max()) < SOURCE_VERTEX_COUNT, "render sourceVertexId is out of range")
        require(np.array_equal(positions.view(np.uint32), template.astype(np.float32)[source].view(np.uint32)), f"render {primitive['extras']['componentName']} POSITION differs from the official template")
        records.append({"name": primitive["extras"]["componentName"], "renderVertexOffset": render_offset, "renderVertexCount": int(len(source)), "sourceVertexMin": int(source.min()), "sourceVertexMax": int(source.max())})
        render_offset += len(source)
        ids.append(source)
    all_ids = np.concatenate(ids)
    require(set(all_ids.tolist()) == set(range(SOURCE_VERTEX_COUNT)), "render sourceVertexIds must cover every official vertex")
    return records, all_ids


def load_landmarks(path: Path) -> tuple[list[list[float]], str]:
    raw = path.read_bytes()
    digest = sha256_bytes(raw)
    lines = raw.decode("ascii").splitlines()
    if digest == LANDMARKS_PINNED_SHA256:
        # The project pins GNM 8ea2906, whose landmark file lists jaw anchors
        # 2..6 in reverse. Apply exactly the documented upstream fix.
        lines = lines[:2] + lines[2:7][::-1] + lines[7:]
        fixed = ("\n".join(lines) + "\n").encode("ascii")
        require(sha256_bytes(fixed) == LANDMARKS_SHA256, "landmark reorder did not reproduce the fixed upstream file")
        digest = LANDMARKS_SHA256
    require(digest == LANDMARKS_SHA256, "landmark definition SHA-256 is not the reviewed upstream file")
    rows = [[float(value) for value in line.split()] for line in lines if line.strip()]
    require(len(rows) == 68 and all(len(row) == 6 for row in rows), "landmark definition must be 68 rows of 3 (index, weight) pairs")
    return rows, digest


def landmark_matrix(rows: list[list[float]]) -> tuple["np.ndarray", "np.ndarray"]:
    indices = np.array([[int(row[0]), int(row[2]), int(row[4])] for row in rows], dtype=np.int64)
    weights = np.array([[row[1], row[3], row[5]] for row in rows], dtype=np.float64)
    require(int(indices.max()) < SOURCE_VERTEX_COUNT and int(indices.min()) >= 0, "landmark vertex index out of range")
    return indices, weights


def landmarks_of(points: "np.ndarray", indices: "np.ndarray", weights: "np.ndarray") -> "np.ndarray":
    return np.einsum("lk,lkc->lc", weights, points[indices], optimize=False)


def load_decoder(path: Path) -> list[tuple["np.ndarray", "np.ndarray"]]:
    try:
        import h5py
    except ImportError as error:  # pragma: no cover - environment dependent
        raise PlayerGeneratorError("h5py is required to read the official expression decoder") from error
    layers = []
    with h5py.File(path, "r") as handle:
        weights = handle["model_weights"]
        names = sorted((name for name in weights.keys() if name.startswith("dense")), key=lambda name: int(name.split("_")[1]))
        for name in names:
            group = weights[name][name]
            layers.append((np.array(group["kernel:0"], dtype=np.float64), np.array(group["bias:0"], dtype=np.float64)))
    require([kernel.shape for kernel, _ in layers] == [(84, 64), (64, 128), (128, 256), (256, 512), (512, 383)], "expression decoder architecture is unexpected")
    return layers


def decode_expression(layers: list[tuple["np.ndarray", "np.ndarray"]], class_index: int) -> "np.ndarray":
    label = np.zeros(len(EXPRESSION_CLASSES), dtype=np.float64)
    label[class_index] = 1.0
    value = np.concatenate([np.zeros(DECODER_LATENT_DIM, dtype=np.float64), label])
    for layer, (kernel, bias) in enumerate(layers):
        value = np.einsum("i,io->o", value, kernel, optimize=False) + bias
        if layer < len(layers) - 1:
            value = np.maximum(value, 0.0)
    return value


def edges_of(triangles: "np.ndarray") -> "np.ndarray":
    pairs = np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]])
    pairs.sort(axis=1)
    return np.unique(pairs, axis=0)


def smooth(mask: "np.ndarray", edges: "np.ndarray", passes: int) -> "np.ndarray":
    value = mask.astype(np.float64)
    degree = np.bincount(edges.ravel(), minlength=len(value)).astype(np.float64)
    for _ in range(passes):
        total = value.copy()
        np.add.at(total, edges[:, 0], value[edges[:, 1]])
        np.add.at(total, edges[:, 1], value[edges[:, 0]])
        value = total / (1.0 + degree)
    return value


def periodic_curve(knots: list[tuple[float, float]], angles: "np.ndarray") -> "np.ndarray":
    """Periodic Catmull-Rom interpolation of (angle, value) knots over [-pi, pi)."""
    ordered = sorted(knots)
    xs = [angle for angle, _ in ordered]
    ys = [value for _, value in ordered]
    count = len(xs)
    result = np.empty_like(angles)
    for position, angle in enumerate(angles):
        a = angle
        index = max(i for i in range(count) if xs[i] <= a) if a >= xs[0] else count - 1
        x0 = xs[index]
        x1 = xs[(index + 1) % count] + (2 * math.pi if index + 1 >= count else 0.0)
        if a < x0:
            a += 2 * math.pi
        t = (a - x0) / (x1 - x0)
        p0, p1, p2, p3 = (ys[(index + offset) % count] for offset in (-1, 0, 1, 2))
        result[position] = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
    return result


def symmetric_curve(knots: list[tuple[float, float]], angles: "np.ndarray") -> "np.ndarray":
    mirrored = knots + [(-angle, value) for angle, value in knots if angle > 0]
    return periodic_curve(mirrored, angles)


def polyline_param(points: "np.ndarray", polyline: "np.ndarray") -> tuple["np.ndarray", "np.ndarray", "np.ndarray"]:
    """Closest point parameter (arc length ratio, extrapolated), point and distance."""
    segments = polyline[1:] - polyline[:-1]
    lengths = np.linalg.norm(segments, axis=1)
    cumulative = np.concatenate([[0.0], np.cumsum(lengths)])
    total = cumulative[-1]
    best_distance = np.full(len(points), np.inf)
    best_t = np.zeros(len(points))
    best_point = np.zeros((len(points), 3))
    for index, (start, segment, length) in enumerate(zip(polyline[:-1], segments, lengths)):
        u = np.einsum("pc,c->p", points - start, segment, optimize=False) / (length * length)
        low = -np.inf if index == 0 else 0.0
        high = np.inf if index == len(segments) - 1 else 1.0
        u = np.clip(u, low, high)
        closest = start + u[:, None] * segment
        distance = np.linalg.norm(points - closest, axis=1)
        better = distance < best_distance
        best_distance = np.where(better, distance, best_distance)
        best_t = np.where(better, (cumulative[index] + u * length) / total, best_t)
        best_point = np.where(better[:, None], closest, best_point)
    return best_t, best_point, best_distance


def quantize_field(values: "np.ndarray", low: float, high: float) -> bytes:
    scaled = np.clip(np.round((np.clip(values, low, high) - low) / (high - low) * 255.0), 0, 255)
    return scaled.astype(np.uint8).tobytes()


def quantize_vector(vector: "np.ndarray") -> tuple[bytes, float, float]:
    peak = float(np.abs(vector).max())
    require(math.isfinite(peak) and peak > 0.0, "cannot quantize an empty or non-finite vector")
    scale = f32(peak / 32767.0)
    quantized = np.clip(np.round(vector / scale), -32767, 32767).astype("<i2")
    error = float(np.abs(quantized.astype(np.float64) * scale - vector).max())
    return quantized.tobytes(), scale, error


def fixed_vertices(template: "np.ndarray", group) -> dict[str, int]:
    forehead = np.flatnonzero(group("forehead_region") & (np.abs(template[:, 0]) < 0.005))
    require(len(forehead) > 0, "no midline forehead vertices")
    result = {"foreheadTop": int(forehead[np.argmax(template[forehead, 1])])}
    for side, sign in (("right", -1.0), ("left", 1.0)):
        ear = np.flatnonzero(group("ears") & (np.sign(template[:, 0]) == sign))
        require(len(ear) > 0, f"no {side} ear vertices")
        result[f"{side}EarTop"] = int(ear[np.argmax(template[ear, 1])])
        result[f"{side}EarBottom"] = int(ear[np.argmin(template[ear, 1])])
        result[f"{side}EarOuter"] = int(ear[np.argmax(np.abs(template[ear, 0]))])
    return result


def feature_rows(template, basis, lm_indices, lm_weights, fixed):
    """Template value (m) and gradient (m per unit coefficient) of each feature."""
    template_landmarks = landmarks_of(template, lm_indices, lm_weights)
    basis_landmarks = np.einsum("lk,ilkc->ilc", lm_weights, basis[:, lm_indices], optimize=False)
    definitions = []
    values = []
    gradients = []
    for key, description, terms in FEATURES:
        value = 0.0
        gradient = np.zeros(basis.shape[0])
        encoded_terms = []
        for kind, ref, axis_name, weight in terms:
            axis = AXES[axis_name]
            if kind == "lm":
                value += weight * template_landmarks[ref, axis]
                gradient += weight * basis_landmarks[:, ref, axis]
                encoded_terms.append({"landmark": ref, "axis": axis_name, "weight": weight})
            else:
                vertex = fixed[ref]
                value += weight * template[vertex, axis]
                gradient += weight * basis[:, vertex, axis]
                encoded_terms.append({"vertex": ref, "axis": axis_name, "weight": weight})
        definitions.append({"key": key, "description": description, "terms": encoded_terms})
        values.append(value)
        gradients.append(gradient)
    return definitions, np.array(values), np.array(gradients)


def compute_fields(template, triangles, group, lm_indices, lm_weights, skin_boundary):
    V = len(template)
    x, y, z = template[:, 0], template[:, 1], template[:, 2]
    edges = edges_of(triangles)
    exterior = group("skin_exterior")
    landmarks = landmarks_of(template, lm_indices, lm_weights)
    fields = {}
    fields["lip"] = smooth(group("upper_lip") | group("lower_lip"), edges, 2)
    fields["mouthSock"] = smooth(group("mouth_sock"), edges, 1)
    teeth_components = group("upper_teeth_and_gums") | group("lower_teeth_and_gums")
    fields["teeth"] = np.where(teeth_components, smooth(group("teeth"), edges, 1), 0.0)
    fields["cornea"] = group("eye_exteriors").astype(np.float64)

    iris_angle = np.full(V, 180.0)
    eye_records = {}
    for component in ("left_eye", "right_eye"):
        eye = group(component)
        sclera = template[eye & group("scleras")]
        system = np.c_[2 * sclera, np.ones(len(sclera))]
        solution = np.linalg.lstsq(system, (sclera ** 2).sum(1), rcond=None)[0]
        center = solution[:3]
        pupil = template[eye & group("pupils")].mean(0)
        axis = (pupil - center) / np.linalg.norm(pupil - center)
        offsets = template[eye] - center
        cosine = np.clip(np.einsum("vc,c->v", offsets / np.linalg.norm(offsets, axis=1, keepdims=True), axis, optimize=False), -1.0, 1.0)
        angles = np.degrees(np.arccos(cosine))
        iris_angle[eye] = angles
        members = np.flatnonzero(eye)
        position = {vertex: order for order, vertex in enumerate(members)}
        pupil_max = max(angles[position[v]] for v in np.flatnonzero(eye & group("pupils")))
        iris_max = max(angles[position[v]] for v in np.flatnonzero(eye & group("irises")))
        sclera_min = min(angles[position[v]] for v in np.flatnonzero(eye & group("scleras")))
        eye_records[component] = {"pupilMaxDeg": round(float(pupil_max), 3), "irisMaxDeg": round(float(iris_max), 3), "scleraMinDeg": round(float(sclera_min), 3), "sphereRadiusMm": round(float(np.sqrt(solution[3] + center @ center) * MM), 3)}
    fields["irisAngle"] = iris_angle

    freckle = group("nose_region") | group("left_infraorbital_region") | group("right_infraorbital_region") | group("left_cheek_region") | group("right_cheek_region") | group("left_zygomatic_region") | group("right_zygomatic_region")
    fields["freckleZone"] = np.where(exterior, smooth(freckle & exterior, edges, 3), 0.0)
    fields["ear"] = smooth(group("ears"), edges, 1)
    fields["eyeSocket"] = smooth(group("eye_sockets"), edges, 1)

    ears = group("ears")
    ear_center_z = float(template[ears, 2].mean())
    azimuth = np.arctan2(x, z - ear_center_z)
    ear_top = float(template[ears, 1].max())
    forehead_top = float(template[group("forehead_region") & (np.abs(x) < 0.005), 1].max())
    hairline = symmetric_curve([
        (0.0, forehead_top + 0.004),
        (0.55, forehead_top - 0.002),
        (0.95, forehead_top - 0.020),
        (1.25, ear_top - 0.010),
        (1.55, ear_top + 0.006),
        (1.95, ear_top + 0.004),
        (2.35, ear_top - 0.030),
        (math.pi, ear_top - 0.060),
    ], azimuth)
    scalp = (y - hairline) * MM
    scalp = np.where(exterior & ~ears, scalp, -64.0)
    fields["scalpHeight"] = scalp
    fields["scalpFront"] = np.cos(azimuth)

    boundary = template[skin_boundary]
    boundary_azimuth = np.arctan2(boundary[:, 0], boundary[:, 2] - ear_center_z)
    order = np.argsort(boundary_azimuth)
    neck_bottom = np.interp(azimuth, boundary_azimuth[order], boundary[order, 1], period=2 * math.pi)
    fields["neckHeight"] = np.where(group("skin"), (y - neck_bottom) * MM, 127.5)

    scar_top = landmarks[25] + np.array([0.0, 0.010, 0.0])
    scar_bottom = landmarks[25] + np.array([0.0, -0.007, 0.0])
    _, _, scar_distance = polyline_param(template, np.stack([scar_top, scar_bottom]))
    fields["scarDist"] = np.where(exterior, scar_distance * MM, 32.0)

    # Continuous everywhere (no sentinel cut-off): interpolation across a
    # sentinel boundary would paint thin false brow lines.
    brow_t = np.full(V, 1.5)
    brow_d = np.full(V, 24.0)
    for sign, chain in ((-1.0, (21, 20, 19, 18, 17)), (1.0, (22, 23, 24, 25, 26))):
        side = exterior & (np.where(x == 0.0, -1.0, np.sign(x)) == sign)
        points = template[side]
        t, closest, _ = polyline_param(points, landmarks[list(chain)])
        brow_t[side] = t
        brow_d[side] = (points[:, 1] - closest[:, 1]) * MM
    fields["browT"] = brow_t
    fields["browD"] = brow_d
    blush = group("left_cheek_region") | group("right_cheek_region") | group("left_zygomatic_region") | group("right_zygomatic_region")
    fields["blushZone"] = np.where(exterior, smooth(blush & exterior, edges, 3), 0.0)
    fields["faceMask"] = smooth(group("hockey_mask"), edges, 2)

    def lm_azimuth(index: int) -> float:
        return float(np.arctan2(landmarks[index, 0], landmarks[index, 2] - ear_center_z))

    ear_front = float(np.abs(azimuth[ears]).min())
    corner =0.5 * (abs(lm_azimuth(48)) + abs(lm_azimuth(54)))
    corner_y = 0.5 * (landmarks[48, 1] + landmarks[54, 1])
    jaw_side = 0.5 * (abs(lm_azimuth(2)) + abs(lm_azimuth(14)))
    jaw_side_y = 0.5 * (landmarks[2, 1] + landmarks[14, 1])
    cheek_line = symmetric_curve([
        (0.0, landmarks[33, 1] - 0.001),
        (corner, corner_y + 0.012),
        (0.5 * (corner + jaw_side), 0.5 * (corner_y + jaw_side_y) + 0.022),
        (jaw_side, jaw_side_y + 0.028),
        (ear_front, ear_top - 0.004),
        (1.55, ear_top - 0.030),
        (1.85, 0.0),
        (math.pi, 0.0),
    ], azimuth)
    fields["beardUpper"] = np.where(exterior & ~ears, (y - cheek_line) * MM, 64.0)
    jaw_knots = [(abs(lm_azimuth(index)), landmarks[index, 1] - 0.022 - 0.008 * (1.0 - abs(index - 8) / 6.0)) for index in range(8, 15)]
    jaw_knots += [(1.55, jaw_side_y + 0.010), (1.85, 1.0), (math.pi, 1.0)]
    neck_line = symmetric_curve(jaw_knots, azimuth)
    fields["beardLower"] = np.where(exterior & ~ears, (y - neck_line) * MM, -64.0)
    mouth_center = 0.5 * (landmarks[48] + landmarks[54])
    lip_mid_y = 0.5 * (landmarks[62, 1] + landmarks[66, 1])
    # Continuous offsets; the shader gates them with the continuous scalpFront.
    fields["mouthDX"] = (x - mouth_center[0]) * MM
    fields["mouthDY"] = (y - lip_mid_y) * MM
    anchors = {
        "earCenterZmm": round(ear_center_z * MM, 3),
        "earTopMm": round(ear_top * MM, 3),
        "foreheadTopMm": round(forehead_top * MM, 3),
        "mouthCornerAzimuthDeg": round(math.degrees(corner), 3),
        "eyes": eye_records,
    }
    return fields, anchors


def build(npz_path: Path, landmarks_path: Path, decoder_path: Path, render_path: Path, license_path: Path, output_path: Path, output_metadata_path: Path) -> dict:
    require(np is not None, "NumPy is required for the offline player-generator builder")
    require(npz_path.stat().st_size == NPZ_SIZE and sha256(npz_path) == NPZ_SHA256, "official GNM NPZ does not match the pinned SHA-256/size")
    require(sha256(decoder_path) == DECODER_SHA256, "official expression decoder does not match the pinned SHA-256")
    require(sha256(render_path) == RENDER_SHA256, "render GLB does not match the accepted SHA-256")
    require(sha256(license_path) == LICENSE_SHA256, "GNM license text does not match the accepted SHA-256")
    landmark_rows, landmarks_digest = load_landmarks(landmarks_path)
    lm_indices, lm_weights = landmark_matrix(landmark_rows)

    with np.load(npz_path, allow_pickle=False) as data:
        template = data["template_vertex_positions"].astype(np.float64)
        identity = data["vertex_identity_basis"].astype(np.float64)
        expression = data["expression_basis"].astype(np.float64)
        identity_names = [str(name) for name in data["identity_names"]]
        triangles = data["triangles"].astype(np.int64)
        group_names = [str(name) for name in data["vertex_group_names"]]
        groups = data["vertex_groups"].astype(np.float64)
        component_names = [str(name) for name in data["mesh_component_names"]]
    require(template.shape == (SOURCE_VERTEX_COUNT, 3), "template shape is unexpected")
    require(identity.shape == (253, SOURCE_VERTEX_COUNT, 3) and expression.shape == (383, SOURCE_VERTEX_COUNT, 3), "basis shape is unexpected")
    require(identity_names[:HEAD_IDENTITY_COUNT] == [f"head_{index:03d}" for index in range(HEAD_IDENTITY_COUNT)], "head identity names are unexpected")
    require(component_names == list(COMPONENTS), "official component names are unexpected")

    def group(name: str) -> "np.ndarray":
        return groups[group_names.index(name)] > 0.5

    components, render_ids = render_source_ids(render_path, template)
    head_basis = identity[:HEAD_IDENTITY_COUNT]
    fixed = fixed_vertices(template, group)
    definitions, values, gradients = feature_rows(template, head_basis, lm_indices, lm_weights, fixed)
    std = np.linalg.norm(gradients, axis=1)
    require(np.all(std > 1e-6), "a feature has no identity variance")
    normalized = np.array([[f32(value) for value in row] for row in gradients / std[:, None]], dtype=np.float64)
    correlation = normalized @ normalized.T

    vectors = []
    identity_records = []
    for index in range(IDENTITY_PRIOR_COUNT):
        vectors.append(head_basis[index])
        identity_records.append({"index": index, "name": identity_names[index], "vectorIndex": len(vectors) - 1})
    feature_records = []
    for row, definition in enumerate(definitions):
        tail = np.einsum("k,kvc->vc", normalized[row, IDENTITY_PRIOR_COUNT:], head_basis[IDENTITY_PRIOR_COUNT:], optimize=False)
        vectors.append(tail)
        prior_share = float((normalized[row, :IDENTITY_PRIOR_COUNT] ** 2).sum())
        feature_records.append({
            **definition,
            "templateValueMm": round(float(values[row] * MM), 6),
            "stdDevMm": round(float(std[row] * MM), 6),
            "priorVarianceShare": round(prior_share, 6),
            "normalizedGradient": [f32_short(value) for value in normalized[row]],
            "tailVectorIndex": len(vectors) - 1,
        })

    layers = load_decoder(decoder_path)
    expression_records = []
    for key, class_name in EXPRESSION_PRESETS:
        class_index = EXPRESSION_CLASSES.index(class_name)
        coefficients = np.array([f32(value) for value in decode_expression(layers, class_index)], dtype=np.float64)
        delta = np.einsum("e,evc->vc", coefficients, expression, optimize=False)
        vectors.append(delta)
        expression_records.append({
            "key": key,
            "officialClass": class_name,
            "classIndex": class_index,
            "latent": "zero (latent mean)",
            "coefficients": [f32_short(value) for value in coefficients],
            "maxDisplacementMm": round(float(np.linalg.norm(delta, axis=1).max() * MM), 6),
            "vectorIndex": len(vectors) - 1,
        })

    directed = {}
    for tri in triangles.tolist():
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            key = (min(a, b), max(a, b))
            directed[key] = directed.get(key, 0) + 1
    boundary_vertices = sorted({vertex for key, count in directed.items() if count == 1 for vertex in key})
    skin_boundary = np.array([vertex for vertex in boundary_vertices if group("skin")[vertex]], dtype=np.int64)
    require(len(skin_boundary) >= 32, "neck boundary loop is missing")
    fields, anchors = compute_fields(template, triangles, group, lm_indices, lm_weights, skin_boundary)

    scales = []
    errors = []
    vector_bytes = bytearray()
    for vector in vectors:
        encoded, scale, error = quantize_vector(vector)
        vector_bytes += encoded
        scales.append(scale)
        errors.append(error)
    field_bytes = bytearray()
    field_records = []
    for index, (key, low, high, unit, derivation) in enumerate(FIELDS):
        field_bytes += quantize_field(fields[key], low, high)
        field_records.append({"key": key, "index": index, "min": low, "max": high, "unit": unit, "derivation": derivation})
    vector_count = len(vectors)
    scale_offset = HEADER_BYTES
    vector_offset = scale_offset + 4 * vector_count
    field_offset = vector_offset + len(vector_bytes)
    total = field_offset + len(field_bytes)
    header = HEADER_STRUCT.pack(
        MAGIC, VERSION, HEADER_BYTES, SOURCE_VERTEX_COUNT, IDENTITY_PRIOR_COUNT, len(FEATURES), len(EXPRESSION_PRESETS), len(FIELDS),
        scale_offset, vector_offset, len(vector_bytes), field_offset, len(field_bytes), total, 0,
    )
    payload = header + struct.pack(f"<{vector_count}f", *scales) + bytes(vector_bytes) + bytes(field_bytes)
    require(len(payload) == total, "payload length mismatch")
    require(total <= MAX_BYTES, f"payload {total} bytes exceeds the {MAX_BYTES} byte budget")

    metadata = {
        "schema": SCHEMA,
        "version": VERSION,
        "status": "accepted-derived",
        "semanticMapping": "measured-landmark-features-v1",
        "runtimeBasisLoaded": True,
        "officialTexturesIncluded": False,
        "source": {
            "repository": SOURCE_REPOSITORY,
            "npz": {"path": NPZ_PATH, "revision": NPZ_REVISION, "sha256": NPZ_SHA256, "sizeBytes": NPZ_SIZE},
            "landmarks": {"path": LANDMARKS_PATH, "revision": LANDMARKS_REVISION, "sha256": landmarks_digest, "pinnedRevisionSha256": LANDMARKS_PINNED_SHA256, "note": LANDMARKS_FIX},
            "expressionDecoder": {"path": DECODER_PATH, "revision": DECODER_REVISION, "sha256": DECODER_SHA256, "architecture": "dense relu 84-64-128-256-512 -> 383 linear (evaluated in NumPy)"},
            "renderGlb": {"path": "gnm-official-head-render.glb", "sha256": RENDER_SHA256},
            "license": {"spdxId": "Apache-2.0", "path": "LICENSE-GNM.txt", "sha256": LICENSE_SHA256},
        },
        "authorization": {"reviewer": "project-owner", "decisionDate": "2026-08-12", "decisionReference": "sports-face-mvp-noncommercial-mvp-authorization", "scope": "same noncommercial public MVP scope as the accepted official GNM package"},
        "format": {
            "magic": MAGIC.decode("ascii"), "version": VERSION, "headerBytes": HEADER_BYTES, "endianness": "little",
            "headerFields": ["magic", "version", "headerBytes", "sourceVertexCount", "identityPriorCount", "featureCount", "expressionPresetCount", "fieldCount", "scaleOffset", "vectorOffset", "vectorBytes", "fieldOffset", "fieldBytes", "totalBytes", "reserved"],
            "vectorEncoding": "int16 x,y,z per source vertex times one float32 scale per vector (meters)",
            "vectorOrder": "identity prior directions, then feature tail directions, then expression presets",
            "fieldEncoding": "uint8 per source vertex, value = min + u8 / 255 * (max - min), field-major",
            "vertexSpace": "official GNM source vertex index; render vertices map through the render GLB sourceVertexIndicesAccessor",
        },
        "payload": {"path": "gnm-player-generator.bin", "sizeBytes": total, "sha256": sha256_bytes(payload)},
        "budget": {"maxBytes": MAX_BYTES, "withinLimit": True},
        "dimensions": {"sourceVertexCount": SOURCE_VERTEX_COUNT, "renderVertexCount": int(len(render_ids)), "headIdentityCount": HEAD_IDENTITY_COUNT, "identityPriorCount": IDENTITY_PRIOR_COUNT, "featureCount": len(FEATURES), "expressionPresetCount": len(EXPRESSION_PRESETS), "fieldCount": len(FIELDS), "vectorCount": vector_count},
        "components": components,
        "identity": {
            "prior": "independent unit Gaussian per official head identity coefficient (GNM docs: typical range -3..3)",
            "priorComponents": identity_records,
            "priorVarianceShare": round(float((head_basis[:IDENTITY_PRIOR_COUNT] ** 2).sum() / (head_basis ** 2).sum()), 6),
            "unsampledComponents": "head_032..head_169 only move along the feature directions; eyes_000..002 and teeth_000..079 stay at the template",
            "conditioning": "Matheron update c = c0 + Gn^T (Gn Gn^T + tau^2 I)^-1 (target + eta - Gn c0) over the active features; displacement = sum_{k<K} c_k B_k + sum_f w_f tail_f",
        },
        "features": feature_records,
        "featureCorrelation": [[round(float(value), 6) for value in row] for row in correlation],
        "fixedVertices": fixed,
        "landmarks": {"count": 68, "definitions": [[int(row[0]), row[1], int(row[2]), row[3], int(row[4]), row[5]] for row in landmark_rows]},
        "expressionPresets": expression_records,
        "fields": field_records,
        "fieldAnchors": anchors,
        "quantization": {"maxAbsErrorMeters": max(errors), "vectorScaleCount": vector_count},
        "notes": "Derived offline from official GNM Head v3.0 data. Identity geometry is sampled from the official prior and conditioned on landmark-measured features; no official textures are included and fields are procedural painting coordinates.",
    }
    output_path.write_bytes(payload)
    output_metadata_path.write_text(json.dumps(metadata, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return metadata


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--npz", type=Path, default=DEFAULT_NPZ)
    parser.add_argument("--landmarks", type=Path, default=DEFAULT_LANDMARKS)
    parser.add_argument("--expression-decoder", type=Path, default=DEFAULT_DECODER)
    parser.add_argument("--render", type=Path, default=DEFAULT_RENDER)
    parser.add_argument("--license", type=Path, default=DEFAULT_LICENSE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_OUTPUT_METADATA)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        metadata = build(args.npz, args.landmarks, args.expression_decoder, args.render, args.license, args.output, args.metadata)
    except (PlayerGeneratorError, OSError, KeyError) as error:
        print(f"FAIL GNM player generator: {error}", file=sys.stderr)
        return 1
    print(f"PASS GNM player generator: {args.output.name} ({metadata['payload']['sizeBytes']} bytes, {metadata['dimensions']['identityPriorCount']} prior + {metadata['dimensions']['featureCount']} feature + {metadata['dimensions']['expressionPresetCount']} expression vectors, {metadata['dimensions']['fieldCount']} fields)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
