# Fase 2.5 — Toon Prototype Polish v0.3.1

## Objetivo

Cerrar los defectos visuales más visibles de `v0.3.0` antes de iniciar la
integración de landmarks y GNM. Esta fase no modifica FaceDNA v2 ni el formato
SF2.

## Cambios realizados

### Expresión neutral

- Los seis tipos de ojos se renderizan abiertos y neutrales.
- Se eliminaron ojos cerrados, guiños y expresiones felices/tristes heredadas.
- Las ocho cejas se reinterpretaron como morfologías físicas.
- Las siete bocas permanecen cerradas o levemente relajadas.

### Pelo

- Los doce IDs lógicos tienen ahora un mapeo visual diferenciado.
- Se añadieron piezas deportivas propias para crop, crew, fade, rizos,
  cornrows/trenzas, media melena, pelo largo y moño.
- El pelo largo trasero se divide en paneles laterales para no formar una
  cortina rectangular sobre la camiseta.
- Se mejoró la integración de la raya y la línea frontal.

### Edad y plausibilidad

- Las canas fuertes se suprimen visualmente antes de los 30 años.
- El encanecimiento fisiológico empieza de manera determinista entre 39 y 48.
- Las barbas densas se muestran como barba incipiente entre 18 y 20 años y
  como barba corta entre 21 y 23.
- Las arrugas empiezan a aparecer a partir de 34 años y se añaden por zonas.

Estas reglas son de presentación. No reescriben `identityBits`,
`appearanceBits` ni el código SF2.

### Rostro y accesorios

- Gafas más pequeñas, alineadas y con dos monturas deterministas.
- Sombreado radial de piel para mejorar el volumen.
- Nariz, pecas, cicatriz y arrugas con menor contraste.
- Rango de deformación global reducido para evitar cabezas extremas.

### Equipación

- Cuatro patrones deportivos deterministas.
- Cuello de camiseta en dos capas.
- Motivos recortados dentro de la silueta de la camiseta.

### Interfaz

- Nombre visible `Sports Toon Polish v0.3.1`.
- Preferencia del renderizador conservada en almacenamiento local cuando el
  navegador lo permite.
- Control de edad ampliado hasta 60 años.

## Pruebas

```text
FaceDNA v2 model tests passed
Frozen baseline v0.2.1 verified: 100 SF2 + 12 SF1 migration fixtures
Toon polish tests passed: 100 frozen identities + neutral mapping,
age plausibility and 1,000 generated profiles
```

## Referencias visuales

- `comparison-v030-v031.png`: 18 identidades antes/después.
- `acceptance-gallery-v031.png`: 50 identidades congeladas.
- `app-v031-toon-polish.png`: aplicación completa.

## Límites que permanecen

- Toon Head continúa partiendo de una única topología facial.
- La mandíbula y los pómulos solo reciben deformación global.
- Algunos peinados propios son todavía ilustraciones provisionales.
- No hay landmarks ni deformación local de SVG.
- GNM todavía no interviene en el pipeline.

Estos límites corresponden a la fase 3 y no bloquean el cierre de la 2.5.
