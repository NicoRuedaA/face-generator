# Aceptación de v0.3.1

| Criterio | Estado | Evidencia |
|---|---|---|
| FaceDNA v2 permanece intacto | Aprobado | Baseline de 100 SF2 y 12 migraciones |
| Misma semilla, mismo SVG | Aprobado | Tests deterministas |
| Sin guiños ni ojos cerrados aleatorios | Aprobado | Seis mapeos neutrales y galería de 50 |
| Sin bocas abiertas aleatorias | Aprobado | Siete bocas cerradas/relajadas |
| Canas fuertes en menores de 30 | Corregido visualmente | Test `young-grey` |
| Barba densa en jugadores de 18–20 | Corregido visualmente | Test `young-beard` |
| Gafas alineadas | Aprobado en muestra | Galería de aceptación |
| Pelo largo sin bloque central | Aprobado en muestra | Galería de aceptación |
| Motivos de camiseta dentro de la silueta | Aprobado | `clipPathUnits=userSpaceOnUse` y captura E2E |
| Apertura offline | Aprobado estructuralmente | `index.html` usa bundle clásico sin imports |
| 1.000 perfiles sin errores | Aprobado | `npm test` |

## Decisión

La fase 2.5 queda cerrada para iniciar la fase 3. Las limitaciones restantes son
morfológicas y requieren landmarks, deformación local y datos offline de GNM.
