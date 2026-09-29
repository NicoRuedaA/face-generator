import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createProfile, setFeature, getFaceValues, hashSeed, FACE_VARS, formatFaceCode, parseFaceCode } from '../src/face-model.js';
import { parseWebglGlb } from '../src/gnm-assets.js';
import { parseGnmPlayerPayload, gnmPlayerAppearance, gnmPlayerExpression, gnmPlayerLandmarks } from '../src/gnm-player-model.js';
import { buildGnmPlayerStatic, computeGnmPlayerFrame } from '../src/gnm-player-renderer.js';
const read = name => { const b = fs.readFileSync(new URL(`../tools/gnm/work/${name}`, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const model = parseGnmPlayerPayload(JSON.parse(fs.readFileSync(new URL('../tools/gnm/work/gnm-player-generator.json', import.meta.url))), read('gnm-player-generator.bin'));
const asset = parseWebglGlb(read('gnm-official-head-render.glb'));
const staticData = buildGnmPlayerStatic(asset, model);
const resources = {model, asset, staticData};
for (const seed of ['isolation:1', 'isolation:2', 'isolation:3']) {
  let base = createProfile({seed:hashSeed(seed), age:24});
  for (const [key,value] of Object.entries({hairVisible:1,glasses:0,brows:0,eyes:0,mouth:0,nose:0,earShape:0,freckles:0})) base=setFeature(base,key,value);
  const appearance = gnmPlayerAppearance(base);
  const neutral = computeGnmPlayerFrame(resources,base,{expressionMode:'neutral'});
  for (const variable of FACE_VARS) {
    const original = getFaceValues(base)[variable.key];
    const edited = setFeature(base,variable.key,(original+1)%variable.validValues);
    assert.equal(formatFaceCode(parseFaceCode(formatFaceCode(edited))),formatFaceCode(edited));
    if(variable.key!=='skin') assert.deepEqual(gnmPlayerAppearance(edited).skin,appearance.skin,`${variable.key}: skin base isolated`);
    assert.deepEqual(gnmPlayerExpression(edited),gnmPlayerExpression(base),`${variable.key}: automatic expression isolated`);
    const changed=computeGnmPlayerFrame(resources,edited,{expressionMode:'neutral'});
    if (!['head','jaw','faceProportion','eyes','nose','mouth','earShape'].includes(variable.key)) {
      assert.deepEqual(changed.renderPositions,neutral.renderPositions,`${variable.key}: head geometry invariant`);
      assert.deepEqual(changed.bust,neutral.bust,`${variable.key}: collar invariant`);
    }
    if(['eyes','nose','mouth','earShape'].includes(variable.key)) {
      let changedCount=0, stableCount=0, outsideCount=0;
      // Independent anatomical bounds, deliberately not importing the implementation's masks.
      const inRegion = ([x,y,z]) => ({
        eyes: Math.abs(x) > .006 && Math.abs(x) < .057 && y > .278 && y < .321 && z > .068 && z < .149,
        nose: Math.abs(x) < .035 && y > .239 && y < .321 && z > .091 && z < .173,
        mouth: Math.abs(x) < .042 && y > .199 && y < .263 && z > .072 && z < .166,
        earShape: Math.abs(x) > .057 && Math.abs(x) < .111 && y > .226 && y < .316 && z > -.021 && z < .057,
      })[variable.key];
      for(let i=0;i<neutral.renderPositions.length;i+=3) {
        const d=Math.hypot(...[0,1,2].map(a=>changed.renderPositions[i+a]-neutral.renderPositions[i+a]));
        if(d>1e-8) changedCount++; else stableCount++;
        const vertex = staticData.sourceIds[i/3];
        if (!inRegion(staticData.template.subarray(vertex*3,vertex*3+3))) {
          outsideCount++;
          assert.equal(d,0,`${variable.key}: vertex ${vertex} outside anatomical region is unchanged`);
        }
        if (staticData.template[vertex*3+1] > .33 && staticData.skinVertex[i/3]) {
          for (let axis=0;axis<3;axis++) assert.equal(changed.shell.positions[i+axis],neutral.shell.positions[i+axis],`${variable.key}: crown hair shell stays fitted and invariant`);
        }
      }
      assert.ok(outsideCount>staticData.renderCount*.7);
      assert.ok(changedCount>25,`${variable.key}: real local geometry changes`);
      assert.ok(stableCount>staticData.renderCount*.7,`${variable.key}: at least 70% of vertices exactly unchanged (${stableCount}/${staticData.renderCount})`);
      assert.deepEqual(changed.bust,neutral.bust,`${variable.key}: collar invariant`);
    }
    const reverted=computeGnmPlayerFrame(resources,setFeature(edited,variable.key,original),{expressionMode:'neutral'});
    assert.deepEqual(reverted.renderPositions,neutral.renderPositions,`${variable.key}: reversible geometry`);
  }
}
// Every available local label moves its intended measurements, not just one hand-picked pair.
const probe = createProfile({seed:hashSeed('all-catalog-labels'),age:24});
for (const key of ['eyes','nose','mouth','earShape']) {
  const results = [];
  for (let value=0;value<FACE_VARS.find(v=>v.key===key).validValues;value++) {
    const frame=computeGnmPlayerFrame(resources,setFeature(probe,key,value),{expressionMode:'neutral'});
    results.push(frame.renderPositions);
  }
  for(let i=0;i<results.length;i++) for(let j=i+1;j<results.length;j++) assert.notDeepEqual(results[i],results[j],`${key}: labels ${i}/${j} are not no-ops`);
}
const strandMeshes=[];
for (const key of ['hair','beard','brows']) {
  const meshes=[];
  for(let value=0;value<FACE_VARS.find(v=>v.key===key).validValues;value++) {
    let p=setFeature(setFeature(probe,'hairVisible',1),key,value);
    const frame=computeGnmPlayerFrame(resources,p,{expressionMode:'neutral'});
    meshes.push(key==='hair' ? frame.shell.positions : frame.groom[key==='brows'?'brow':key].vertices);
    if (key==='hair') strandMeshes.push(frame.groom.hair.vertices.subarray(0, 6000));
  }
  for(let i=0;i<meshes.length;i++) for(let j=i+1;j<meshes.length;j++) assert.notDeepEqual(meshes[i],meshes[j],`${key}: ${i}/${j} have different rendered geometry`);
}
for(let i=0;i<strandMeshes.length;i++) for(let j=i+1;j<strandMeshes.length;j++) assert.notDeepEqual(strandMeshes[i],strandMeshes[j],`hair: ${i}/${j} have different strands`);
const p0=gnmPlayerAppearance(setFeature(probe,'eyeColor',0)),p2=gnmPlayerAppearance(setFeature(probe,'eyeColor',2));
assert.notDeepEqual(p0.iris,p2.iris,'eye pigments really differ');
assert.deepEqual(p0.skin,p2.skin,'iris pigments never tint skin');
assert.notDeepEqual(gnmPlayerAppearance(setFeature(probe,'skin',0)).skin,gnmPlayerAppearance(setFeature(probe,'skin',7)).skin,'skin selector really changes skin');
console.log('Feature isolation: all controls, 3 seeds, intended local geometry, independent anatomical bounds, stable hair/collar, all local labels and 12/6/8 distinct catalog geometries passed.');
