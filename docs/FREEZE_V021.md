# Congelación de Sports Face MVP v0.2.1

**Freeze ID:** `sports-face-v0.2.1-2026-08-05`

## Elementos congelados

- Esquema FaceDNA v2.
- Estilo `sports/default-v2`.
- 100 perfiles deterministas.
- Serialización y lectura SF2.
- 12 migraciones SF1 → SF2.
- Catálogos lógicos de assets.
- Renderer Canvas actual como referencia.
- Cinco capturas manuales suministradas por el usuario.

## Regla para fases posteriores

Un nuevo renderizador puede cambiar el aspecto, pero no debe modificar
silenciosamente `identityBits`, `appearanceBits` ni los códigos SF2 existentes.
Un cambio intencional del contrato requiere nueva versión y migración explícita.

## Verificación

```bash
npm test
npm run test:baseline
```
