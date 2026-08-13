## Unreleased — Operativa GNM

- Añade visualización técnica de deformación opt-in (session state, OFF por
  defecto) en los estilos oficial neutral y Basis Lab, para hacer visibles las
  diferencias de las bases GNM sobre los materiales planos sin inventar
  texturas. `UV checker` sube las `TEXCOORD_0` oficiales exactas por vértice y
  dibuja un checker procedural determinista muestreado en espacio UV
  (`OFFICIAL_UV_CHECKER_DENSITY = 16`) que se deforma con la malla; `Wireframe
  edges` añade un segundo pase `gl.LINES` con aristas generadas
  deterministicamente desde los triángulos existentes (edge count `105,972`
  para `35,324` triángulos), compartiendo el buffer de posiciones con la
  deformación CPU de Basis Lab y conservando depth test y culling two-sided.
  Los diagnósticos exponen `technicalVisualization` (`none`/`uv-checker`/
  `wireframe`/`uv-checker+wireframe`), `technicalVisualizationNote` (ayuda de
  inspección, no textura/material oficial), `uvCheckerDensity`,
  `wireframeColor` y `wireframeEdgeCount`. Con los toggles OFF el hash de
  píxeles es byte-idéntico al anterior; no cambian GLBs, payload de Basis Lab,
  FaceDNA, SF2, material defaults ni mapping semántico. Añade tests Node del
  contrato y cobertura Playwright en `tests/browser_smoke.py`.

- Añade la Fase 7B: validador estadístico offline stdlib-only y reporte
  determinista de calibración. El resultado actual es `insufficient_data` con
  template vacío, conteos y métricas cero, sin R²/correlaciones inventadas. El
  siguiente paso humano es añadir muestras reales revisadas mediante Fase 7A;
  ningún mapping se activa y `semanticMapping`/`runtimeBasisLoaded` permanecen
  `unestablished`/`false`.

- Añade la Fase 7A: contrato offline determinista para anotaciones humanas de
  calibración. El template queda vacío —sin muestras no existe mapeo— y las
  etiquetas son libres para revisión técnica, no verdad anatómica. Conserva
  SF2, metadatos estables, ocho coeficientes bounded, hashes, procedencia y
  split reproducible; no guarda geometría, arrays, secretos, PII ni rutas
  absolutas. `semanticMapping` sigue `unestablished`, el runtime no carga bases
  y `humanApproved` es falso salvo aprobación explícita.

- Añade la Fase 6 de evidencia cuantitativa offline: reporte stdlib-only con
  hashes/revisión, dimensiones `253`/`383`/`17.821`, energía por base, familia,
  componente y prefijo técnico, inventario FaceDNA/morphology y análisis
  provisional de regiones. Declara `semanticMapping: unestablished` y
  `runtimeBasisLoaded: false` porque no existe un dataset emparejado FaceDNA →
  coeficiente/objetivo GNM. No cambia runtime, FaceDNA, morphology, GLBs ni el
  Basis Lab técnico.

- Mejora la calidad visual del renderer oficial con el modelo inmutable
  `neutral-procedural-components-v2`: seis materiales procedurales neutros por
  componente, roughness perceptual, respuesta especular, ambiente hemisférico,
  key/fill/rim y cavidad bounded derivada de señales estables de vista/normal.
  No añade texturas, dependencias, semántica anatómica ni cambios a los GLB o al
  payload de Basis Lab. Los diagnósticos exponen versión, seis materiales y
  flags de iluminación; el shader GLSL ES 3.00 conserva two-sided, cámara y
  fallback seguro.

- Añade el estilo opt-in `sports/morph-webgl-official-basis-lab-v1` con payload
  binario separado de `1,843,736` bytes, cuatro primeras bases por familia,
  sliders técnicos bounded, verificación estricta de hash/schema/budget y
  fallback seguro. No modifica FaceDNA, SF2 ni los GLB canónico/render.

- Añade un diagnóstico/scrubber offline determinista para las bases oficiales
  GNM: schema v2, dimensiones `253 x 17.821 x 3` y `383 x 17.821 x 3`, nombres
  ordenados, payloads float32 finitos con longitudes exactas, reconstrucción
  zero/one-hot, bounds de desplazamiento y mappings `sourceVertexId` byte-a-byte
  para las seis componentes. El reporte no contiene rutas absolutas e indica
  `semanticMapping: disabled` y `runtimeBasisLoaded: false`. Es evidencia
  únicamente; no modifica GLB, FaceDNA, morphology, render-router ni la carga de
  bases en navegador.

- Añade el GLB render-only oficial GNM optimizado de forma lossless: `665,904`
  bytes frente a `138,998,408` bytes canónicos (`99.52%` menos), `18,437`
  vértices únicos, seis componentes, UVs/posiciones float32 exactas e índices
  uint16. El runtime y Pages usan solo este asset; el GLB canónico archivado y
  sus bases permanecen sin cambios. Las bases de identidad/expresión quedan
  omitidas y offline/opcionales; el mapeo semántico continúa desactivado.

- Integra el primer paquete 3D oficial de GNM Head v3.0 en el alcance público no
  comercial autorizado por el propietario del proyecto: GLB portable con skin,
  ojos, dientes/encías y lengua separados, UVs oficiales sin colapsar seams,
  bases de identidad/expresión y materiales procedurales neutros. El estilo
  `sports/morph-webgl-official-v1` es opt-in, conserva el fallback anterior y no
  asigna semántica anatómica no demostrada. No se incluye el bundle completo de
  texturas materiales.

- Añade una comparación bounded report-only entre el pack GNM canónico de 200 y
  candidatos de 400/800 muestras: diversidad, duplicados, vecinos normalizados,
  rangos/varianzas, balance familiar, deltas de centroides, procedencia y
  reruns deterministas. La evidencia actual de 400 muestras es `warn`; no
  promueve candidatos, no cambia runtime ni demuestra anatomía y requiere
  revisión humana antes de promoción. Sin GNM/NumPy el reporte queda en
  `unavailable` sin inventar métricas.
- Mejora la auditoría provisional de landmarks como quality gate report-only:
  informa `provisionalReview: required`, no promociona corrección anatómica,
  detalla excursiones de proyección y extremos XYZ crudos cuando NumPy está
  disponible, y registra el drift de nombres de fuente como WARN con evidencia
  de identidad byte a byte. No cambia IDs ni artefactos GNM.
- Añade un workflow que ejecuta `npm test` antes de publicar el sitio estático mínimo en GitHub Pages.
- Añade `tools/gnm/build_runtime_pack.py`, un orquestador determinista para
  generar y validar candidatos GNM de 200 cabezas sin reemplazar el paquete de
  runtime salvo mediante `--promote` explícito.
- Añade pruebas de planificación sin importar GNM/NumPy y el helper no-GNM
  `npm run refresh:release` para actualizar hashes del manifiesto.
- Documenta instalación externa de GNM, revisión del mapa provisional,
  promoción, regeneración del bundle y comprobaciones de release.
- Añade la exportación y validación offline del template GNM retenido como GLB
  geometry-only; no inventa UVs, texturas o submallas ausentes.
- Añade la primera slice acotada de Fase 3: reducción PCA/SVD offline de las 200
  mallas GNM a 16 morph targets neutrales con payload binario float32 validado;
  la integración WebGL posterior mantiene los nombres neutrales y no añade controles semánticos.
- Integra esos 16 targets en `tools/gnm/work/head-morph.glb` con base
  `template + meanDelta` y añade `sports/morph-webgl-v1`, un prototipo WebGL2
  opt-in con textura `sampler2DArray` y fallback seguro al SVG GNM. SVG sigue
  siendo el default; los targets son geometry-derived y sus nombres son neutrales.
- Añade una comparativa A/B bounded y reproducible de ocho perfiles FaceDNA entre
  SVG GNM y WebGL2, con capturas PNG, reporte HTML, manifest JSON y validador
  stdlib-only. La evidencia es cualitativa, no pixel-equivalent; WebGL2 ausente
  queda como `fallback` o `unavailable`.
- Endurece únicamente `sports/morph-webgl-v1` con encuadre determinista basado
  en bounds y desplazamiento morph conservador, depth test diagnosticado,
  sombreado GLSL ambiente/difuso/fill/rim y dibujo two-sided porque el GLB tiene
  winding mixto. Añade métricas objetivas de canvas, ocupación, bounding box,
  `readPixels` y errores GL a la evidencia A/B; no declara corrección semántica
  ni WebGL production-ready.
- Añade microexpresiones sutiles y deterministas en Morph Lab, coordinadas entre
  ojos, cejas y boca sin convertir el retrato neutral en una animación.
- Añade selector persistente de microexpresión (`Automática`, `Neutral`,
  `Alerta`, `Relajada`, `Concentrada`) exclusivo de Morph Lab.
- Añade una puerta stdlib-only de intake para un futuro bundle oficial GNM:
  manifest fail-closed, procedencia/licencia, permiso explícito de
  redistribución, hashes, completitud geométrica y estados `proposed` ->
  `reviewed` -> `accepted`. Esta fase no acepta ni redistribuye assets oficiales
  ni cambia el runtime.
- Corrige el contrato de `sports/morph-webgl-v1`: sus 16 pesos PCA dependen solo
  de la identidad permanente (`getFaceValues` de identidad y, para
  decorrelación, `identityBits`). Cambios de apariencia, edad, presentación,
  equipación, expresión o semilla con los mismos bits de identidad no alteran la
  geometría. Los componentes PCA continúan siendo direcciones derivadas de
  geometría, no controles anatómicos semánticos.
- Añade controles opt-in de inspección para WebGL2: órbita con arrastre, zoom con
  rueda y restablecimiento accesible de cámara. El estado por canvas es bounded,
  el frente por defecto sigue siendo determinista y los gestos redibujan recursos
  GPU existentes sin refetch ni reupload. WebGL continúa geometry-only y no añade
  texturas ni assets oficiales.

## 0.4.0 — Morph Lab

- Añade el renderer `sports/morph-v1`.
- Añade 28 landmarks 2D deterministas.
- Añade ocho familias de cabeza y mandíbula.
- Sustituye la escala facial global por silueta generada y deformaciones locales.
- Añade overlay de landmarks en la interfaz.
- Añade pipeline offline preparado para GNM Head.
- Añade el renderer opt-in `sports/morph-gnm-v1` con un paquete portable
  incrustado en el bundle; `sports/morph-v1` sigue siendo el default analítico.
- Mantiene GNM fuera del navegador y del runtime; la selección de familia GNM
  usa la tabla semántica revisada `face-dna-shape-v1` sobre `head` y
  `faceProportion`, alineada con las etiquetas actuales del pack.
- Identifica el starter pack como analítico y no derivado de GNM.
- Marca como provisional el mapa de landmarks usado por el paquete GNM actual.
- Conserva FaceDNA v2, SF2, SF1 y los renderers anteriores.

## 0.3.1 — Fase 2.5 / Toon Polish

- Neutraliza ojos, cejas y bocas para retratos de ficha deportiva.
- Diferencia los 12 IDs de pelo y corrige pelo largo y trenzas.
- Añade reglas visuales de canas y barba por edad sin modificar FaceDNA.
- Mejora gafas, sombreado, nariz, arrugas y rango morfológico.
- Añade cuatro patrones de equipación recortados y cuello deportivo.
- Conserva el baseline completo de v0.2.1.
- Añade comparativa antes/después y galería de aceptación de 50 jugadores.

## 0.3.0

- Añade el renderer local `sports/toon-prototype`.
- Añade selector de estilo sin modificar FaceDNA/SF2.
- Integra un subconjunto modificado de ToonHead con atribución CC BY 4.0.
- Añade pelo frontal/trasero, adaptación deportiva y morfología básica.
- Añade pruebas sobre 100 identidades congeladas y 1.000 perfiles nuevos.
- Conserva íntegramente el baseline de v0.2.1.

## Freeze 2026-08-05

- Congela 100 perfiles FaceDNA v2 reproducibles.
- Congela 12 migraciones SF1 → SF2.
- Añade dos galerías visuales de referencia.
- Conserva cinco muestras manuales.
- Añade hashes y verificación automática.
- No modifica el renderer ni el esquema FaceDNA.

## 0.2.1

- Corrige la pantalla vacía al abrir `index.html` mediante `file://`.
- Añade `src/app.bundle.js`, compatible con apertura directa por doble clic.
- Conserva la entrada modular en `index.module.html`.
- Añade instrucciones y un lanzador opcional para Windows.

# Changelog

## 0.2.0 — Fase 1 / FaceDNA v2

- Separada identidad permanente de apariencia mutable.
- Añadidos estilos etiquetados y registro de especificaciones.
- Añadidos IDs lógicos de assets.
- Añadidas variables reservadas para orejas, mandíbula y proporción facial.
- Implementadas reglas de compatibilidad y máscara canónica de campos inactivos.
- Añadido código SF2 con checksum.
- Añadida migración automática desde SF1.
- Aleatoriedad estable derivada por rasgo.
- Presentación y edad conservan la identidad.
- Añadidas pruebas de 1.000 perfiles.
- Añadida documentación de auditoría, formato, migración y aceptación.

## 0.1.0 — MVP inicial

- Bitfield facial de 32 bits.
- Render Canvas provisional.
- Semilla, editor, envejecimiento, galería y exportación PNG.
