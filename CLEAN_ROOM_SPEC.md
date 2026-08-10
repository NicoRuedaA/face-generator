# Especificación funcional neutral para la reimplementación final

Este documento describe el comportamiento observable que debe conservar una futura implementación independiente. No prescribe lenguaje, algoritmos internos, offsets de bits ni estructura de clases.

## Objetivo

Generar retratos 2D reproducibles de jugadores ficticios, adecuados para interfaces de gestión deportiva, sin almacenar una imagen por jugador.

## Entrada mínima

Un perfil debe contener:

- versión del formato;
- identificador o semilla estable;
- identidad facial inmutable;
- edad actual;
- presentación visual;
- colores de equipación.

La identidad debe representar, como mínimo:

- forma de cabeza;
- tono de piel;
- ojos;
- cejas;
- nariz;
- boca;
- peinado;
- color de pelo;
- barba o vello facial;
- accesorios opcionales y marcas faciales.

La representación final puede ser un bitfield, bytes, JSON compacto u otro formato. No tiene que conservar los offsets ni el código del MVP.

## Salida

- Retrato cuadrado de referencia: 512 × 512 píxeles.
- Fondo, cuello, equipación y cabeza en capas separables.
- Resultado rasterizable a PNG o WebP.
- Misma versión + misma identidad + misma edad = mismos píxeles, salvo cambios expresamente versionados.

## Reglas funcionales

1. La generación inicial debe ser determinista.
2. Cambiar la edad no puede alterar la estructura facial permanente.
3. El envejecimiento puede modificar arrugas, canas, entradas y densidad de barba.
4. Las variables opcionales deben poder activarse y desactivarse.
5. Los colores deben estar desacoplados de la geometría de los assets.
6. Las combinaciones deben pasar por reglas de compatibilidad.
7. El perfil debe poder exportarse como un código de texto y reconstruirse sin pérdida.
8. El render debe ser suficientemente barato para generarse al crear un jugador y guardarse en caché.

## Controles necesarios para el prototipo final

- nueva identidad;
- aplicar semilla;
- cambiar edad;
- editar cada categoría visual;
- cambiar equipación;
- importar/exportar identidad;
- exportar retrato;
- mostrar una galería de identidades para evaluar diversidad.

## Pruebas de aceptación

- 1.000 identidades distintas no producen errores de render.
- Una identidad exportada e importada mantiene todos sus atributos.
- Generar dos veces la misma identidad produce el mismo hash de imagen.
- Envejecer cinco años mantiene cabeza, ojos, nariz y boca.
- Desactivar el pelo elimina todas sus capas dependientes.
- No aparecen valores fuera del catálogo de assets.
- El render de una identidad individual cumple el presupuesto de rendimiento definido por el motor del juego.

## Separación recomendada

Para una reimplementación independiente sólida, el equipo que escriba el código final debería recibir únicamente este documento, ejemplos de entradas/salidas y requisitos visuales. No debería consultar el código de OpenTTD ni el código fuente de este MVP. Esta recomendación es organizativa y no sustituye asesoramiento jurídico.
