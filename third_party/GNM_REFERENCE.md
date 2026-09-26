# GNM Head — referencia opcional offline

Sports Face MVP redistributes one generated GNM-derived GLB package for the
explicitly authorized public, noncommercial MVP scope. It does not copy the
external checkout wholesale or redistribute GNM source code.

- Proyecto: GNM Head / google/GNM
- Licencia declarada por el proyecto: Apache License 2.0
- Uso previsto aquí: paquete 3D portable y generación offline
- Revisión integrada: `8ea2906a31aab7f8b550e33968f3c0a86051a92d`
- NPZ oficial SHA-256: `03649b09d1f756c94e8b3db709edcfa07ac367de0ba35e2d04c985ebcadbaf14`
- Dependencia en runtime: el GLB portable solo se carga con `sports/morph-webgl-official-v1`

La documentación de GNM describe controles separados para identidad, expresión,
pose y traslación, además de un backend NumPy y datos de modelo incluidos en su
repositorio. Revise siempre la versión y licencia de la instalación concreta.

La decisión humana registrada es `sports-face-mvp-noncommercial-mvp-authorization`,
revisor `project-owner`, fecha `2026-08-12`. El paquete contiene skin, ambos ojos,
ambas piezas de dientes/encías y lengua, UVs por esquina sin colapsar seams, y las
bases oficiales de identidad (253) y expresión (383). No incluye el bundle
completo de texturas materiales; el runtime usa materiales procedurales neutros.
El mapeo semántico a FaceDNA/expresiones queda desactivado porque los nombres
oficiales no prueban esa correspondencia.

Fase 8 (`sports/gnm-3d-player-v1`) deriva además un payload portable de
identidad/expresión a partir del NPZ oficial, de la definición oficial de 68
landmarks (`0ae8cc7aa2ef3c08dbc7fd35d6772869380e7f96`, que corrige el orden de
los anclajes 2–6 del contorno mandibular) y del decoder de expresiones del
semantic sampler oficial (`8ea2906a31aab7f8b550e33968f3c0a86051a92d`). Solo se
redistribuyen datos numéricos derivados; el decoder no se copia y GNM sigue sin
ejecutarse en el navegador. Ver `docs/ACCEPTANCE_GNM_3D_PLAYER.md`.
