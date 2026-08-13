# Aceptación del pack GNM canónico

`npm run test:gnm-quality` valida los JSON canónicos de `tools/gnm/work/` sin
necesitar NumPy. Comprueba:

- 200 muestras, 200 miembros de familia y una fuente `gnm-heads-200.npz` coherente;
- los 31 landmarks requeridos, IDs únicos y coordenadas del mapa frente al
  template de la malla cuando `gnm-heads-200.npz` está disponible;
- 14 features finitos, positivos y variables en las 200 muestras;
- 8 familias no vacías cuyos miembros son únicos y cubren exactamente las 200 muestras;
- ausencia de vectores 14D exactamente duplicados;
- distancia euclídea mínima mayor que `0.20` tras normalizar cada feature a `[0, 1]`;
- igualdad byte a byte con los artefactos retenidos `*-200` cuando están presentes.

Si falta el `.npz`, la puerta informa que omite el chequeo ligado a la malla y
continúa validando toda la consistencia JSON. El gate no demuestra la corrección
semántica o anatómica de los landmarks provisionales ni la calidad artística,
visual o perceptual del resultado renderizado.

## Comparacion de escala

La comparacion report-only de muestras mayores esta separada de esta puerta
canonica de 200 muestras. No redefine sus umbrales ni promueve candidatos:

```bash
npm run test:gnm-quality-scales
npm run compare:gnm-quality-scales
npm run plan:gnm-quality-scales:400
npm run compare:gnm-quality-scales:400
```

`compare_gnm_quality_scales.py` usa solo la biblioteca estandar y calcula para
el candidato y el pack canonico: conteos, vectores duplicados, minimo/mediana y
percentiles de vecinos normalizados, rango/varianza por feature, balance de
familias, deltas de centroides para IDs comunes, procedencia `source`/`seed`/
`sigma` y byte-identidad de dos ejecuciones. Sus umbrales diagnosticos por
defecto son: duplicados `0`, vecino minimo `0.20`, balance minimo `0.50` y
delta maximo de centroides `0.10`. Son senales de comparacion, no una nueva
aceptacion canonica.

La evidencia actual esta en
[`gnm-quality-scale-comparison.json`](gnm-quality-scale-comparison.json): hay
un candidato real de 400 muestras, pero el resultado es `warn` por balance de
familias `22..72` (ratio `0.3055555556`), vecino minimo `0.1899833723` y delta
maximo de centroides `0.123909`. No hubo duplicados exactos; ambas ejecuciones
son byte-identicas. Esto compara calidad estadistica de escala unicamente: no
demuestra anatomia, no modifica runtime/FaceDNA/SF2/assets y requiere revision
humana antes de cualquier promocion.

Si el entorno externo GNM/NumPy no esta disponible, el runner escribe
`status: unavailable` con la razon exacta y no inventa metricas ni datos de
400/800 muestras.

## Phase 7B calibration validation

The separate Phase 7B gate is offline and stdlib-only:

```bash
npm run calibration:gnm-validate-stats
npm run calibration:gnm-test-stats
```

The checked-in report is currently `insufficient_data`: the Phase 7A template
has zero samples, so all sample/diversity and coefficient-stat counts are zero.
No R² or correlation is fabricated. Future mapping review requires at least 40
train, 10 validation, 20 human-approved reviewed samples, 5 distinct seeds and
5 distinct face codes, plus held-out R² >= 0.80 when target outcomes exist,
cross-validation, bilateral consistency, causal one-hot tests, negative
controls, human approval, and versioned mapping metadata. It always keeps
`semanticMapping: unestablished`, `runtimeBasisLoaded: false`, and
`mappingActivation: false`.
