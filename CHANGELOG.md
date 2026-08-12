## Unreleased — Operativa GNM

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
- Añade microexpresiones sutiles y deterministas en Morph Lab, coordinadas entre
  ojos, cejas y boca sin convertir el retrato neutral en una animación.
- Añade selector persistente de microexpresión (`Automática`, `Neutral`,
  `Alerta`, `Relajada`, `Concentrada`) exclusivo de Morph Lab.

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
