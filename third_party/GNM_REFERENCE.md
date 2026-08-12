# GNM Head — referencia opcional offline

Sports Face MVP no redistribuye código, modelos ni archivos de datos de GNM.
Solo incluye herramientas propias que pueden invocar una instalación externa.

- Proyecto: GNM Head / google/GNM
- Licencia declarada por el proyecto: Apache License 2.0
- Uso previsto aquí: generación offline de mallas neutrales y datos 2D derivados
- Dependencia en runtime: ninguna

La documentación de GNM describe controles separados para identidad, expresión,
pose y traslación, además de un backend NumPy y datos de modelo incluidos en su
repositorio. Revise siempre la versión y licencia de la instalación concreta.

La fase actual añade únicamente una puerta de intake externa en
`tools/gnm/validate_official_bundle.py`. El ejemplo canónico está en estado
`proposed`, no contiene assets y no autoriza runtime. Ningún bundle oficial fue
aceptado ni redistribuido. La licencia declarada del repositorio no se interpreta
como permiso de redistribución; hace falta una decisión humana explícita con
revisor, fecha y referencia. Consulte
`docs/ACCEPTANCE_GNM_OFFICIAL_BUNDLE.md` antes de incorporar cualquier UV,
textura, ojo, diente o lengua.
