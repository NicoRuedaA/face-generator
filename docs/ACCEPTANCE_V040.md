# Criterios de aceptación — v0.4.0

| Criterio | Estado | Evidencia |
|---|---|---|
| Ocho familias morfológicas alcanzables | Aprobado | `tests/morphology.test.mjs` |
| Mapeo GNM semántico y determinista | Aprobado | tabla `face-dna-shape-v1` + pruebas de todas las ramas |
| Landmarks deterministas | Aprobado | 100 fixtures congelados + 1.000 perfiles |
| Edad no altera morfología permanente | Aprobado | prueba de envejecimiento +31 años |
| Pelo y equipación no alteran landmarks | Aprobado | pruebas de apariencia mutable |
| Mandíbula y proporción sí alteran silueta | Aprobado | comparación de paths SVG |
| Deformación local de rasgos | Aprobado | ojos, cejas, nariz, boca, gafas, pelo y barba |
| Mismo SF2 antes y después del render | Aprobado | baseline y muestra de 1.000 perfiles |
| GNM ausente del runtime | Aprobado | importaciones limitadas a `tools/gnm/` |
| Pipeline offline reproducible | Aprobado | `build_runtime_pack.py`: 200 muestras → 8 familias → validación |
| Regeneración operacional sin promoción implícita | Aprobado | candidato separado + `--promote` explícito |
| Bundle y hashes de release actualizables | Aprobado | `npm run build:offline` + `npm run refresh:release` |
| Starter pack identificado como no derivado de GNM | Aprobado | metadatos y documentación |
| Selector de microexpresión solo en Morph Lab | Aprobado | `index.html`, `index.module.html` + `tests/morphology.test.mjs` |
| Funciona mediante `file://` | Aprobado | bundle clásico y captura de la aplicación |

## Resultado de pruebas

```text
FaceDNA v2 model tests passed
Frozen baseline v0.2.1 verified: 100 SF2 + 12 SF1 migration fixtures
Toon polish tests passed: 100 frozen identities + 1,000 generated profiles
Morph Lab tests passed: 8 families, 100 frozen identities + 1,000 generated profiles
Morphology pack valid: 8 families; source=analytic-starter
```

## Limitaciones aceptadas

- Las ocho familias iniciales son analíticas.
- La selección GNM es una regla explícita revisada, no un mapeo aprendido.
- El mapa de vértices GNM aún requiere revisión humana.
- No se realiza warping por vértice de cada path; se usan landmarks, nueva
  silueta y transformaciones locales por región.
- Los assets continúan siendo temporales y derivados de Toon Head bajo CC BY 4.0.

## Flujo de regeneración aceptado

1. Instalar GNM Shape fuera de este proyecto y activar su entorno Python 3.13.
2. Ejecutar `python tools/gnm/build_runtime_pack.py` con los valores
   deterministas documentados.
3. Revisar el mapa provisional, landmarks y candidato bajo `tools/gnm/work/`.
4. Repetir con `--promote` solo después de la validación humana.
5. Ejecutar `npm run build:offline`, `npm test` y
   `npm run refresh:release`.

El navegador/runtime no importa GNM, NumPy ni el entorno de generación. Consume
únicamente el pack JSON portable que el bundle offline haya incrustado.
