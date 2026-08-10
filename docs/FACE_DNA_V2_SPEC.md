# FaceDNA v2 — especificación del prototipo

## Perfil

```json
{
  "version": 2,
  "style": "sports/default-v2",
  "seed": 123456789,
  "identityBits": 0,
  "appearanceBits": 0,
  "age": 24,
  "presentation": "neutral",
  "kit": {
    "primary": "#166534",
    "secondary": "#f8fafc"
  }
}
```

## Dominios

### Identidad permanente

- cabeza;
- piel;
- ojos;
- cejas;
- nariz;
- boca;
- pecas;
- color de ojos;
- orejas;
- mandíbula;
- proporción facial.

La edad y la presentación no pueden modificar `identityBits`.

### Apariencia mutable

- peinado;
- barba;
- color de pelo;
- pelo visible;
- gafas;
- cicatriz.

## Código de texto

Formato:

```text
SF2~<style>~<identity36>~<appearance36>~<seed36>~<age36>~<presentation>~<primary>~<secondary>~<checksum>
```

El código se genera desde un perfil canónico:

- valores inválidos se normalizan;
- campos inactivos se ponen a cero;
- el checksum cubre todos los campos anteriores;
- el estilo debe existir en el registro.

## Compatibilidad

El lector acepta:

- `SF2`: lectura directa;
- `SF1`: migración al estilo `sports/default-v2`.

Los campos nuevos de SF2 que no existen en SF1 se generan de forma determinista desde la semilla.

## Estabilidad de assets

Los enteros compactos se traducen a IDs lógicos mediante catálogos congelados. Un ID puede recibir arte nuevo sin alterar el FaceDNA. Reordenar el catálogo sí sería un cambio incompatible y requiere nueva versión o migración.

## Reglas actuales

- pelo oculto ⇒ peinado cero;
- pelo oculto + sin barba ⇒ color de pelo inactivo y cero;
- pelo oculto + barba ⇒ el color sigue activo;
- menor de 18 años ⇒ barba limitada a las variantes juveniles del MVP;
- edad válida: 16–60.
