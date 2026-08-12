# Aceptación de landmarks GNM de la fase 1

## Resultado

**PASS with WARN** para el baseline provisional actual.

`provisionalReview: required` es un estado explícito del reporte. Esta mejora de
la puerta solo amplía la evidencia y la trazabilidad; no corrige IDs, no cambia
artefactos y no promociona el mapa. `anatomicalCorrectness: not_proven` permanece
intencionalmente aunque las comprobaciones geométricas sean PASS.

La auditoría reproducible se ejecuta desde la raíz del repositorio:

```bash
npm run test:gnm-landmarks
```

El comando emite JSON en stdout y un resumen humano en stderr. No necesita que
GNM esté instalado. Las comprobaciones JSON siempre se ejecutan; las
comprobaciones de malla usan NumPy únicamente cuando está disponible
`tools/gnm/work/gnm-heads-200.npz`.

## Evidencia

| Comprobación | Resultado | Evidencia |
|---|---|---|
| IDs únicos y en rango | PASS | 31 IDs únicos en `0..17820` |
| Coordenadas frente al template | PASS | Error máximo `4.94e-9` con la malla retenida |
| Orientación bilateral | PASS | 13 pares, 200 mallas, sin inversiones |
| Bounds de proyección | WARN | 155/200 muestras exceden el frame fijo |
| Detalle de excursiones | WARN | 506 excursiones; `77.5%` de muestras; peor caso `gnm-0002/chin`, eje `y`, valor `721.3187`, `65.3187px` fuera por abajo |
| Asimetría vertical | PASS with WARN context | Máximos: orejas `3.3137px`, sienes `2.8333px`, nariz `2.6340px`, mejillas `2.6052px`, hairline `2.5474px` |
| Consistencia de artefactos | PASS | Canonical y retenido `*-200` consistentes cuando están presentes |
| Consistencia de nombres de fuente | WARN | El mapa declara `heads-test.npz`; la ruta esperada y los artefactos proyectados declaran `gnm-heads-200.npz`; la identidad de contenido de landmarks retenidos se comprobó y es `true` |
| Extremos de malla cruda | PASS con NumPy / WARN sin NumPy | Con NumPy reporta `x=-0.1481532753..0.1482581943`, `y=0.0405613743..0.4244092107`, `z=-0.1194735840..0.1595336944`; sin NumPy informa la limitación y no fabrica valores |
| Overlays Chromium | PASS | 8 muestras renderizadas sin errores; evidencia temporal en `/tmp/opencode/gnm-audit/` |

## Warnings aceptados

El frame de proyección se fija con la normalización del template para conservar
variación morfológica entre identidades. Por eso los bounds nominales
`x=160..608`, `y=96..656` avisan sobre todo en top, chin y ears cuando una
identidad se extiende más allá del template. Este warning no es, por sí solo,
evidencia de que los IDs sean incorrectos.

Las asimetrías pequeñas son medibles en la malla y en la proyección. Se
conservan como datos de revisión, no como un criterio de inversión bilateral.

El drift de nombre de archivo es un warning de procedencia, no un fallo de
integridad en este baseline: `gnm-landmarks.json` y `gnm-landmarks-200.json` son
idénticos byte a byte. El reporte conserva las rutas esperada y declarada y
expone si se comprobó la identidad de contenido.

## Caveat anatómico

**La consistencia geométrica no demuestra la semántica anatómica.** Que un ID
sea único, esté dentro del rango, coincida con el template, mantenga la
orientación bilateral y produzca overlays estables no prueba que el vértice
corresponda anatómicamente al nombre del landmark. El mapa sigue siendo
provisional y requiere revisión humana contra la malla frontal.

Esta fase mejora la evidencia solamente. No corrige los IDs actuales ni prueba
que ningún landmark sea anatómicamente correcto.

## Revisión pendiente

- Confirmar visualmente `top`, `chin` y `ears` contra la malla frontal.
- Decidir si el policy de bounds debe seguir siendo el frame estable del template.
- Revisar las asimetrías de orejas, sienes, nariz, mejillas y hairline sin
  reinterpretarlas automáticamente como errores de ID.
- Regenerar y volver a ejecutar la auditoría tras cualquier cambio del mapa.

No se incluyen screenshots permanentes en esta fase: el CLI y la evidencia
JSON son deterministas, y la generación Chromium existente puede reproducirse
en el entorno de auditoría sin añadir binarios al release.
