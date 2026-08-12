# Aceptación A/B GNM SVG/WebGL2

Esta aceptación aporta evidencia visual bounded y reproducible para el commit
actual de WebGL2. El mismo conjunto fijo de perfiles FaceDNA se captura dos veces:
`sports/morph-gnm-v1` como referencia SVG y `sports/morph-webgl-v1` como candidato
WebGL2 opt-in geometry-only. La fase también hace cumplir el contrato permanente:
los pesos de geometría dependen solo de `identityBits` y de sus valores de
identidad, no de apariencia, edad, presentación, equipación, expresión ni de
`seed` cuando los bits de identidad son iguales.

## Camino rápido

Desde la raíz del repositorio:

```bash
npm run capture:gnm-webgl-ab
npm run validate:gnm-webgl-ab
```

El primer comando ejecuta Playwright mediante `with_server.py` y genera la
evidencia canónica en `docs/gnm-webgl-ab/`. Puede apuntarse a otra instancia con
`--url` o `--port` si se ejecuta el script directamente:

```bash
python3 tools/gnm/capture_webgl_ab.py --url http://127.0.0.1:8080/index.module.html --output-dir /tmp/gnm-webgl-ab
python3 tools/gnm/validate_webgl_ab.py /tmp/gnm-webgl-ab/comparison.json
```

La inspección interactiva no forma parte de la captura canónica: la vista inicial
permanece frontal y determinista. En la interfaz WebGL2, una persona puede
arrastrar el canvas para orbitar, usar la rueda para zoom y pulsar
`Restablecer cámara`. Los valores están acotados, usan pointer capture y no
afectan FaceDNA, SF2, pesos morph ni la carga de assets.

## Contrato fijo

| Campo | Valor |
|---|---|
| Casos | 8, en orden estable |
| Semillas | `0`, `1`, `42`, `12345`, `424242`, `8675309`, `2147483647`, `4294967295` |
| Edad | `22` |
| Presentación | `neutral` |
| Microexpresión | `neutral` |
| Equipación | `#b91c1c` / `#f8fafc` |
| Viewport | `1024x1024`, device scale factor `1` |
| Captura SVG | Siempre debe ser `rendered` y visible |
| Captura WebGL2 | `rendered`, `fallback` o `unavailable` |

El manifest exige los ocho IDs y códigos FaceDNA estables, ambos renderers
intentados, ausencia de errores de consola/page, y un PNG para cada captura
disponible. `fallback` significa que el runtime mostró el SVG GNM después del
intento WebGL; `unavailable` cubre la imposibilidad bounded de capturar WebGL2.
Ninguno se convierte en un PASS de WebGL.

## Hallazgos de calidad medidos

La evidencia previa del commit `194d18a` fue inspeccionada con un decodificador
PNG de la biblioteca estándar. Las 8 capturas WebGL eran `351x351`, con una
ocupación de máscara de color de `34.43%` a `36.67%`, márgenes verticales de
`16` a `21` píxeles, fondo plano dominante `#0f141c` (`62.99%` a `65.03%`) y
`645` a `672` colores únicos. Su coeficiente de variación de luminancia fue
`0.17` en los ocho casos, frente a `0.32` a `0.61` en la referencia SVG. Esto
evidencia encuadre compacto pero plano, no un defecto anatómico.

Tras el cambio, las ocho capturas siguen siendo `351x351`, pero la máscara
stdlib con tolerancia 24 queda en `19.88%` a `21.04%`, con bounding boxes en el
rango global `x=85..265`, `y=56..295`. Frente a la medición anterior
`34.76%` a `36.80%` y `x=56..294`, `y=17..334`, esto documenta un encuadre más
conservador y márgenes estables; no es una medida de calidad anatómica.

Esta fase endurece solo `sports/morph-webgl-v1`: el projection box incluye los
bounds base y una cota conservadora de desplazamiento de los 16 targets bajo
los pesos permitidos; el viewport y el depth test quedan diagnosticados; no se
activa culling porque la malla retenida tiene winding mixto; y el GLSL usa
ambiente, key light, fill light y rim suave. La captura añade dimensiones,
ocupación, bounding box, estado `readPixels`, errores GL y diagnósticos del draw.
El PNG parser acepta únicamente PNG 8-bit no entrelazado RGB/RGBA y la máscara
solo distingue píxeles del color RGB dominante de fondo con tolerancia fija de
24 niveles: es un
indicador de salud/framing, no segmentación ni validación semántica.

La regeneración mantiene exactamente las ocho semillas y el contrato de entrada.
El resultado actual se debe leer en `docs/gnm-webgl-ab/comparison.json`:
`statusDistribution` es la autoridad de disponibilidad, y cualquier
`fallback`/`unavailable` sigue siendo evidencia no renderizada. Cuando el
canvas mantiene el back buffer disponible, `readPixels` aporta una segunda
medición; Chromium puede devolver una sonda vacía después del intercambio, en
cuyo caso el parser PNG queda como medición de imagen y el manifest conserva
`readPixels-empty` sin convertirlo en éxito. Esta fase no
promueve WebGL a producción ni añade texturas, UVs, ojos, dientes, lengua,
animación o controles anatómicos.

## Lectura correcta

El HTML es una ayuda de revisión humana; `comparison.json` es la autoridad
machine-readable. La comparación es cualitativa/diagnóstica, no pixel-equivalent:
SVG y WebGL tienen sombreado y proyección diferentes. WebGL sigue siendo
geometry-only, sin UVs, texturas, ojos, dientes, lengua ni animación. Los IDs
PCA `gnm-pca-01` ... `gnm-pca-16` son neutrales y no controles semánticos.

La captura no forma parte de `npm test`, porque requiere Chromium y Playwright.
La validación sí es independiente y usa solo Python stdlib. Los 16 targets PCA
siguen siendo direcciones neutrales derivadas de geometría, no controles
anatómicos semánticos.
