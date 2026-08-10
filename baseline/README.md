# Baseline congelado — Sports Face MVP v0.2.1

## Propósito

Este directorio fija el comportamiento de `v0.2.1` antes de integrar Toon Head,
GNM o un nuevo renderizador.

## Contrato reproducible

- `visual-baseline.json`: 100 perfiles con entradas, FaceDNA, código SF2,
  descripción y hashes.
- `legacy-migration-fixtures.json`: 12 códigos SF1 y su resultado SF2 esperado.
- `visual-baseline.csv`: versión tabular.
- `seed-list.txt`: listado compacto de semillas y códigos.
- `verify-baseline.mjs`: prueba automática del contrato.

Verificación:

```bash
npm test
```

## Referencia visual

- `gallery-001-050.png`
- `gallery-051-100.png`
- `gallery-001-050.html`
- `gallery-051-100.html`

Los HTML pueden abrirse con doble clic. Las imágenes son referencias visuales,
no hashes gráficos portables: Canvas puede tener pequeñas diferencias de
antialiasing entre sistemas. El contrato estricto son los datos JSON y SF2.

## Muestras manuales

`user-samples/` conserva las cinco capturas aportadas por el usuario. No son
reproducibles porque sus semillas no se proporcionaron separadamente como texto.
