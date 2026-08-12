# Aceptacion visual del baseline GNM 2D

Este procedimiento genera evidencia visual reproducible para las ocho familias
del renderer `sports/morph-gnm-v1`. La evidencia se escribe fuera del release,
por defecto en `/tmp/sports-face-gnm-acceptance`, y el script no modifica el
runtime, el bundle ni ningun pack generado.

## Camino rapido

Desde la raiz del repositorio:

```bash
python /home/nico/.agents/skills/webapp-testing/scripts/with_server.py \
  --server "python3 -m http.server 8080" --port 8080 -- \
  python3 tools/gnm/capture_acceptance_gallery.py \
  --output-dir /tmp/sports-face-gnm-acceptance
```

Para capturar la variante de diagnostico con landmarks:

```bash
python /home/nico/.agents/skills/webapp-testing/scripts/with_server.py \
  --server "python3 -m http.server 8080" --port 8080 -- \
  python3 tools/gnm/capture_acceptance_gallery.py \
  --landmarks --output-dir /tmp/sports-face-gnm-acceptance-landmarks
```

El script arranca Chromium headless con CDP, carga `index.module.html`, aplica
los inputs FaceDNA fijos y guarda `manifest.json`, `SUMMARY.txt` y un PNG por
familia. Si `montage`/ImageMagick estan disponibles, tambien genera
`gnm-acceptance-gallery.png`; si no, intenta Pillow y finalmente conserva los
PNG individuales como evidencia completa.

## Evidencia y criterios

| Criterio | Comprobacion del manifest |
|---|---|
| Ocho familias | `familyIds` contiene exactamente los ocho IDs semanticos |
| Renderer correcto | Cada entrada usa `sports/morph-gnm-v1` |
| Pack correcto | `source.kind` es `gnm-head-v3` y `gnmDerived` es `true` |
| Seleccion semantica | `semanticFamilySelection` es `true` y el ID coincide con el esperado |
| Expresion fija | `expressionSelected` es `neutral` |
| Canvas valido | `768x768`, PNG y `canvasNonBlank: true` |
| Runtime disponible | No aparece el mensaje de GNM no disponible |
| Browser clean | `browser.errors` esta vacio |

El `manifest.json` incluye los valores completos de FaceDNA, hashes SHA-256 de
cada PNG, los checks de canvas y el debug JSON expuesto por la aplicacion. El
montage es una ayuda para revision humana; el manifest es la autoridad
machine-readable.

## Limitaciones

- La captura requiere una instalacion local de Chromium y un servidor HTTP;
  no se anade Playwright como dependencia de runtime.
- La salida raster puede variar levemente entre versiones de Chromium, aunque
  los inputs, renderer, pack, dimensiones y checks del contrato son fijos.
- Los landmarks y su mapa siguen siendo provisionales; el overlay demuestra
  estabilidad visual, no correccion anatomica.
- La evidencia generada es temporal y no se incluye en `SHA256SUMS.txt` ni en
  `docs/release-manifest-v040.json`. Solo el script y esta documentacion forman
  parte del release.
