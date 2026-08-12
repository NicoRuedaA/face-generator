# Aceptación A/B GNM SVG/WebGL2

Esta aceptación aporta evidencia visual bounded y reproducible para el commit
actual de WebGL2. El mismo conjunto fijo de perfiles FaceDNA se captura dos veces:
`sports/morph-gnm-v1` como referencia SVG y `sports/morph-webgl-v1` como candidato
WebGL2 opt-in geometry-only.

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

## Lectura correcta

El HTML es una ayuda de revisión humana; `comparison.json` es la autoridad
machine-readable. La comparación es cualitativa/diagnóstica, no pixel-equivalent:
SVG y WebGL tienen sombreado y proyección diferentes. WebGL sigue siendo
geometry-only, sin UVs, texturas, ojos, dientes, lengua ni animación. Los IDs
PCA `gnm-pca-01` ... `gnm-pca-16` son neutrales y no controles semánticos.

La captura no forma parte de `npm test`, porque requiere Chromium y Playwright.
La validación sí es independiente y usa solo Python stdlib.
