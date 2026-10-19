# Slimefront Web MVP

Prototipo web limpio de Slimefront. Esta versión se desarrolla en la rama `web-mvp-clean`; la rama `main` conserva el proyecto original.

## Estado

- Juego HTML5 Canvas sin dependencias externas.
- Compatible con navegador de PC y móvil.
- Movimiento con WASD/flechas y joystick táctil.
- Disparo con mouse en PC y botón táctil en móvil.
- Oleadas, tres variantes visuales de enemigo, vida, monedas y bajas.
- Sin login, backend ni Firebase requeridos para jugar.

## Probar

Abrí `index.html` desde la rama `web-mvp-clean` en un hosting estático. No requiere instalación ni compilación.

## Publicar con GitHub Pages

En el repositorio, abrí **Settings → Pages**. Elegí **Deploy from a branch**, seleccioná `web-mvp-clean` y la carpeta `/(root)`, y guardá. GitHub Pages publicará el `index.html` de esta rama. La rama `main` y el proyecto original no se modifican.

## Próximos pasos

1. Probar controles en móvil y PC.
2. Corregir errores y ajustar la dificultad.
3. Verificar rendimiento en el iPhone.
4. Recién después sumar inventario, armas, cajas y jefes.
