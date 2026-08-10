# Paso 2 — Integración `sports/toon-prototype`

## Alcance realizado

- Segundo renderer local y seleccionable.
- FaceDNA v2 y códigos SF2 sin cambios.
- Subconjunto vectorial ToonHead derivado de la definición oficial.
- Ojos, cejas y bocas filtrados hacia poses más neutrales.
- Pelo frontal/trasero, barba, recoloreado y equipación deportiva.
- Morfología básica por escalado usando cabeza, mandíbula y proporción facial.
- Gafas, pecas, cicatriz, nariz y edad añadidas por Sports Face.
- Atribución visible y documentación CC BY 4.0.
- Funcionamiento sin red y compatible con doble clic.

## Limitaciones deliberadas

- No es la implementación completa del motor DiceBear ni garantiza SVG idéntico
  al paquete oficial.
- ToonHead solo posee una cabeza base; la morfología actual es deformación global.
- El catálogo de pelo continúa siendo pequeño y se reutiliza para los 12 IDs.
- La expresividad se ha neutralizado, por lo que no se muestran todas las
  variantes originales.
- Esta combinación de licencias debe revisarse antes de distribución comercial.

## Criterios verificados

- 100 identidades congeladas conservan exactamente su SF2.
- 1.000 perfiles adicionales generan SVG válido y determinista.
- El selector de renderer no forma parte de FaceDNA.
- El renderer no contiene solicitudes de red.
- El baseline de `v0.2.1` sigue pasando.
