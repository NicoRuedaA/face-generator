# Fase 3 — Morph Lab y preparación offline de GNM

## Estado

Implementada en `v0.4.0`.

La fase añade el laboratorio morfológico y cinco estilos explícitos:

```text
sports/default-v2
sports/toon-prototype
sports/morph-v1
sports/morph-gnm-v1
sports/morph-webgl-v1
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

#### Fase 2: template GLB geometry-only

La Fase 2 añade una exportación offline de la malla `template` retenida en
`tools/gnm/work/gnm-heads-200.npz`:

```bash
npm run build:gnm-glb
npm run test:gnm-glb
python tools/gnm/validate_gnm_glb.py tools/gnm/work/head.glb
```

El GLB contiene una sola escena, nodo y mesh, con posiciones float32, índices
uint32, material neutro y bounds finitos. La salida actual es de 17.821 vértices,
35.324 triángulos y 105.972 índices. Es un artefacto geometry-only para uso
offline; no sustituye el renderer analítico ni modifica FaceDNA. El GLB WebGL2
opt-in se documenta más abajo y SVG continúa siendo el default.

El NPZ retenido no contiene UVs, texturas, ojos, dientes, lengua ni morph targets.
No se simulan ni se rellenan esos datos: deben añadirse solamente desde datos
oficiales de GNM en una slice posterior. La especificación de aceptación está en
[`ACCEPTANCE_GNM_GLB.md`](ACCEPTANCE_GNM_GLB.md).

#### Fase 3: reducción offline de morph targets

La primera slice acotada de la Fase 3 reduce las 200 mallas de identidad
neutrales retenidas a un paquete PCA portable. Es exclusivamente una operación
offline: no añade WebGL, no carga el paquete en el navegador, no integra targets
en el GLB y no cambia el renderer SVG predeterminado. `src/` permanece intacto.

El archivo retenido contiene `identities` con forma `(200, 253)`, que son
parámetros de identidad y no mallas. El builder inspecciona las formas y usa la
matriz `vertices` `(200, 17821, 3)` como datos de malla por muestra; si no existe
una fuente válida, termina con error y no fabrica datos. Las mallas se comparan
con `template`, se centra el delta medio y se aplica PCA/SVD determinista. El
paquete registra el origen, el inventario del NPZ, la varianza explicada, el
error residual y los offsets exactos del payload binario.

```bash
npm run build:gnm-morph-targets
npm run test:gnm-morph-targets
python tools/gnm/validate_gnm_morph_targets.py tools/gnm/work/gnm-morph-targets.json
```

El rango aceptado es de 12 a 20 targets; el artefacto canónico usa 16 targets
con etiquetas neutrales `gnm-pca-01` ... `gnm-pca-16`. No se deben sustituir por
nombres anatómicos: son un prototipo derivado de geometría, no controles
semánticos oficiales de GNM. El resultado actual conserva `95.2596%` de la
varianza, deja `4.7404%` residual, tiene RMSE residual `0.0172562` y error
absoluto máximo `0.147963` en las unidades de la malla.

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
npm run test:gnm-quality
npm run refresh:release
python3 -m json.tool docs/release-manifest-v040.json >/dev/null
```

La promoción es explícita y el orquestador imprime estos comandos de
seguimiento. `npm run build:offline` incrusta únicamente el JSON portable en el
bundle; `npm run refresh:release` actualiza los hashes operativos del manifiesto.
El pack es el único dato de GNM que recibe el navegador.

La aceptación determinista del pack canónico también puede ejecutarse directamente:

```bash
npm run test:gnm-quality
```

La puerta está descrita en [`docs/ACCEPTANCE_GNM_QUALITY.md`](ACCEPTANCE_GNM_QUALITY.md).

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

La auditoría de landmarks de la fase 1 se ejecuta con:

```bash
npm run test:gnm-landmarks
```

Valida siempre el mapa y los JSON con la biblioteca estándar. Si se conserva
`tools/gnm/work/gnm-heads-200.npz`, usa NumPy para comprobar las coordenadas del
template y la orientación bilateral sobre la malla. El baseline actual es
`PASS with WARN`: los avisos de bounds y asimetría describen la normalización
estable y no son evidencia suficiente de IDs anatómicamente incorrectos.

La evidencia visual reproducible del baseline 2D se genera fuera del release
con Chromium/CDP:

```bash
python /home/nico/.agents/skills/webapp-testing/scripts/with_server.py \
  --server "python3 -m http.server 8080" --port 8080 -- \
  python3 tools/gnm/capture_acceptance_gallery.py
```

El procedimiento, los ocho inputs fijos, los criterios de aceptación y la
variante con overlay están en
[`docs/ACCEPTANCE_GNM_GALLERY.md`](ACCEPTANCE_GNM_GALLERY.md).

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

La siguiente slice acotada añade `sports/morph-webgl-v1` como prototipo opt-in.
Carga `tools/gnm/work/head-morph.glb`, cuyo base es `template + meanDelta` y cuyos
16 targets son deltas PCA geometry-derived con nombres neutrales `gnm-pca-01` a
`gnm-pca-16`. No son controles anatómicos ni componentes PCA semánticos. El
renderer usa WebGL2 sin dependencias, empaqueta los deltas en una textura de 16
capas y cae al SVG GNM si falta WebGL2, el asset es inválido o falla un recurso.
SVG continúa siendo el default, GNM no entra en runtime y se mantienen las
cautelas de licencia y procedencia.
