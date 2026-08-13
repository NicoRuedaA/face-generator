/* Deterministic tests for the technical deformation visualization contract.
   The overlays are procedural inspection aids (UV checker from the exact
   official TEXCOORD_0 and a LINES wireframe generated from triangle indices).
   They are session-state toggles, OFF by default, and never official textures. */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  OFFICIAL_UV_CHECKER_DENSITY,
  OFFICIAL_WIREFRAME_COLOR,
  TECHNICAL_VISUALIZATION_COMBINED,
  TECHNICAL_VISUALIZATION_NONE,
  TECHNICAL_VISUALIZATION_NOTE,
  TECHNICAL_VISUALIZATION_UV_CHECKER,
  TECHNICAL_VISUALIZATION_VALUES,
  TECHNICAL_VISUALIZATION_WIREFRAME,
  clampTechnicalVisualization,
  describeOfficialBasisLabMapping,
  describeOfficialWebglMapping,
  describeTechnicalVisualization,
  parseWebglGlb,
  technicalVisualizationFlags,
  technicalVisualizationState,
} from "../src/webgl-renderer.js";

assert.equal(OFFICIAL_UV_CHECKER_DENSITY, 16);
assert.deepEqual(OFFICIAL_WIREFRAME_COLOR, [0.96, 0.16, 0.86]);
assert.equal(OFFICIAL_WIREFRAME_COLOR.length, 3);
assert.equal(OFFICIAL_WIREFRAME_COLOR.every(Number.isFinite), true);
assert.deepEqual(TECHNICAL_VISUALIZATION_VALUES, [
  TECHNICAL_VISUALIZATION_NONE,
  TECHNICAL_VISUALIZATION_UV_CHECKER,
  TECHNICAL_VISUALIZATION_WIREFRAME,
  TECHNICAL_VISUALIZATION_COMBINED,
]);
assert.match(TECHNICAL_VISUALIZATION_NOTE, /not an official texture/i);

// Session-state composition: two toggles map to the diagnostics contract string.
assert.equal(technicalVisualizationState(false, false), TECHNICAL_VISUALIZATION_NONE);
assert.equal(technicalVisualizationState(true, false), TECHNICAL_VISUALIZATION_UV_CHECKER);
assert.equal(technicalVisualizationState(false, true), TECHNICAL_VISUALIZATION_WIREFRAME);
assert.equal(technicalVisualizationState(true, true), TECHNICAL_VISUALIZATION_COMBINED);
assert.equal(technicalVisualizationState(1, 0), TECHNICAL_VISUALIZATION_UV_CHECKER);
assert.equal(technicalVisualizationState("", null), TECHNICAL_VISUALIZATION_NONE);

// Defensive clamping: invalid session values fall back to OFF.
assert.equal(clampTechnicalVisualization(TECHNICAL_VISUALIZATION_UV_CHECKER), TECHNICAL_VISUALIZATION_UV_CHECKER);
assert.equal(clampTechnicalVisualization(TECHNICAL_VISUALIZATION_WIREFRAME), TECHNICAL_VISUALIZATION_WIREFRAME);
assert.equal(clampTechnicalVisualization(TECHNICAL_VISUALIZATION_COMBINED), TECHNICAL_VISUALIZATION_COMBINED);
assert.equal(clampTechnicalVisualization("official-texture"), TECHNICAL_VISUALIZATION_NONE);
assert.equal(clampTechnicalVisualization("bogus"), TECHNICAL_VISUALIZATION_NONE);
assert.equal(clampTechnicalVisualization(undefined), TECHNICAL_VISUALIZATION_NONE);

// Flag split mirrors the diagnostics string.
assert.deepEqual(technicalVisualizationFlags(TECHNICAL_VISUALIZATION_NONE), { uvChecker: false, wireframe: false });
assert.deepEqual(technicalVisualizationFlags(TECHNICAL_VISUALIZATION_UV_CHECKER), { uvChecker: true, wireframe: false });
assert.deepEqual(technicalVisualizationFlags(TECHNICAL_VISUALIZATION_WIREFRAME), { uvChecker: false, wireframe: true });
assert.deepEqual(technicalVisualizationFlags(TECHNICAL_VISUALIZATION_COMBINED), { uvChecker: true, wireframe: true });
assert.deepEqual(technicalVisualizationFlags("bogus"), { uvChecker: false, wireframe: false });

// Diagnostics contract: state string plus an explicit inspection-aid note.
const diagnostics = describeTechnicalVisualization(TECHNICAL_VISUALIZATION_COMBINED);
assert.equal(diagnostics.technicalVisualization, TECHNICAL_VISUALIZATION_COMBINED);
assert.match(diagnostics.technicalVisualizationNote, /inspection aid/i);
assert.match(diagnostics.technicalVisualizationNote, /not an official texture/i);
assert.equal(describeTechnicalVisualization(undefined).technicalVisualization, TECHNICAL_VISUALIZATION_NONE);

// The official style descriptions expose the same contract and default OFF.
const officialDescription = describeOfficialWebglMapping({ technicalVisualization: TECHNICAL_VISUALIZATION_WIREFRAME });
assert.equal(officialDescription.technicalVisualization, TECHNICAL_VISUALIZATION_WIREFRAME);
assert.match(officialDescription.technicalVisualizationNote, /not an official texture/i);
assert.equal(officialDescription.officialTexturesIncluded, false);
assert.equal(officialDescription.mapping.applied, false);
assert.equal(describeOfficialWebglMapping().technicalVisualization, TECHNICAL_VISUALIZATION_NONE);

const basisLabDescription = describeOfficialBasisLabMapping(
  [0.25, 0, 0, 0, 0, 0, 0, 0],
  { technicalVisualization: TECHNICAL_VISUALIZATION_UV_CHECKER },
);
assert.equal(basisLabDescription.technicalVisualization, TECHNICAL_VISUALIZATION_UV_CHECKER);
assert.match(basisLabDescription.technicalVisualizationNote, /not an official texture/i);
assert.equal(basisLabDescription.coefficients["GNM identity basis 000"], 0.25);
assert.match(basisLabDescription.mapping, /semanticMapping disabled/);
assert.equal(describeOfficialBasisLabMapping([0.1, 0, 0, 0, 0, 0, 0, 0]).technicalVisualization, TECHNICAL_VISUALIZATION_NONE);

// Official render GLB contract: per-vertex TEXCOORD_0 on every component and
// triangle indices that yield the deterministic wireframe edge count.
const officialGlb = fs.readFileSync(new URL("../tools/gnm/work/gnm-official-head-render.glb", import.meta.url));
const officialAsset = parseWebglGlb(officialGlb.buffer.slice(officialGlb.byteOffset, officialGlb.byteOffset + officialGlb.byteLength));
assert.equal(officialAsset.official, true);
assert.equal(officialAsset.primitives.length, 6);
for (const primitive of officialAsset.primitives) {
  assert.equal(primitive.uv.accessor.count, primitive.position.accessor.count, `${primitive.name} must expose per-vertex TEXCOORD_0`);
  assert.equal(primitive.indices.accessor.count % 3, 0, `${primitive.name} indices must be triangular`);
}
const totalTriangles = officialAsset.primitives.reduce((total, primitive) => total + primitive.indices.accessor.count / 3, 0);
const totalIndices = officialAsset.primitives.reduce((total, primitive) => total + primitive.indices.accessor.count, 0);
assert.equal(totalTriangles, 35324);
assert.equal(totalIndices, 105972);
// One LINES pair per triangle edge means the wireframe edge count equals the
// total triangle-index count by construction.
assert.equal(totalTriangles * 3, totalIndices);

// Both HTML entry points ship the toggles, default OFF and clearly labeled as
// inspection aids (not official textures).
for (const entry of ["index.html", "index.module.html"]) {
  const html = fs.readFileSync(new URL(`../${entry}`, import.meta.url), "utf8");
  assert.ok(html.includes('id="technical-visualization-controls"'), `${entry} must include the visualization panel`);
  assert.ok(html.includes('id="uv-checker-toggle"'), `${entry} must include the UV checker toggle`);
  assert.ok(html.includes('id="wireframe-toggle"'), `${entry} must include the wireframe toggle`);
  assert.ok(html.includes('id="technical-visualization-state"'), `${entry} must include the state readout`);
  assert.ok(!html.includes('id="uv-checker-toggle" checked'), `${entry}: UV checker must default OFF`);
  assert.ok(!html.includes('id="wireframe-toggle" checked'), `${entry}: wireframe must default OFF`);
  assert.match(html, /not an official texture or material/i, `${entry} must label the panel as inspection aid`);
}

// The offline bundle carries the visualization contract (fresh build check).
const bundle = fs.readFileSync(new URL("../src/app.bundle.js", import.meta.url), "utf8");
assert.ok(bundle.includes("uv-checker+wireframe"), "bundle must include the combined visualization state");
assert.ok(bundle.includes("technicalVisualizationNote"), "bundle must include the diagnostics note");
assert.ok(bundle.includes("wireframeEdgeCount"), "bundle must include the wireframe edge diagnostics");

console.log("PASS technical visualization tests: session-state toggles, diagnostics contract, UV/wireframe GLB contract, default-OFF HTML controls");
