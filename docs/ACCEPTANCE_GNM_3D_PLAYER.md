# Aceptación: GNM 3D Player (Fase 8)

El estilo opt-in `sports/gnm-3d-player-v1` convierte la cabeza GNM oficial en un
**generador 3D de jugadores**: cada perfil FaceDNA produce su propia geometría
GNM Head v3.0 (un vector oficial de identidad), con tono de piel, iris, labios,
cejas, barba, pelo, pecas, cicatriz, gafas, microexpresión y camiseta según su
FaceDNA. GNM nunca se ejecuta en el navegador: un builder offline genera un
payload portable y el runtime solo reconstruye combinaciones lineales.

El estilo por defecto sigue siendo `sports/default-v2`; FaceDNA, SF2, el baseline
congelado, el renderer oficial neutro y el Basis Lab no cambian.

## Camino rápido

```bash
npm test                                   # incluye test:gnm-player y test:gnm-player-generator
npm run validate:gnm-player-generator      # validador stdlib del payload comprometido
```

Regeneración offline (entorno externo con NumPy y h5py; checkout de `google/GNM`):

```bash
GNM_ROOT=/path/to/GNM npm run build:gnm-player-generator
GNM_ROOT=/path/to/GNM python3 tools/gnm/test_player_generator.py   # rebuild byte a byte
```

Evidencia visual y smoke de navegador (servidor HTTP en la raíz):

```bash
python3 -m http.server 8080 &
python3 tools/gnm/capture_player_gallery.py --url http://127.0.0.1:8080/index.module.html
CHROMIUM_PATH=/path/to/chromium python3 tests/browser_smoke.py
```

## Fuentes y procedencia

| Entrada | Revisión upstream | SHA-256 |
| --- | --- | --- |
| `gnm/shape/data/versions/v3_0/gnm_head.npz` | `8ea2906a31aab7f8b550e33968f3c0a86051a92d` | `03649b09d1f756c94e8b3db709edcfa07ac367de0ba35e2d04c985ebcadbaf14` |
| `gnm/shape/data/landmarks/head_sparse_68.txt` | `0ae8cc7aa2ef3c08dbc7fd35d6772869380e7f96` | `d8b6066a87ca37c48bcf4d0834542db841709b65cb983e873fa1e441a22219d0` |
| `gnm/shape/data/semantic_sampler/expression_decoder_model.h5` | `8ea2906a31aab7f8b550e33968f3c0a86051a92d` | `5eba165f8a414f73b24be96963d0a17e708c0856739ed85a19031f318dfb51e6` |
| `tools/gnm/work/gnm-official-head-render.glb` | render aceptado | `081ddb9b1f6b26a76255fb1710b763bcb105941139cba1490a501b99c568e23f` |
| `tools/gnm/work/LICENSE-GNM.txt` | Apache-2.0 | `58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd` |

- Los landmarks usan la corrección upstream `0ae8cc7`: en la revisión fijada
  (`8b4b7590…`) los anclajes 2–6 del contorno mandibular estaban invertidos. El
  builder acepta el archivo fijado y aplica exactamente esa corrección,
  comprobando que el resultado coincide con el archivo corregido. Los arrays del
  NPZ son idénticos entre ambas revisiones.
- El decoder CVAE del semantic sampler oficial (Keras) es un MLP ReLU
  `84-64-128-256-512 → 383`; se evalúa en NumPy, sin TensorFlow.
- Alcance: la misma autorización no comercial registrada
  (`sports-face-mvp-noncommercial-mvp-authorization`, `project-owner`,
  `2026-08-12`).

## Payload

`tools/gnm/work/gnm-player-generator.bin` (`6,130,704` bytes, presupuesto
`6,815,744`) y `gnm-player-generator.json`:

- 32 direcciones oficiales `head_000..head_031` (el 98,1 % de la energía de
  identidad de cabeza), 19 "colas" de direcciones de rasgo y 3 presets de
  expresión, en int16 con una escala float32 por vector (error máximo de
  cuantización `1.5e-7` m).
- 20 campos uint8 por vértice fuente derivados de grupos oficiales
  (`irises`, `pupils`, `eye_exteriors`, `upper_lip`, `mouth_sock`, `teeth`,
  regiones de mejilla/nariz/frente, `ears`, `hockey_mask`) y de los 68 landmarks.
  Son coordenadas de pintura procedural, no texturas oficiales. Todos los campos
  son continuos: un corte con valores centinela pintaba líneas falsas al
  interpolar, y se eliminó.
- Los vértices se indexan por `sourceVertexId` oficial; el runtime los mapea con
  el `sourceVertexIndicesAccessor` del GLB render.

## Contrato de identidad

- Solo los ocho rasgos geométricos de identidad (`head`, `jaw`,
  `faceProportion`, `nose`, `eyes`, `mouth`, `brows`, `earShape`) afectan a la
  geometría. Pigmentación (`skin`, `eyeColor`, `freckles`), apariencia, edad,
  presentación, equipación, `seed` y microexpresión nunca cambian los
  coeficientes de identidad.
- **Prior composicional**: cada rasgo aporta un bloque gaussiano independiente
  sembrado por su valor (`gnm-player:prior:<rasgo>:<valor>`), ponderado por su
  cuota de varianza (head 24 %, jaw 14 %, faceProportion 14 %, nose 12 %, eyes
  10 %, mouth 10 %, brows 8 %, earShape 8 %). El resultado es N(0, 1) por
  componente, como el prior oficial; editar un rasgo solo re-sortea su cuota,
  así que el jugador sigue siendo reconocible. Las normales se aproximan con
  Irwin–Hall (12 uniformes; solo sumas exactas), deterministas en cualquier
  motor JS, y se acotan a ±3.
- **Condicionamiento medido**: 19 rasgos antropométricos lineales sobre los 68
  landmarks oficiales y vértices fijos (`faceWidth`, `jawWidth`, `chinWidth`,
  `faceHeight`, `foreheadHeight`, `noseLength`, `noseWidth`, `noseProjection`,
  `bridgeHeight`, `mouthWidth`, `lipThickness`, `mouthCornerLift`, `eyeWidth`,
  `eyeOpening`, `canthalTilt`, `eyeDepth`, `browHeight`, `earHeight`,
  `earProjection`). Las etiquetas del catálogo FaceDNA fijan objetivos en
  z-score (se suman y se acotan a ±2) y el prior se condiciona con la regla de
  Matheron: `c = c0 + Gᵀ(GGᵀ + τ²I)⁻¹(objetivo + η − G·c0)`, `τ = 0.3`.
- Cada rasgo guarda su dirección de gradiente completa sobre las 170
  componentes de cabeza, por lo que la reconstrucción es exacta: **cada jugador
  es un vector oficial de identidad GNM** (170 coeficientes de cabeza; ojos y
  dientes en la plantilla) reproducible con el modelo oficial.

| Etiqueta FaceDNA | Objetivos (z) |
| --- | --- |
| `head/broad`, `long`, `square`, `round`, `tapered` | anchura/altura de cara, mandíbula y barbilla |
| `jaw/very-narrow` … `very-broad`, `angular` | `jawWidth` −1.6 … +1.6; angular: barbilla +0.9 |
| `ratio/compact` … `very-long`, `high-forehead` | `faceHeight` −1.4 … +1.4; `foreheadHeight` +1.5 |
| `nose/wide`, `narrow`, `short`, `long`, `aquiline`, `rounded`, `flat-bridge` | anchura, longitud, proyección y puente nasal |
| `mouth/wide`, `narrow`, `full`, `thin`, `upturned`, `downturned` | anchura, grosor de labios, comisuras |
| `eyes/almond`, `round`, `deep`, `narrow`, `upturned`, `downturned` | apertura, anchura, profundidad, inclinación cantal |
| `brows/low`, `high` | `browHeight` ∓1.3 (el resto de estilos de ceja son pintura) |
| `ears/small`, `large`, `projecting` | `earHeight` ∓1.4, `earProjection` +1.6 |

La tabla completa y exacta está en `GNM_PLAYER_LABEL_TARGETS`
(`src/gnm-player-model.js`). Es un mapeo de diseño **medido** sobre landmarks
oficiales, no un estudio perceptual: el pipeline de calibración humana de la
Fase 7 sigue siendo el camino para validar semántica perceptual. Los flags del
renderer oficial neutro y del Basis Lab no cambian.

## Expresión

Los presets oficiales se decodifican del semantic sampler en la media latente
(`z = 0`): SURPRISE, HAPPY y SQUINT. La microexpresión compartida con Morph Lab
elige el preset (`alert` → SURPRISE 0.35, `soft` → HAPPY 0.24, `focused` →
SQUINT 0.42, `neutral` → ninguno) y `auto` usa exactamente
`deriveMicroExpressionProfile`. La expresión cambia vértices, nunca la
identidad.

## Render

- WebGL2 sin dependencias; reconstrucción en CPU (~6 ms por jugador en Node),
  normales suaves por vértice fuente (sin costuras UV) y un canvas propio
  (`#portrait-gnm3d`) para que sus controles de cámara no redibujen otro estilo.
- Pases: fondo con el color de la equipación, piel/ojos/dientes/lengua opacos,
  capa volumétrica de pelo, busto de camiseta procedural (hombros en
  superelipse, cuello en color secundario), gafas procedurales ajustadas a los
  landmarks, moño y, por último, córnea y lentes transparentes.
- Iluminación de estudio en espacio de vista (key/fill/rim + hemisferio),
  difusión envolvente para la piel, GGX, brillo anisotrópico en el pelo y tone
  mapping ACES.
- Vista inicial 3/4 determinista; arrastre, rueda y `Restablecer cámara`.
- La galería renderiza miniaturas 3D con un único contexto WebGL2 compartido.
- Sin WebGL2, sin `fetch` (`file://`) o con hash/esquema inválido, se usa el
  renderer 2D GNM SVG con el mismo aviso que los demás estilos WebGL.

## Criterios de aceptación

| Criterio | Estado | Evidencia |
| --- | --- | --- |
| Payload validado (layout, hashes, procedencia, presupuesto, rasgos, landmarks) | Aprobado | `validate_player_generator.py` |
| Fallo cerrado ante manipulación (16 mutaciones) | Aprobado | `test_player_generator.py` |
| Rebuild determinista byte a byte desde las entradas fijadas | Aprobado | `test_player_generator.py` con `GNM_ROOT` |
| Determinismo e invarianza de identidad | Aprobado | `tests/gnm-player.test.mjs` |
| Edición de un rasgo conserva la cara (correlación del prior > 0.6) | Aprobado | `tests/gnm-player.test.mjs` |
| Reconstrucción exacta (rasgos medidos = predicción lineal, < 2e-3 z) | Aprobado | `tests/gnm-player.test.mjs` |
| 12 pares de etiquetas ordenan su rasgo medido | Aprobado | `tests/gnm-player.test.mjs`, `docs/gnm-3d-player/label-pairs.png` |
| Coeficientes acotados (max \|c\| < 4.6 en 250 perfiles) | Aprobado | `tests/gnm-player.test.mjs` |
| Presets oficiales: HAPPY sube comisuras, SQUINT cierra ojos, SURPRISE sube cejas | Aprobado | `tests/gnm-player.test.mjs` |
| Paridad con el catálogo FaceDNA (paletas, pelo, barba, cejas, etiquetas) | Aprobado | `tests/gnm-player.test.mjs` |
| Navegador: diagnósticos, cámara, edad sin cambio de identidad, nariz y expresión, galería 3D | Aprobado | `tests/browser_smoke.py` |
| `index.html` por HTTP renderiza 3D; por `file://` cae al SVG sin errores | Aprobado | comprobación Playwright |
| CI sin objetos LFS | Aprobado | `tools/gnm/canonical_asset.py` |

## Evidencia visual

[`docs/gnm-3d-player/`](gnm-3d-player/) contiene `gallery.png` (16 jugadores de
semillas fijas), `label-pairs.png` (mismo jugador con etiquetas opuestas y su
z-score de identidad) y `manifest.json`. Se capturó con Chromium + SwiftShader;
los píxeles dependen de GPU/driver, los valores del manifest son deterministas.

## Límites conocidos

- Pelo con pintura + capa volumétrica: los estilos largos, trenzas y rizos son
  aproximaciones procedurales (sin mechones ni hair cards); el moño es una
  esfera.
- Sin texturas oficiales, poros ni arrugas; la edad solo cambia colores (la
  geometría es solo identidad por contrato).
- Las componentes de identidad de ojos y dientes quedan en la plantilla.
- Las etiquetas se combinan de forma aditiva: combinaciones opuestas se
  compensan (por ejemplo `head/long` + `ratio/compact`).
- La presentación no altera la geometría (contrato FaceDNA); el prior cubre
  toda la población del modelo.
- Primera carga: ~6.9 MB (payload, metadata y GLB render).
