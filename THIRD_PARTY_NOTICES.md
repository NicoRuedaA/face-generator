# Third-party notices

## OpenTTD

- Project: OpenTTD
- Repository: https://github.com/OpenTTD/OpenTTD
- Relevant reference files:
  - `src/company_manager_face.h`
  - `src/table/company_face.h`
- License: GNU General Public License version 2 (`GPL-2.0-only`)

This temporary MVP is informed by OpenTTD's company-manager face architecture: compact bit fields, ordered visual variables, palette variables and toggles. It does not include OpenTTD's original sprites.

Copyright remains with the respective OpenTTD contributors.


## ToonHead / DiceBear Toon Head

This prototype includes a curated and modified subset of ToonHead vector
components.

- Creator: Johan Melin
- Original work: ToonHead
- License: CC BY 4.0
- Source: https://www.figma.com/community/file/1589627891082866389
- DiceBear style: https://www.dicebear.com/styles/toon-head/
- Modifications: neutral facial mapping, recolouring, sports kit adaptation,
  morphological scaling, original sports hair/beard overlays, age plausibility
  rules and added sports-face details.

See `third_party/toon-head/ATTRIBUTION.md`.


## GNM Head

No se redistribuye GNM en esta entrega. `tools/gnm/` contiene herramientas
propias capaces de trabajar con una instalación externa de google/GNM, cuyo
proyecto declara Apache License 2.0. GNM no es una dependencia de runtime.
El bundle puede incrustar un paquete morfológico portable generado offline a
partir de datos de GNM; ese paquete solo se consume al seleccionar
`sports/morph-gnm-v1` explícitamente.
