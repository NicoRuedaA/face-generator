# Aceptación del pack GNM canónico

`npm run test:gnm-quality` valida los JSON canónicos de `tools/gnm/work/` sin
necesitar NumPy. Comprueba:

- 200 muestras, 200 miembros de familia y una fuente `gnm-heads-200.npz` coherente;
- los 31 landmarks requeridos, IDs únicos y coordenadas del mapa frente al
  template de la malla cuando `gnm-heads-200.npz` está disponible;
- 14 features finitos, positivos y variables en las 200 muestras;
- 8 familias no vacías cuyos miembros son únicos y cubren exactamente las 200 muestras;
- ausencia de vectores 14D exactamente duplicados;
- distancia euclídea mínima mayor que `0.20` tras normalizar cada feature a `[0, 1]`;
- igualdad byte a byte con los artefactos retenidos `*-200` cuando están presentes.

Si falta el `.npz`, la puerta informa que omite el chequeo ligado a la malla y
continúa validando toda la consistencia JSON. El gate no demuestra la corrección
semántica o anatómica de los landmarks provisionales ni la calidad artística,
visual o perceptual del resultado renderizado.
