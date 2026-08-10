# Migración SF1 → SF2

## Objetivo

Conservar las caras creadas con la versión 0.1 del MVP mientras se introduce la separación entre identidad y apariencia.

## Rasgos preservados literalmente

- cabeza;
- piel;
- ojos;
- cejas;
- nariz;
- boca;
- pelo;
- barba;
- color de pelo;
- gafas;
- pecas;
- visibilidad del pelo;
- cicatriz.

## Rasgos nuevos

Se obtienen de la semilla de manera determinista:

- color de ojos;
- forma de orejas;
- mandíbula;
- proporción facial.

## Datos externos preservados

- semilla;
- edad;
- presentación;
- colores de equipación.

## Comportamiento

1. `parseFaceCode` detecta el prefijo `SF1-`.
2. Verifica el checksum antiguo.
3. Extrae los selectores antiguos.
4. Construye `identityBits` y `appearanceBits`.
5. Aplica reglas de compatibilidad.
6. Devuelve un perfil de versión 2.
7. `formatFaceCode` lo exporta como `SF2~...`.
