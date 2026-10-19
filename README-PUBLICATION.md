# Publicar SLIMEFRONT sin instalar nada en tu PC

El juego se sirve directamente desde `index.html` y los archivos de `src/` y `assets/`. No hace falta compilarlo, generar `dist/`, instalar Node.js ni usar la terminal para publicarlo en GitHub Pages.

## Publicar o actualizar desde un iPhone

1. Abrí el repositorio: https://github.com/TonixHz/Slimefront-
2. Entrá en **Settings → Pages**.
3. En **Build and deployment**, elegí **Deploy from a branch**.
4. Elegí la rama **main** y la carpeta **/(root)**; guardá los cambios.
5. Esperá a que GitHub Pages termine de publicar. La URL aparece en esa misma pantalla.
6. Para actualizar el juego, editá los archivos desde GitHub en Safari y confirmá los cambios en `main`. Pages volverá a publicarlos automáticamente.

Si Pages ya está configurado, no hace falta repetir la configuración.

## Qué se eliminó de la publicación web

- No hay un paso de `npm install`.
- No hay que ejecutar `npm run build`.
- No hay que generar ni subir una carpeta `dist/`.
- No hace falta Firebase CLI para publicar los archivos estáticos en GitHub Pages.

## Importante sobre Firebase

La integración del juego con Firebase y sus archivos de configuración no se reemplazan por un servidor local. GitHub Pages solo aloja los archivos web; la autenticación y las funciones de nube siguen dependiendo de que el proyecto Firebase existente esté configurado y disponible. Para publicar el juego web no hay que desplegar Firebase de nuevo.

## Antes de compartir públicamente

- Probá el enlace publicado en el dispositivo donde vayas a jugar.
- Revisá los textos y datos de contacto de `legal/`.
- Si el juego muestra un error de Firebase, eso es un problema de configuración/servicio de Firebase, no un requisito de compilación local.
