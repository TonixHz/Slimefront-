# 🚀 GUÍA DE DESPLIEGUE - SLIMEFRONT v0.9

## Opción 1: GitHub Pages (RECOMENDADO - GRATUITO)

### Paso 1: Crear repositorio
```bash
git init
git add .
git commit -m "Initial commit: SLIMEFRONT v0.9"
git branch -M main
git remote add origin https://github.com/tuusername/slimefront.git
git push -u origin main
```

### Paso 2: Configurar GitHub Pages
1. Ir a `Settings` → `Pages`
2. Seleccionar `Deploy from a branch`
3. Elegir rama `main`
4. Guardar

**URL Final**: `https://tuusername.github.io/slimefront/`

**Tiempo**: ~2 minutos
**Costo**: Gratuito

---

## Opción 2: itch.io (RECOMENDADO PARA JUEGOS)

### Paso 1: Crear cuenta y proyecto
1. Ir a [itch.io](https://itch.io)
2. Crear cuenta
3. Ir a dashboard → "Create new project"
4. Llenar formulario:
   - **Nombre**: SLIMEFRONT
   - **Descripción**: Juego de defensa contra olas de zombies slime
   - **Género**: Action, Arcade, Shooter
   - **Clasificación**: Everyone

### Paso 2: Subir archivos
1. En el proyecto, ir a "Edit game"
2. Sección "Uploads"
3. Cambiar a "HTML" como tipo de contenido
4. Click en "Upload files"
5. Subir todos EXCEPTO:
   - `.git/` (carpeta)
   - `.gitignore`
   - `.gitattributes`

### Paso 3: Configurar
- Marcar "This file will be played in the browser"
- En "Embed options": Fullscreen
- Guardar

**URL Final**: `https://tuusername.itch.io/slimefront`

**Tiempo**: ~5 minutos
**Costo**: Gratuito

---

## Opción 3: Servidor Propio

### Requisitos
- Servidor web (Apache, Nginx, Node)
- HTTPS habilitado (audios lo requieren)
- Soporte para HTML5 Canvas

### Pasos
```bash
# 1. Copiar archivos al servidor
scp -r ./* usuario@servidor.com:/var/www/slimefront/

# 2. Configurar CORS (si es necesario)
# .htaccess (Apache):
<IfModule mod_headers.c>
  Header set Access-Control-Allow-Origin "*"
</IfModule>

# 3. Configurar HTTPS
# Recomendado: Let's Encrypt (gratuito)
sudo certbot --apache -d miservidor.com
```

**URL Final**: `https://miservidor.com/slimefront/`

**Tiempo**: ~30 minutos (depende del servidor)
**Costo**: Depende del hosting

---

## Opción 4: Vercel (GRATIS + RÁPIDO)

### Paso 1: Crear proyecto Vercel
```bash
npm install -g vercel
vercel login
vercel --prod
```

**URL Final**: `https://slimefront.vercel.app`

**Tiempo**: ~2 minutos
**Costo**: Gratuito

---

## ✅ Checklist Pre-Despliegue

- [ ] Todos los archivos presentes (ver lista abajo)
- [ ] `index.html` abre sin errores
- [ ] Pantalla de carga funciona
- [ ] Logo/música cargan
- [ ] Juego inicia en Chrome/Firefox
- [ ] Créditos visibles en lobby
- [ ] Favicon aparece en tab
- [ ] No hay errores en consola (F12)

---

## 📋 Archivos Necesarios

```
✅ index.html              (Principal)
✅ style.css               (Estilos)
✅ main.js                 (Game loop)
✅ ui.js                   (Menús)
✅ effects.js              (Audio + efectos)
✅ events.js               (Eventos dinámicos)
✅ world.js                (Mundo + tienda)
✅ player.js               (Jugador)
✅ enemies.js              (Enemigos)
✅ weapons.js              (Armas)
✅ level.js                (XP + Nivel)
✅ progression.js          (Mejoras)
✅ achievements.js         (Logros)
✅ mobile.js               (Móvil)
✅ README.md               (Documentación)
✅ CHANGELOG.md            (Historial)
✅ LICENSE.md              (Atribuciones)

❌ .git/                   (No subir - .gitignore)
❌ Sounds/                 (No necesario - URLs públicas)
❌ .vscode/                (No necesario)
```

---

## 🧪 Test Post-Despliegue

Después de desplegar, verifica:

```javascript
// Abrir consola (F12) y ejecutar:
console.log("Archivos cargados:", {
  audio: typeof SFX !== 'undefined',
  game: typeof game !== 'undefined',
  weapons: typeof WEAPONS_DB !== 'undefined',
  enemies: typeof Enemy !== 'undefined'
});

// Debería mostrar todo true
```

---

## 🆘 Problemas Comunes

### "Error de CORS en audios"
**Solución**: Los audios usan URLs públicas, no debería haber CORS
- Si persiste: Usar proxy CORS (`https://cors-anywhere.herokuapp.com/`)

### "Pantalla negra sin cargar"
**Solución**: 
- Limpiar caché del navegador (Ctrl+Shift+Delete)
- Probar en navegador diferente
- Revisar consola (F12) para errores

### "Audios no se reproducen"
**Solución**:
- Hacer click en página (algunos navegadores lo requieren)
- Revisar volumen del navegador
- Probar en otro navegador

### "FPS muy bajo"
**Solución**:
- Ir a Ajustes → Gráficos → Cambiar a LOW
- Cerrar otras pestañas/apps
- Usar Chrome (mejor rendimiento)

---

## 📊 Estadísticas Esperadas

- **Tamaño HTML**: ~50 KB (sin audios)
- **Tamaño Total**: ~200 KB (con JS/CSS comprimido)
- **Tiempo Carga**: ~2-3 segundos (primera vez)
- **FPS**: 60 en modo PRO
- **Memoria**: ~100-150 MB en pico

---

## 🎯 Recomendación Final

**Para principiantes**: GitHub Pages
**Para comunidad gamer**: itch.io
**Para máximo control**: Servidor propio

Todas las opciones son **completamente gratuitas** excepto servidor propio.

---

**¡Listo para publicar!** 🎮

Fecha: 2026-07-24
Versión: v0.9
