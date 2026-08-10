# Fase 3 — Morph Lab y preparación offline de GNM

## Estado

Implementada en `v0.4.0`.

La fase añade el laboratorio morfológico y dos estilos explícitos:

```text
sports/default-v2
sports/toon-prototype
sports/morph-v1
sports/morph-gnm-v1
```

`sports/morph-v1` continúa siendo el estilo analítico predeterminado. El estilo
`sports/morph-gnm-v1` consume únicamente el paquete portable generado offline;
no sustituye el renderer analítico ni modifica FaceDNA.

El selector continúa fuera de FaceDNA y de los códigos SF2.

Morph Lab expone un selector de microexpresión con los modos `auto`, `neutral`,
`alert`, `soft` y `focused`. `auto` conserva la selección determinista derivada
de FaceDNA; los modos explícitos solo cambian el perfil de expresión. La
preferencia se guarda en `sports-face-expression-mode` y no aparece en FaceDNA,
SF2 ni en los estilos original y Toon.

## Entregables completados

### Landmarks 2D

Cada perfil genera 28 landmarks deterministas para:

- contorno craneal y mandíbula;
- orejas;
- cejas y ojos;
- puente, punta y alas de la nariz;
- boca;
- línea frontal del pelo.

Los landmarks dependen únicamente de la identidad permanente. Edad, camiseta,
peinado y otros elementos mutables no los modifican.

### Ocho familias morfológicas

- oval equilibrada;
- ancha y cuadrada;
- larga y estrecha;
- angular atlética;
- compacta y redonda;
- cónica / corazón;
- frente alta;
- baja y ancha.

### Deformación local

Ya no se aplica únicamente una escala global. Cada zona tiene su propia
transformación:

- ojos;
- cejas;
- nariz;
- boca;
- gafas;
- barba;
- pelo frontal;
- pelo trasero.

El contorno de cabeza se reconstruye mediante una curva SVG generada a partir de
landmarks de cráneo, pómulos, mandíbula y barbilla.

### Diagnóstico visual

La interfaz permite activar una superposición de landmarks. La opción es local
a la interfaz y no forma parte del perfil guardado.

### Preparación offline de GNM

Se incluyen herramientas para:

1. generar identidades neutrales con GNM Head;
2. proyectar vértices revisados a landmarks 2D;
3. agrupar las muestras en familias;
4. validar el paquete portable.

#### Flujo operativo reproducible

GNM Shape se instala aparte, en el entorno Python 3.13 recomendado por su
proyecto. Ese entorno se activa únicamente para generar datos offline; GNM no
se instala en npm y no se importa en el navegador/runtime.

```bash
source /path/to/gnm/shape/.venv/bin/activate
python tools/gnm/build_runtime_pack.py \
  --count 200 --seed 400 --sigma 1.15 --families 8
```

El comando ejecuta sampler, projector, builder y validator con el
`sys.executable` activo. Su salida predeterminada es el candidato
`tools/gnm/work/gnm-morphology-pack-200.json`; no reemplaza el pack canónico.
Revisa el mapa provisional, los landmarks y las ocho familias antes de repetir
el comando con `--promote`:

```bash
python tools/gnm/build_runtime_pack.py \
  --count 200 --seed 400 --sigma 1.15 --families 8 --promote
npm run build:offline
npm test
npm run refresh:release
python3 -m json.tool docs/release-manifest-v040.json >/dev/null
```

La promoción es explícita y el orquestador imprime estos comandos de
seguimiento. `npm run build:offline` incrusta únicamente el JSON portable en el
bundle; `npm run refresh:release` actualiza los hashes operativos del manifiesto.
El pack es el único dato de GNM que recibe el navegador.

El paquete portable de `sports/morph-gnm-v1` contiene ocho familias y un contrato
de 14 features positivos y finitos:

```text
craniumWidth, cheekWidth, jawWidth, chinWidth, faceHeight,
foreheadHeight, eyeSpacing, eyeWidth, eyeHeight, noseLength,
noseWidth, mouthWidth, earSpan, templeSlope
```

GNM en sí no se carga en el navegador y no es una dependencia de ejecución del
juego. El navegador recibe solamente el JSON generado, embebido en el bundle
offline y consumido por el estilo explícito `sports/morph-gnm-v1`.

### Selección semántica de familias

La familia GNM no se elige con la semilla del perfil. Se aplica la versión de
reglas `face-dna-shape-v1` sobre dos variables permanentes de FaceDNA:
`head` y `faceProportion`.

| Regla FaceDNA | Familia GNM actual |
|---|---|
| `faceProportion === 5` | `gnm-08-high-forehead` |
| `faceProportion <= 1` y `head` en `{1, 4}` | `gnm-02-compact-wide` |
| resto, `head === 0` | `gnm-03-balanced` |
| resto, `head === 1` | `gnm-06-broad` |
| resto, `head === 2` | `gnm-07-long` |
| resto, `head === 3` | `gnm-05-angular` |
| resto, `head === 4` | `gnm-01-compact` |
| resto, `head === 5` | `gnm-04-tapered` |

Es una tabla explícita revisada y alineada a las etiquetas actuales del pack;
no se presenta como un mapeo aprendido. Mandíbula y las demás variables
permanentes continúan modificando las métricas dentro de la familia elegida,
sin participar en la selección para evitar cambios inestables.

## Precisión sobre el paquete actual

Las familias incluidas en `src/morphology.js` y
`assets/morphology/starter-pack-v1.json` son un scaffold analítico. Sirven para
validar el pipeline, la deformación y los contratos de datos.

**No se presentan como resultados derivados de GNM.**

La sustitución por un paquete medido requiere ejecutar el pipeline de
`tools/gnm/` con una instalación externa de GNM y un mapa de vértices revisado.
El mapa no se adivina automáticamente para evitar datos anatómicos erróneos.

## Compatibilidad

No se ha modificado:

- FaceDNA v2;
- identityBits;
- appearanceBits;
- SF2;
- migración SF1 → SF2;
- baseline de 100 identidades;
- renderer Toon Polish v0.3.1.
