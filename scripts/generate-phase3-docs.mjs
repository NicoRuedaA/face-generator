import fs from "node:fs";
import path from "node:path";
import { createProfile, hashSeed, setFeature } from "../src/face-model.js";
import { buildMorphology } from "../src/morphology.js";
import { buildMorphSvg } from "../src/morph-renderer.js";
import { buildToonSvg } from "../src/toon-renderer.js";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const docs = path.join(root, "docs");
const baseline = JSON.parse(fs.readFileSync(path.join(root, "baseline", "visual-baseline.json"), "utf8"));
const commonCss = `
*{box-sizing:border-box}html,body{margin:0;background:#071018;color:#f8fafc;font-family:Arial,sans-serif}
body{padding:30px}header{display:flex;justify-content:space-between;align-items:end;margin-bottom:22px}
h1{margin:0 0 7px;font-size:30px}.sub{margin:0;color:#9fb0c0}.badge{border:1px solid #345269;border-radius:999px;padding:9px 13px;color:#cce7df}
.card{background:#101b26;border:1px solid #283c4e;border-radius:16px;padding:11px}.card svg{display:block;width:100%;border-radius:11px}
.meta{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:8px}.meta strong{font-size:14px}.meta span{font-size:12px;color:#9fb0c0}
`;
function page(title, subtitle, badge, body, extraCss="") {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title><style>${commonCss}${extraCss}</style></head><body><header><div><h1>${title}</h1><p class="sub">${subtitle}</p></div><div class="badge">${badge}</div></header>${body}</body></html>`;
}

const probes = [
  [0,2,"oval-balanced"], [1,2,"broad-square"], [2,2,"long-narrow"], [3,2,"angular-athletic"],
  [4,2,"compact-round"], [5,2,"tapered-heart"], [0,5,"high-forehead"], [1,0,"low-wide"],
];
const familyCards=[];
for (const [head, proportion, expected] of probes) {
  let profile=createProfile({seed:hashSeed(`docs:${expected}`),age:25,presentation:"neutral"});
  profile=setFeature(profile,"head",head);
  profile=setFeature(profile,"faceProportion",proportion);
  profile=setFeature(profile,"jaw",expected === "broad-square" ? 5 : expected === "tapered-heart" ? 0 : 2);
  const morph=buildMorphology(profile);
  familyCards.push(`<article class="card">${buildMorphSvg(profile,{showAge:false,showLandmarks:true})}<div class="meta"><strong>${morph.family.label}</strong><span>${morph.family.id}</span></div></article>`);
}
fs.writeFileSync(path.join(docs,"morphology-families-v040.html"), page(
  "Ocho familias morfológicas", "Landmarks 2D y siluetas generadas por el starter pack analítico", "Morph Lab v0.4.0",
  `<main class="families">${familyCards.join("")}</main>`,
  `.families{display:grid;grid-template-columns:repeat(4,1fr);gap:15px}body{width:1500px;min-height:930px}`
));

const compareEntries=baseline.entries.slice(0,8);
const compareRows=compareEntries.map((entry)=>{
  const morph=buildMorphology(entry.profile);
  return `<section class="row"><div class="identity"><strong>${entry.id}</strong><span>${morph.family.label}</span></div><article class="card">${buildToonSvg(entry.profile,{showAge:false})}<div class="meta"><strong>Toon Polish</strong><span>v0.3.1</span></div></article><article class="card">${buildMorphSvg(entry.profile,{showAge:false})}<div class="meta"><strong>Morph Lab</strong><span>${morph.family.id}</span></div></article></section>`;
}).join("");
fs.writeFileSync(path.join(docs,"comparison-v031-v040.html"), page(
  "Toon Polish frente a Morph Lab", "Cada fila comparte el mismo FaceDNA y código SF2", "Deformación local",
  `<main>${compareRows}</main>`,
  `body{width:1180px;min-height:3160px}.row{display:grid;grid-template-columns:120px 1fr 1fr;gap:14px;align-items:center;margin-bottom:15px}.identity{display:grid;gap:8px}.identity strong{font-size:22px}.identity span{font-size:13px;color:#9fb0c0}`
));

const galleryCards=baseline.entries.slice(0,50).map((entry)=>{
  const morph=buildMorphology(entry.profile);
  return `<article class="card">${buildMorphSvg(entry.profile,{showAge:false})}<div class="meta"><strong>${entry.id}</strong><span>${morph.family.id}</span></div></article>`;
}).join("");
fs.writeFileSync(path.join(docs,"acceptance-gallery-v040.html"), page(
  "Galería de aceptación Morph Lab", "Primeras 50 identidades del baseline congelado", "50 SF2 estables",
  `<main class="gallery">${galleryCards}</main>`,
  `.gallery{display:grid;grid-template-columns:repeat(5,1fr);gap:13px}body{width:1200px;min-height:2390px}`
));
console.log("Generated phase 3 documentation HTML.");
