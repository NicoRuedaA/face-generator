# Fase 1 — auditoría del generador facial de OpenTTD

## Alcance

Esta fase estudia el comportamiento del generador de caras de empresa de OpenTTD para mejorar el MVP temporal. El prototipo continúa bajo GPL-2.0-only y no debe incorporarse directamente al producto final propietario.

Archivos de OpenTTD revisados:

- `src/company_manager_face.h`
- `src/table/company_face.h`
- `src/company_cmd.cpp`
- `src/company_gui.cpp`

## Ideas adoptadas en el MVP

### 1. Estilos etiquetados

OpenTTD no trata una cara como un único esquema universal: mantiene especificaciones de estilo identificadas por una etiqueta. FaceDNA v2 introduce `style: "sports/default-v2"` y un registro `FACE_STYLE_SPECS`.

Beneficio: en el futuro se podrán añadir estilos, catálogos o direcciones artísticas sin reinterpretar silenciosamente los guardados existentes.

### 2. Variables declarativas

Cada rasgo declara:

- tipo (`sprite`, `palette`, `toggle` o `morph`);
- dominio (`identity` o `appearance`);
- posición y longitud en su palabra compacta;
- número de valores válidos;
- dependencias o capas afectadas.

Beneficio: el editor, la validación, la serialización y el render pueden consultar una única especificación.

### 3. Variables activas e inactivas

Los toggles pueden desactivar otros rasgos. FaceDNA v2 elimina de la representación canónica los valores que no tienen efecto visual. Ejemplo: cuando el pelo está oculto, el selector de peinado se limpia. El color de pelo se conserva si todavía existe barba.

Beneficio: dos caras visualmente equivalentes producen un único código canónico y no quedan datos basura en los guardados.

### 4. Paletas desacopladas de las formas

Las paletas se vinculan a grupos de capas. FaceDNA v2 registra, por ejemplo, que `hairColor` afecta pelo, barba y cejas, mientras que `skin` afecta cabeza, orejas, cuello, nariz y boca.

Beneficio: se puede sustituir arte sin multiplicar cada forma por cada color.

### 5. Código facial canónico y migración

OpenTTD enmascara los bits inactivos antes de crear el código facial y conserva compatibilidad con formatos anteriores. El MVP ahora:

- exporta `SF2`;
- valida checksum, estilo, rangos y colores;
- acepta los códigos `SF1` del MVP anterior;
- migra SF1 a FaceDNA v2;
- vuelve a exportar el resultado migrado como SF2.

### 6. Cambio cíclico en el editor

Los selectores pueden avanzar o retroceder con wrap-around. FaceDNA v2 incorpora `changeFeature(profile, key, delta)`.

### 7. Separación entre selección, paleta y dibujado

El orden de capas y los enlaces de paleta están declarados en el estilo, en lugar de quedar implícitos únicamente en el renderizador.

## Mejoras deliberadas respecto al patrón estudiado

### Identidad y apariencia en palabras separadas

La identidad permanente no comparte palabra con peinado, barba, gafas o cicatrices. Esto impide que envejecer o cambiar la presentación regenere accidentalmente la estructura facial.

### Aleatoriedad estable por rasgo

Cada rasgo usa un flujo derivado de `semilla + dominio + clave`. Añadir una variable nueva o reordenar la tabla no cambia automáticamente los rasgos ya existentes.

### IDs lógicos de assets

El FaceDNA selecciona IDs estables como `head/oval` o `hair/fade-01`, no nombres de archivo ni coordenadas de atlas. El gráfico asociado a un ID puede reemplazarse sin modificar el guardado.

### Reglas de compatibilidad explícitas

Las correcciones quedan registradas por identificadores, por ejemplo:

- `hair-cleared-when-hidden`;
- `youth-beard-capped`;
- `inactive-cleared:<rasgo>`.

## Decisiones que no se trasladan al producto final

- No se reutilizarán sprites de OpenTTD.
- No se copiarán tablas, offsets ni identificadores.
- No se incorporará este prototipo GPL al ejecutable comercial.
- La futura implementación deberá partir de una especificación neutral revisada y assets propios.

## Resultado de la fase

- FaceDNA v2 con dos palabras de 32 bits.
- Estilo etiquetado y registrable.
- Código SF2 canónico.
- Migración automática de SF1.
- IDs estables de assets.
- Compatibilidad y validación declarativas.
- Pruebas sobre 1.000 perfiles.
