# Aceptación de la fase 1

## Estado

| Criterio | Estado | Evidencia |
|---|---|---|
| Misma semilla, mismo perfil | Aprobado | Test determinista |
| Edad no altera identidad | Aprobado | Comparación de `identityBits` |
| Presentación no altera identidad | Aprobado | Test de presentación |
| Assets desacoplados de archivos | Aprobado para MVP | `ASSET_CATALOGS` con IDs lógicos |
| Códigos antiguos siguen funcionando | Aprobado | Migración SF1 → SF2 |
| Variables inactivas se canonicalizan | Aprobado | Tests de calvicie/barba/color |
| Validación masiva | Aprobado | 1.000 perfiles creados, validados y serializados |
| Sin material de OpenTTD | Aprobado para gráficos | Assets Canvas propios; el prototipo sigue GPL por su propósito experimental |

## Puerta de salida

La fase 1 se considera terminada cuando:

```bash
npm test
```

finaliza con:

```text
FaceDNA v2 model tests passed
```

La revisión visual no forma parte de esta fase; se abordará con el renderizador SVG, GNM y el pipeline de assets.
