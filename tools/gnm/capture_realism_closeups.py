#!/usr/bin/env python3
"""Capture fixed close-up evidence for the GNM 3D player realism work.

Renders three fixed players (light, medium and dark skin; fixed seeds, traits,
kit, neutral expression) from three fixed cameras (front, three-quarter and
profile) at >= 512 px with `sports/gnm-3d-player-v1`, in headless Chromium
(WebGL2 through SwiftShader), and writes one contact sheet plus a JSON sidecar
(`<output>.json`) with the per-tile identity and lighting diagnostics.

The players, cameras and layout are deliberately frozen so later realism work
units can compare against the same `before` images. Do not change them; add a
new mode instead.

Modes:

* `closeups` (default): final renders, 3 players x 3 cameras.
* `lighting-details`: front / three-quarter / profile of one player
  (`--player`, default `light`, whose fringe shadows the forehead), each as
  final render, key-light shadow factor, ambient occlusion and curvature
  debug views (requires a renderer that exposes these debug views).
* `eye-details`: eye close-ups cropped from `--detail-size` (>= 1024 px)
  renders: four players covering the four iris colours and light, medium and
  dark skin, each front, three-quarter and three-quarter with a non-neutral
  expression preset (lashes, tear line, caruncle, iris, lash shadows).
* `post-details`: the same portrait with the photographic post effects off
  (the pre-v2 pipeline look, capture-only `postEffects: false`) and on, with
  2x depth-of-field and 4x grain crops, plus a 256 px thumbnail.
* `hair-catalog`: the twelve catalog hairstyles and the session side-part
  prototype on one fixed identity, each from the front, in profile and from
  behind, cycling black, blond, red and grey pigments (tiles shown at 320 px).
* `hair-details`: crops from `--detail-size` renders of the hairline, the
  partings, silhouettes against the backdrop and strand shadows (final and
  key-light visibility), plus 256 px thumbnails at 1:1.
* `grooming-catalog`: the six catalog beards on one fixed masculine identity
  (front, three-quarter and profile) and the eight catalog brows (front and
  three-quarter), spreading black, brown, blond, red and grey pigments over
  the sheet. Beard tiles are 320 px crops of `--size` renders; brow tiles
  are 480 x 240 px crops of renders 1.6 times larger.
* `grooming-details`: 1:1 crops from `--detail-size` renders of brow growth
  and edges, stubble, moustache/lip contact under an expression, cheek
  lines and necklines, the full beard's jawline silhouette and strand
  shadows, plus 256 px thumbnails at 1:1.

Requires a local HTTP server at the repository root (`npm run serve`).
Evidence only; not part of `npm test`.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


PLAYERS = (
    {"key": "light", "label": "Light skin (tone 0)", "seed": "realism-v2-light", "age": 27, "presentation": "feminine",
     "traits": {"skin": 0, "hairVisible": 1, "hair": 5, "hairColor": 3, "beard": 0, "brows": 0, "eyeColor": 2,
                "freckles": 0, "scar": 0, "glasses": 0}},
    {"key": "medium", "label": "Medium skin (tone 4)", "seed": "realism-v2-medium", "age": 38, "presentation": "masculine",
     "traits": {"skin": 4, "hairVisible": 1, "hair": 2, "hairColor": 1, "beard": 1, "brows": 3, "eyeColor": 1,
                "freckles": 0, "scar": 0, "glasses": 0}},
    {"key": "dark", "label": "Dark skin (tone 7)", "seed": "realism-v2-dark", "age": 24, "presentation": "masculine",
     "traits": {"skin": 7, "hairVisible": 1, "hair": 6, "hairColor": 0, "beard": 0, "brows": 1, "eyeColor": 0,
                "freckles": 0, "scar": 0, "glasses": 0}},
)
CAMERAS = (
    {"key": "front", "label": "front", "camera": {"yaw": 0.0, "pitch": -0.06, "distance": 0.8}},
    {"key": "three-quarter", "label": "three-quarter", "camera": {"yaw": 0.62, "pitch": -0.06, "distance": 0.8}},
    {"key": "profile", "label": "profile", "camera": {"yaw": 1.52, "pitch": -0.06, "distance": 0.85}},
)
KIT = ("#27405f", "#e2e8f0")
# Renderer debug views used by the lighting-details mode (see GNM_PLAYER_DEBUG_VIEWS).
LIGHTING_VIEWS = (("final", None), ("key shadow", "keyShadow"), ("ambient occlusion", "ambientOcclusion"), ("curvature", "curvature"))
# Eye-details mode: the frozen players plus a green-eyed one (all four iris
# colours), each with a non-neutral expression for the third column.
EYE_PLAYERS = PLAYERS + (
    {"key": "green", "label": "Light-medium skin (tone 2), green iris", "seed": "realism-v2-green", "age": 30, "presentation": "feminine",
     "traits": {"skin": 2, "hairVisible": 1, "hair": 7, "hairColor": 6, "beard": 0, "brows": 2, "eyeColor": 3,
                "freckles": 1, "scar": 0, "glasses": 0}},
)
EYE_EXPRESSIONS = {"light": "alert", "medium": "focused", "dark": "soft", "green": "alert"}
EYE_CAMERAS = (
    {"key": "front", "label": "front", "camera": {"yaw": 0.0, "pitch": -0.06, "distance": 0.72}},
    {"key": "three-quarter", "label": "three-quarter", "camera": {"yaw": 0.62, "pitch": -0.06, "distance": 0.72}},
)
# The subject's left eye (+x) is the near eye of the three-quarter camera.
EYE_CENTER = (0.031, 0.303, 0.112)
EYE_CROP = (300, 190)
# Hair modes: one fixed identity (neutral presentation, light-medium skin, no
# beard or glasses) wearing every catalog style and the side-part prototype.
HAIR_PLAYER = {"key": "hair", "label": "Hair catalog identity", "seed": "realism-v2-hair", "age": 27, "presentation": "neutral",
               "traits": {"skin": 2, "hairVisible": 1, "hair": 0, "hairColor": 0, "beard": 0, "brows": 0, "eyeColor": 1,
                          "freckles": 0, "scar": 0, "glasses": 0}}
HAIR_CATALOG = tuple({"hair": index, "prototype": False, "label": label} for index, label in enumerate((
    "short-01", "short-02", "short-03", "short-04", "medium-01", "medium-02", "curly-01", "long-01", "long-02", "fade-01",
    "braids-01", "bun-01"))) + ({"hair": 3, "prototype": True, "label": "side-part prototype"},)
HAIR_CAMERAS = (
    {"key": "front", "label": "front", "camera": {"yaw": 0.0, "pitch": -0.06, "distance": 0.95}},
    {"key": "profile", "label": "profile", "camera": {"yaw": 1.52, "pitch": -0.06, "distance": 0.95}},
    {"key": "back", "label": "back", "camera": {"yaw": 3.1416, "pitch": -0.06, "distance": 0.95}},
)
# Palette indices (GNM_PLAYER_HAIR_COLORS): black, blond, red, grey.
HAIR_COLOURS = ((0, "black"), (4, "blond"), (6, "red"), (7, "grey"))
# Grooming modes: one fixed masculine identity (light-medium skin, a short
# crop that keeps the brows clear, age 30 so no grey strands) wearing every
# catalog beard and brow style.
GROOMING_PLAYER = {"key": "grooming", "label": "Grooming catalog identity", "seed": "realism-v2-grooming", "age": 30, "presentation": "masculine",
                   "traits": {"skin": 2, "hairVisible": 1, "hair": 2, "hairColor": 0, "beard": 0, "brows": 0, "eyeColor": 1,
                              "freckles": 0, "scar": 0, "glasses": 0}}
BEARD_CATALOG = tuple({"beard": index, "label": label} for index, label in enumerate(("none", "stubble", "short", "full", "goatee", "moustache")))
BROW_CATALOG = tuple({"brows": index, "label": label} for index, label in enumerate(("soft", "flat", "arched", "thick", "short", "angular", "low", "high")))
# Palette indices (GNM_PLAYER_HAIR_COLORS): black, brown, blond, red, grey.
GROOMING_COLOURS = ((0, "black"), (2, "brown"), (4, "blond"), (6, "red"), (7, "grey"))
GROOMING_CAMERAS = (
    {"key": "front", "label": "front", "camera": {"yaw": 0.0, "pitch": -0.06, "distance": 0.8}},
    {"key": "three-quarter", "label": "three-quarter", "camera": {"yaw": 0.62, "pitch": -0.06, "distance": 0.8}},
    {"key": "profile", "label": "profile", "camera": {"yaw": 1.52, "pitch": -0.06, "distance": 0.85}},
)

SCRIPT = """
async ({ players, cameras, kit, size, views, mode, detailPlayer, eyePlayers, eyeCameras, eyeExpressions, eyeCenter, eyeCrop, detailSize, hairPlayer, hairCatalog, hairCameras, hairColours, groomingPlayer, beardCatalog, browCatalog, groomingColours, groomingCameras }) => {
  const model = await import('./src/face-model.js');
  const renderer = await import('./src/gnm-player-renderer.js');
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  document.body.append(canvas);
  function profileFor(player) {
    let profile = model.createProfile({ seed: player.seed, age: player.age, presentation: player.presentation });
    for (const [key, value] of Object.entries(player.traits)) profile = model.setFeature(profile, key, value);
    return model.setKit(profile, kit[0], kit[1]);
  }
  const tiles = [];
  const records = [];
  async function tile(player, camera, view, label, extra = {}) {
    const profile = profileFor(player);
    const options = { expressionMode: 'neutral', camera: camera.camera, ...extra };
    if (view) {
      const code = renderer.GNM_PLAYER_DEBUG_VIEWS?.[view];
      if (!Number.isInteger(code)) throw new Error('renderer does not expose debug view ' + view);
      options.debugField = code;
    }
    const started = performance.now();
    const result = await renderer.renderGnmPlayerFace(canvas, profile, options);
    const elapsed = performance.now() - started;
    const d = result.diagnostics;
    tiles.push({ image: canvas.toDataURL('image/png'), label });
    records.push({
      label, player: player.key, camera: camera.key, view: view || 'final', code: model.formatFaceCode(profile),
      cameraState: d.camera, identityCoefficientsHead: d.identityCoefficientsHead, identityFeatureZ: d.identityFeatureZ,
      expression: d.expression, appearance: d.appearance, lighting: d.lighting, hair: d.hair,
      renderMs: Math.round(elapsed),
    });
  }
  // Crop (in drawing-buffer pixels) around a world point, scaled up by `zoom`;
  // `inside` shifts the rectangle to stay within the render (hair modes).
  function crop(source, camera, center, width, height, zoom, inside = false) {
    const view = renderer.buildGnmPlayerCamera(camera, source.width / source.height);
    const e = [0, 1, 2, 3].map((r) => view.view[r] * center[0] + view.view[4 + r] * center[1] + view.view[8 + r] * center[2] + view.view[12 + r]);
    const c = [0, 1, 2, 3].map((r) => view.projection[r] * e[0] + view.projection[4 + r] * e[1] + view.projection[8 + r] * e[2] + view.projection[12 + r] * e[3]);
    const px = (c[0] / c[3] * 0.5 + 0.5) * source.width, py = (1 - (c[1] / c[3] * 0.5 + 0.5)) * source.height;
    const out = document.createElement('canvas');
    out.width = width * zoom; out.height = height * zoom;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    let sx = Math.round(px - width / 2), sy = Math.round(py - height / 2);
    if (inside) {
      sx = Math.min(Math.max(sx, 0), source.width - width);
      sy = Math.min(Math.max(sy, 0), source.height - height);
    }
    ctx.drawImage(source, sx, sy, width, height, 0, 0, width * zoom, height * zoom);
    return out.toDataURL('image/png');
  }
  async function renderTo(target, player, options) {
    const profile = profileFor(player);
    const started = performance.now();
    const result = await renderer.renderGnmPlayerFace(target, profile, options);
    const d = result.diagnostics;
    records.push({
      label: options.label, player: player.key, code: model.formatFaceCode(profile), cameraState: d.camera,
      identityCoefficientsHead: d.identityCoefficientsHead, identityFeatureZ: d.identityFeatureZ, expression: d.expression,
      appearance: d.appearance, eyes: d.eyes, post: d.post, hair: d.hair, facialHair: d.facialHair, canvas: d.canvas, renderMs: Math.round(performance.now() - started),
    });
    return d;
  }
  const hairStyled = (entry, colour) => ({ ...hairPlayer, traits: { ...hairPlayer.traits, hair: entry.hair, hairColor: colour } });
  const groomed = (traits) => ({ ...groomingPlayer, traits: { ...groomingPlayer.traits, ...traits } });
  let columns, tileWidth, tileHeight;
  // Sections with their own grids (grooming modes): { columns, tileWidth, tileHeight, tiles }.
  const sections = [];
  if (mode === 'grooming-catalog') {
    // Beards: lower-face crops of `size` renders, three cameras per style.
    const beardTiles = [];
    for (let index = 0; index < beardCatalog.length; index += 1) {
      const entry = beardCatalog[index];
      const [colour, colourName] = groomingColours[index % groomingColours.length];
      for (const camera of groomingCameras) {
        const label = 'beard ' + entry.label + ' / ' + colourName + ' / ' + camera.label;
        await renderTo(canvas, groomed({ beard: entry.beard, hairColor: colour }), { expressionMode: 'neutral', camera: camera.camera, label });
        beardTiles.push({ image: crop(canvas, camera.camera, [0.0, 0.212, 0.065], 320, 320, 1, true), label });
      }
    }
    sections.push({ columns: 6, tileWidth: 320, tileHeight: 320, tiles: beardTiles });
    // Brows: brow crops of renders 1.6 times larger, front and three-quarter.
    const browSize = Math.round(size * 1.6);
    canvas.width = browSize; canvas.height = browSize;
    canvas.style.width = browSize + 'px'; canvas.style.height = browSize + 'px';
    const browTiles = [];
    for (let index = 0; index < browCatalog.length; index += 1) {
      const entry = browCatalog[index];
      const [colour, colourName] = groomingColours[index % groomingColours.length];
      for (const camera of groomingCameras.slice(0, 2)) {
        const label = 'brows ' + entry.label + ' / ' + colourName + ' / ' + camera.label;
        await renderTo(canvas, groomed({ brows: entry.brows, hairColor: colour }), { expressionMode: 'neutral', camera: camera.camera, label });
        browTiles.push({ image: crop(canvas, camera.camera, [0.0, 0.316, 0.11], 480, 240, 1, true), label });
      }
    }
    sections.push({ columns: 4, tileWidth: 480, tileHeight: 240, tiles: browTiles });
  } else if (mode === 'grooming-details') {
    canvas.width = detailSize; canvas.height = detailSize;
    canvas.style.width = detailSize + 'px'; canvas.style.height = detailSize + 'px';
    const width = Math.round(768 * detailSize / 2048), height = Math.round(480 * detailSize / 2048);
    // [traits, camera, crop centre (world), label, expression, debug view]; crops are 1:1 drawing-buffer pixels.
    const shots = [
      [{ brows: 3, hairColor: 0 }, { yaw: 0.0, pitch: -0.06, distance: 0.62 }, [0.03, 0.318, 0.11], 'thick brow, black: head hairs up, body up and out, tail out and down'],
      [{ brows: 0, hairColor: 2 }, { yaw: 0.62, pitch: -0.06, distance: 0.62 }, [0.032, 0.318, 0.105], 'soft brow, brown: fine hairs, sparse irregular edges, skin between hairs'],
      [{ beard: 1, hairColor: 0 }, { yaw: 0.62, pitch: -0.06, distance: 0.62 }, [0.045, 0.232, 0.085], 'stubble, black: short dense stubs, follicle darkening, fading cheek line'],
      [{ beard: 5, hairColor: 2 }, { yaw: 0.25, pitch: -0.06, distance: 0.6 }, [0.0, 0.238, 0.13], 'moustache, brown, alert expression: down and out, lip contact', 'alert'],
      [{ beard: 2, hairColor: 6 }, { yaw: 1.25, pitch: -0.06, distance: 0.66 }, [0.055, 0.21, 0.05], 'short beard, red: growth direction, soft cheek line and neckline'],
      [{ beard: 3, hairColor: 0 }, { yaw: 1.52, pitch: -0.06, distance: 0.7 }, [0.01, 0.19, 0.065], 'full beard, black: volume and a silhouette breaking the jawline'],
      [{ beard: 4, hairColor: 4 }, { yaw: 0.4, pitch: -0.06, distance: 0.62 }, [0.0, 0.215, 0.12], 'goatee, blond: moustache, chin and links around the mouth'],
      [{ beard: 3, hairColor: 7 }, { yaw: 0.0, pitch: -0.06, distance: 0.62 }, [0.0, 0.222, 0.12], 'full beard, grey, soft expression: moustache over the lips', 'soft'],
      [{ beard: 3, hairColor: 0 }, { yaw: 0.62, pitch: -0.06, distance: 0.7 }, [0.03, 0.2, 0.08], 'strand shadows: key-light visibility of a full beard', 'neutral', 'keyShadow'],
      [{ beard: 3, hairColor: 0 }, { yaw: 0.62, pitch: -0.06, distance: 0.7 }, [0.03, 0.2, 0.08], 'ambient occlusion: the full beard shades the jaw and neck', 'neutral', 'ambientOcclusion'],
    ];
    const tiles_ = [];
    for (const [traits, camera, center, title, expression, debug] of shots) {
      const options = { expressionMode: expression || 'neutral', camera, label: title };
      if (debug) options.debugField = renderer.GNM_PLAYER_DEBUG_VIEWS[debug];
      await renderTo(canvas, groomed(traits), options);
      tiles_.push({ image: crop(canvas, camera, center, width, height, 1, true), label: title });
    }
    // 256 px thumbnails at 1:1: the reduced strand tiers.
    const strip = document.createElement('canvas');
    strip.width = 768; strip.height = 256;
    const stripContext = strip.getContext('2d');
    let x = 0;
    for (const traits of [{ beard: 1, brows: 3, hairColor: 0 }, { beard: 3, brows: 0, hairColor: 2 }, { beard: 4, brows: 5, hairColor: 6 }]) {
      const thumbnail = document.createElement('canvas');
      thumbnail.width = 256; thumbnail.height = 256;
      const profile = profileFor(groomed(traits));
      await renderer.renderGnmPlayerThumbnail(thumbnail, profile, { expressionMode: 'neutral', camera: { yaw: 0.38, pitch: -0.06, distance: 1 } });
      records.push({ label: '256 px thumbnail / beard ' + traits.beard + ' / brows ' + traits.brows, player: groomingPlayer.key, code: model.formatFaceCode(profile), renderMs: 0 });
      stripContext.drawImage(thumbnail, x, 0);
      x += 256;
    }
    tiles_.push({ image: strip.toDataURL('image/png'), label: '256 px thumbnails at 1:1 (reduced strand tiers)', native: true });
    sections.push({ columns: 2, tileWidth: width, tileHeight: height, tiles: tiles_ });
  } else if (mode === 'hair-catalog') {
    for (let index = 0; index < hairCatalog.length; index += 1) {
      const entry = hairCatalog[index];
      const [colour, colourName] = hairColours[index % hairColours.length];
      for (const camera of hairCameras) {
        await tile(hairStyled(entry, colour), camera, null, entry.label + ' / ' + colourName + ' / ' + camera.label, { hairstylePrototype: entry.prototype ? 'side-part' : 'original' });
      }
    }
  } else if (mode === 'hair-details') {
    canvas.width = detailSize; canvas.height = detailSize;
    canvas.style.width = detailSize + 'px'; canvas.style.height = detailSize + 'px';
    const style = (label) => hairCatalog.find((entry) => entry.label === label);
    const width = Math.round(768 * detailSize / 2048), height = Math.round(480 * detailSize / 2048);
    // [style, colour, camera, crop centre (world), label, debug view]; crops are 1:1 drawing-buffer pixels.
    const shots = [
      ['short-03', 0, { yaw: 0.25, pitch: -0.12, distance: 0.72 }, [0.0, 0.352, 0.1], 'hairline: caesar crop, soft density falloff, baby hairs'],
      ['medium-01', 4, { yaw: 0.3, pitch: -0.1, distance: 0.72 }, [0.005, 0.338, 0.1], 'fringe: tousled medium, blond'],
      ['fade-01', 0, { yaw: 1.45, pitch: -0.06, distance: 0.72 }, [0.072, 0.3, -0.005], 'temple fade: graded length and density, root-tinted scalp'],
      ['medium-02', 6, { yaw: 0.2, pitch: -0.62, distance: 0.8 }, [0.0, 0.4, 0.03], 'centre parting from above, red'],
      ['short-04', 7, { yaw: -0.35, pitch: -0.55, distance: 0.8 }, [0.02, 0.4, 0.03], 'side parting and swept top, grey'],
      ['curly-01', 0, { yaw: 1.52, pitch: -0.06, distance: 0.9 }, [-0.03, 0.42, -0.03], 'curly silhouette against the backdrop'],
      ['long-02', 4, { yaw: 2.45, pitch: -0.06, distance: 0.9 }, [-0.08, 0.2, -0.05], 'long wavy: ends over the shoulder'],
      ['braids-01', 0, { yaw: 2.6, pitch: -0.3, distance: 0.8 }, [0.0, 0.33, -0.07], 'cornrows: plaits and partings'],
      ['medium-01', 4, { yaw: 0.3, pitch: -0.1, distance: 0.72 }, [0.005, 0.33, 0.1], 'strand shadows: key visibility under the fringe', 'keyShadow'],
      ['long-01', 0, { yaw: 0.9, pitch: -0.06, distance: 0.8 }, [0.07, 0.25, 0.02], 'strand shadows: key visibility on cheek and neck', 'keyShadow'],
    ];
    for (const [label, colour, camera, center, title, debug] of shots) {
      const options = { expressionMode: 'neutral', camera, label: title };
      if (debug) options.debugField = renderer.GNM_PLAYER_DEBUG_VIEWS[debug];
      await renderTo(canvas, hairStyled(style(label), colour), options);
      tiles.push({ image: crop(canvas, camera, center, width, height, 1, true), label: title });
    }
    // 256 px thumbnails at 1:1: the reduced level of detail.
    const strip = document.createElement('canvas');
    strip.width = 768; strip.height = 256;
    const stripContext = strip.getContext('2d');
    let x = 0;
    for (const [label, colour] of [['medium-02', 6], ['long-02', 4], ['curly-01', 0]]) {
      const thumbnail = document.createElement('canvas');
      thumbnail.width = 256; thumbnail.height = 256;
      const profile = profileFor(hairStyled(style(label), colour));
      await renderer.renderGnmPlayerThumbnail(thumbnail, profile, { expressionMode: 'neutral', camera: { yaw: 0.62, pitch: -0.06, distance: 1 } });
      records.push({ label: '256 px thumbnail / ' + label, player: hairPlayer.key, code: model.formatFaceCode(profile), renderMs: 0 });
      stripContext.drawImage(thumbnail, x, 0);
      x += 256;
    }
    tiles.push({ image: strip.toDataURL('image/png'), label: '256 px thumbnails at 1:1 (reduced strand tier)', native: true });
  } else if (mode === 'closeups') {
    for (const player of players) for (const camera of cameras) await tile(player, camera, null, player.label + ' / ' + camera.label);
  } else if (mode === 'lighting-details') {
    const player = players.find((entry) => entry.key === detailPlayer);
    for (const camera of cameras) for (const [name, view] of views) await tile(player, camera, view, player.label + ' / ' + camera.label + ' / ' + name);
  } else if (mode === 'eye-details') {
    canvas.width = detailSize; canvas.height = detailSize;
    canvas.style.width = detailSize + 'px'; canvas.style.height = detailSize + 'px';
    for (const player of eyePlayers) {
      const shots = [[eyeCameras[0], 'neutral'], [eyeCameras[1], 'neutral'], [eyeCameras[1], eyeExpressions[player.key]]];
      for (const [camera, expression] of shots) {
        const label = player.label + ' / ' + camera.label + (expression === 'neutral' ? '' : ' / ' + expression);
        await renderTo(canvas, player, { expressionMode: expression, camera: camera.camera, label });
        tiles.push({ image: crop(canvas, camera.camera, eyeCenter, eyeCrop[0], eyeCrop[1], 2), label });
      }
    }
  } else {
    // post-details: the same portrait with post effects off (capture-only) and on.
    const player = players.find((entry) => entry.key === detailPlayer);
    const camera = { yaw: 0.38, pitch: -0.06, distance: 1 };
    const views = [];
    for (const postEffects of [false, true]) {
      const label = 'post effects ' + (postEffects ? 'on' : 'off');
      await renderTo(canvas, player, { expressionMode: 'neutral', camera, postEffects, label });
      views.push({
        label,
        full: canvas.toDataURL('image/png'),
        ear: crop(canvas, camera, [0.075, 0.275, 0.017], size / 4, size / 4, 2),
        skin: crop(canvas, camera, [0.035, 0.255, 0.1], size / 8, size / 8, 4),
      });
    }
    for (const view of views) tiles.push({ image: view.full, label: view.label + ' (' + size + ' px)' });
    for (const view of views) tiles.push({ image: view.ear, label: view.label + ': ear and hair edge, 2x (depth of field)' });
    for (const view of views) tiles.push({ image: view.skin, label: view.label + ': cheek, 4x (grain)' });
    const thumbnail = document.createElement('canvas');
    thumbnail.width = 256; thumbnail.height = 256; thumbnail.style.width = '256px'; thumbnail.style.height = '256px';
    document.body.append(thumbnail);
    for (const postEffects of [false, true]) {
      const label = '256 px thumbnail, post effects ' + (postEffects ? 'on' : 'off');
      await renderTo(thumbnail, player, { expressionMode: 'neutral', camera, postEffects, label });
      const scaled = document.createElement('canvas');
      scaled.width = size; scaled.height = size;
      const ctx = scaled.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(thumbnail, 0, 0, size, size);
      tiles.push({ image: scaled.toDataURL('image/png'), label: label + ' (shown 2x)' });
    }
  }
  if (sections.length === 0) {
    if (mode === 'hair-catalog') { columns = 6; tileWidth = 320; tileHeight = 320; }
  else if (mode === 'hair-details') { columns = 2; tileWidth = Math.round(768 * detailSize / 2048); tileHeight = Math.round(480 * detailSize / 2048); }
  else if (mode === 'closeups') { columns = cameras.length; tileWidth = size; tileHeight = size; }
  else if (mode === 'lighting-details') { columns = views.length; tileWidth = size; tileHeight = size; }
  else if (mode === 'eye-details') { columns = 3; tileWidth = eyeCrop[0] * 2; tileHeight = eyeCrop[1] * 2; }
    else { columns = 2; tileWidth = size; tileHeight = size; }
    sections.push({ columns, tileWidth, tileHeight, tiles });
  }
  const labelHeight = 30;
  const sheet = document.createElement('canvas');
  sheet.width = Math.max(...sections.map((section) => section.columns * section.tileWidth));
  sheet.height = sections.reduce((sum, section) => sum + Math.ceil(section.tiles.length / section.columns) * (section.tileHeight + labelHeight), 0);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#0b1017'; ctx.fillRect(0, 0, sheet.width, sheet.height);
  let top = 0;
  for (const section of sections) {
    for (let index = 0; index < section.tiles.length; index += 1) {
      const tile = section.tiles[index];
      const image = new Image();
      image.src = tile.image;
      await image.decode();
      const x = (index % section.columns) * section.tileWidth;
      const y = top + Math.floor(index / section.columns) * (section.tileHeight + labelHeight);
      // `native` tiles (1:1 thumbnails) keep their pixel size instead of being scaled to the tile.
      if (tile.native) ctx.drawImage(image, x, y);
      else ctx.drawImage(image, x, y, section.tileWidth, section.tileHeight);
      ctx.fillStyle = '#e2e8f0'; ctx.font = '17px sans-serif';
      ctx.fillText(tile.label, x + 10, y + section.tileHeight + 21);
    }
    top += Math.ceil(section.tiles.length / section.columns) * (section.tileHeight + labelHeight);
  }
  return { image: sheet.toDataURL('image/png'), records, userAgent: navigator.userAgent };
}
"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, required=True, help="PNG contact sheet; a JSON sidecar is written next to it")
    parser.add_argument("--mode", choices=("closeups", "lighting-details", "eye-details", "post-details", "hair-catalog", "hair-details", "grooming-catalog", "grooming-details"), default="closeups")
    parser.add_argument("--player", choices=tuple(player["key"] for player in PLAYERS), default="light", help="player of the lighting-details and post-details modes")
    parser.add_argument("--detail-size", type=int, default=2048, help="render size of the eye-, hair- and grooming-details modes (>= 1024; crops are cut from it)")
    parser.add_argument("--url", default="http://127.0.0.1:8080/index.module.html")
    parser.add_argument("--size", type=int, default=512, help="tile size in pixels (>= 512 for evidence)")
    parser.add_argument("--chromium", default=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"))
    args = parser.parse_args(argv)
    if args.size < 512:
        parser.error("--size must be at least 512")
    if args.detail_size < 1024:
        parser.error("--detail-size must be at least 1024")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.chromium,
                                             args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1100, "height": 900}, device_scale_factor=1)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/favicon.ico", lambda route: route.fulfill(status=204, body=""))
        page.goto(args.url)
        page.wait_for_load_state("networkidle")
        result = page.evaluate(SCRIPT, {
            "players": list(PLAYERS), "cameras": list(CAMERAS), "kit": list(KIT), "size": args.size,
            "views": [list(view) for view in LIGHTING_VIEWS], "mode": args.mode, "detailPlayer": args.player,
            "eyePlayers": list(EYE_PLAYERS), "eyeCameras": list(EYE_CAMERAS), "eyeExpressions": EYE_EXPRESSIONS,
            "eyeCenter": list(EYE_CENTER), "eyeCrop": list(EYE_CROP), "detailSize": args.detail_size,
            "hairPlayer": HAIR_PLAYER, "hairCatalog": list(HAIR_CATALOG), "hairCameras": list(HAIR_CAMERAS),
            "hairColours": [list(colour) for colour in HAIR_COLOURS],
            "groomingPlayer": GROOMING_PLAYER, "beardCatalog": list(BEARD_CATALOG), "browCatalog": list(BROW_CATALOG),
            "groomingColours": [list(colour) for colour in GROOMING_COLOURS], "groomingCameras": list(GROOMING_CAMERAS),
        })
        browser.close()
    if errors:
        raise SystemExit(f"browser errors: {errors}")
    args.output.write_bytes(base64.b64decode(result["image"].split(",", 1)[1]))
    timings = [record.pop("renderMs") for record in result["records"]]
    hair_mode = args.mode in ("hair-catalog", "hair-details")
    grooming_mode = args.mode in ("grooming-catalog", "grooming-details")
    sidecar = {
        "schema": "sports-face-gnm-3d-player-realism-closeups/v1",
        "mode": args.mode,
        "detailPlayer": args.player if args.mode in ("lighting-details", "post-details") else None,
        "renderer": "sports/gnm-3d-player-v1",
        "tileSize": args.size,
        "kit": list(KIT),
        "players": [HAIR_PLAYER] if hair_mode else [GROOMING_PLAYER] if grooming_mode else list(EYE_PLAYERS) if args.mode == "eye-details" else list(PLAYERS),
        "cameras": list(HAIR_CAMERAS) if args.mode == "hair-catalog" else list(GROOMING_CAMERAS) if args.mode == "grooming-catalog" else list(EYE_CAMERAS) if args.mode == "eye-details" else list(CAMERAS),
        **({"detailSize": args.detail_size, "eyeCrop": list(EYE_CROP), "eyeExpressions": EYE_EXPRESSIONS} if args.mode == "eye-details" else {}),
        **({"hairCatalog": list(HAIR_CATALOG), "hairColours": [list(colour) for colour in HAIR_COLOURS]} if hair_mode else {}),
        **({"detailSize": args.detail_size} if args.mode in ("hair-details", "grooming-details") else {}),
        **({"beardCatalog": list(BEARD_CATALOG), "browCatalog": list(BROW_CATALOG), "groomingColours": [list(colour) for colour in GROOMING_COLOURS]} if grooming_mode else {}),
        "tiles": result["records"],
        "note": "Qualitative evidence rendered with WebGL2 (SwiftShader). Pixels depend on the GPU/driver; identity values are deterministic.",
    }
    args.output.with_suffix(".json").write_text(json.dumps(sidecar, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"PASS {args.mode}: {len(result['records'])} tiles at {args.size}px -> {args.output} "
          f"(render ms per tile: min {min(timings)}, max {max(timings)}, total {sum(timings)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
