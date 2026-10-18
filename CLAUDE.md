# Códice — contexto del proyecto

Códice es un agente de programación **open source** para la terminal, inspirado en Claude Code,
pensado para funcionar con **modelos locales** (Ollama, LM Studio, llama.cpp, vLLM, Jan) y con
cualquier API compatible con OpenAI (OpenRouter, OpenAI, etc.).

Autor: Imanol. Carpeta: `C:\ProyectosIA_Imanol\Codice`. Comando: `codice`. Paquete npm: `codice-cli`
(`codice` está ocupado). Nombre elegido por el usuario entre Tequio Code, Milpa Code, Nido Code y Códice.

## Estado actual

- **Fase 0 — Diseño (hecho, pendiente de aprobación):** estilo de la terminal diseñado en Figma (ver sección
  "Diseño de la terminal"). No escribir código de la app hasta que el usuario apruebe el diseño.
- La estructura de carpetas (`bin/`, `src/llm`, `src/tools`, `src/util`, `test/`, `examples/`) ya existe, vacía.

## Objetivo (paridad con Claude Code)

1. **Modelos locales intercambiables**: proveedor y modelo configurables (`/model`, `/provider`, `--model`).
   - Ollama vía su API nativa (`/api/chat`) para poder fijar `num_ctx`.
   - Resto vía API compatible con OpenAI (`/v1/chat/completions`, streaming SSE).
   - Modo de herramientas `auto | native | prompt`: si el modelo no soporta *tool calling* nativo,
     las herramientas se describen en el prompt y el modelo responde con bloques `<tool_call>{json}</tool_call>`.
   - Soporte de modelos con razonamiento (`<think>…</think>`, `reasoning_content`), mostrado atenuado.
2. **Herramientas**: Read, Write, Edit, Bash (Git Bash o PowerShell en Windows), Glob, Grep, LS,
   WebFetch, TodoWrite, Task (subagentes) y Skill.
3. **Permisos**: modos `default`, `acceptEdits`, `plan` (solo lectura), `bypass` (`--yolo`);
   reglas `allow`/`deny` estilo `Bash(npm test:*)`; Shift+Tab cambia de modo.
4. **Skills**: carpetas con `SKILL.md` (frontmatter `name`, `description`), cargadas bajo demanda.
5. **Agentes y subagentes**: definiciones en `.md` con frontmatter (`name`, `description`, `tools`, `model`).
   Integrados: `general-purpose`, `explore`, `plan`.
6. **Comandos de consola**: slash commands integrados (`/help`, `/model`, `/models`, `/mode`, `/mcp`,
   `/plugin`, `/skills`, `/agents`, `/compact`, `/resume`, `/init`, `/memory`, `/cost`, `/doctor`…)
   y comandos personalizados en `.md` con `$ARGUMENTS`.
   Atajos: `!` ejecuta shell, `#` guarda en memoria, `@archivo` adjunta un archivo, Esc interrumpe.
7. **MCP**: cliente propio (stdio y HTTP), herramientas expuestas como `mcp__servidor__herramienta`.
   Config en `settings.json` (`mcpServers`) y `.mcp.json` del proyecto.
8. **Plugins**: carpeta con `plugin.json` que agrupa `skills/`, `agents/`, `commands/`, `hooks/hooks.json`
   y `.mcp.json`. Instalación desde ruta local o git (`/plugin install`). Compatible con
   `.claude-plugin/plugin.json` y marketplaces (`plugin@repo`).
9. **Hooks**: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart` (código de salida 2 bloquea).
10. **Memoria**: `CODICE.md` (usuario y proyecto); también lee `CLAUDE.md` y `AGENTS.md` por compatibilidad.
11. **Sesiones**: guardadas en `~/.codice/sessions`; `--continue`, `--resume`, `/resume`; `/compact` y autocompactado.
12. **Modo no interactivo**: `codice -p "prompt"` (admite entrada por tubería).

13. **Agentes expertos incluidos** (como Claude Code): `general-purpose`, `explore`, `plan`, `code-reviewer`,
    `debugger`, `test-writer`, `refactorer`, `security-auditor`, `docs-writer`, `frontend`. Son `.md` en `agents/`
    del repo; el usuario los puede sobrescribir.
14. **Crear agentes y subagentes**: `/agents` (listar, ver, crear, editar, borrar). `/agents new` tiene asistente:
    el usuario describe el agente y el modelo genera nombre, descripción, herramientas y prompt; se guarda en
    `~/.codice/agents/` (usuario) o `.codice/agents/` (proyecto). Cada agente puede fijar su propio `model`/`provider`.
15. Herramientas extra de Claude Code: `AskUser` (preguntas con opciones), `ExitPlanMode` (salir del modo plan
    tras aprobar el plan), Task en paralelo (varios subagentes a la vez).

## Conexión: local y por API (requisito del usuario)

Dos formas de usar modelos, combinables:
1. **Local**: Ollama, LM Studio, llama.cpp, vLLM, Jan en la misma máquina.
2. **Por API**: cualquier servicio en la nube compatible con OpenAI (OpenRouter, OpenAI, Groq, DeepSeek,
   Anthropic y Gemini vía su endpoint compatible) **o una PC propia remota**.

Caso de uso clave: el usuario tiene una PC potente en casa y trabaja desde su laptop.
- En la PC: `codice serve` levanta un proxy HTTP con token (Bearer) que expone los modelos locales de esa PC
  (Ollama y/o un backend OpenAI-compatible). Muestra las IPs y el comando exacto para conectar. Opcional TLS
  (`--cert/--key`). Recomendar Tailscale/ZeroTier para usarlo fuera de casa (no abrir puertos).
- En la laptop: `codice connect http://IP:8787 --token XXX --name pc-casa` agrega el proveedor y lo prueba.
- Las herramientas (leer/editar archivos, bash) siempre corren en la laptop; solo la inferencia va a la PC.
- **Cadena de respaldo** (`fallback`): si la PC no responde, usar otro proveedor/modelo (p. ej. uno local pequeño).

## Funciones extra que Claude Code no tiene

- Cualquier modelo: local, nube o PC remota; cambio en caliente con `/model` y `/provider`.
- `codice serve` / `codice connect` (inferencia en tu propia PC desde otra máquina).
- Cadena de respaldo de proveedores y modelo por agente (p. ej. `explore` con un modelo pequeño y rápido).
- Modo de herramientas por prompt para modelos sin *tool calling* nativo, detectado automáticamente.
- `/bench`: mide tokens/s, latencia y soporte de herramientas de cada modelo disponible.
- `--offline`: bloquea toda herramienta de red (privacidad total).
- Modo ligero para modelos con poco contexto: descripciones de herramientas cortas y autocompactado agresivo.
- Temas, mascotas, mascotas propias, interfaz en español y accesibilidad (ver secciones de diseño).
- Estadísticas locales: tokens/s y tokens procesados sin costo de nube (`/cost`).

## Ideas para después (NO en este proyecto)

- **PC como servidor tipo RunPod**: siguiente proyecto del usuario. Usar su PC como servidor de cómputo
  remoto (GPU bajo demanda, contenedores, varias cargas), al estilo RunPod. `codice serve` es un primer paso
  pero el proyecto completo será aparte.

## Decisiones técnicas

- Node.js ≥ 18 (instalado: v22), ES Modules, **cero dependencias externas** (fetch, readline y child_process nativos).
- Sin Python en la máquina: no usar herramientas que lo requieran.
- Configuración: `~/.codice/settings.json` (usuario), `.codice/settings.json` y `.codice/settings.local.json` (proyecto).
  Directorios de recursos: `~/.codice/{skills,agents,commands,plugins}` y `.codice/…` del proyecto;
  opción `compat.claude` para leer también `~/.claude/…` y `.claude/…`.
- Instalación local: `npm link` dentro de la carpeta para tener el comando `codice` global.
- Pruebas: servidor falso compatible con OpenAI y un servidor MCP de eco en `test/`, sin necesitar un modelo real.

## Diseño de la terminal (Fase 0)

Figma: https://www.figma.com/design/FS6gxZ6zIA9jbdAzTrg3Xa — página "Terminal":
tableros *Fundamentos*, *Componentes*, *Temas*, *Mascotas incluidas*, *Accesibilidad (HCI)* y 10 pantallas
(inicio, conversación con herramientas y diff, permisos, paleta de comandos, tareas/subagentes/skills/MCP,
modelos/modo plan/errores, `codice -p`, `/theme`, `/config`, `/mascot`).

**Fuente de verdad de colores: `design/themes.json`** (exportado de Figma, ya validado en contraste).
**Datos de las mascotas: `design/mascots.json`.** No copiar valores a mano: el código carga esos archivos.

Uso de cada token:

| Token | Uso |
|---|---|
| bg/base | fondo (no se pinta en la terminal real; sirve para validar contraste) |
| bg/surface | cajas: prompt, diálogos, menús |
| bg/elevated | fila seleccionada |
| border/default | bordes de cajas |
| text/primary | texto principal |
| text/muted | argumentos, ayudas |
| text/dim | resultados, pensamiento |
| accent/primary | marca, `›`, comandos, foco |
| accent/soft | modelo activo, "Pensando…" |
| status/success | `●` ok, ✓, líneas `+` |
| status/error | `✗` error, líneas `-` |
| status/warning | `○` pendiente, ⚠ permisos, avisos |
| status/info | rutas, identificadores, MCP ◆ |
| status/agent | subagentes ↳, skills, modo plan |
| diff/add-bg, diff/del-bg | fondo de líneas del diff y de la caja de error |

Reglas visuales:
- Mensaje del usuario: `› ` en color de acento + texto. Pensamiento: `✻ <verbo de la mascota>… ` en cursiva atenuada.
- Herramienta: `● Nombre(args)` (`●` ok / `○` pendiente / `✗` error, nombre en negrita, args en muted) y debajo
  `  └ resultado` en dim. Pasos de subagente: `↳ agente  Herramienta(args)` en violeta.
- Ediciones: diff con número de línea, `+`/`-` y fondo verde/rojo.
- Permisos: caja con borde ámbar, vista previa (`$ comando`) y opciones `1. Sí` / `2. Sí, y no volver a
  preguntar por Regla(…)` / `3. No (esc)`, la seleccionada con `› ` y fondo elevated.
- Paleta de comandos bajo el prompt: comando, descripción y origen (integrado · plugin · skill).
- Barra de estado bajo el prompt: modo a la izquierda (`⏵⏵ modo: …`, `‖ modo plan` en violeta),
  modelo · proveedor · % de contexto · MCP a la derecha.
- Usar solo glifos de ancho fijo: nada de `⎿`, `⚙`, `⏸` ni emoji (desalinean la grilla).
- Banner "CÓDICE" en bloques `█` (con tilde `▄█▀` sobre la O) en color de acento, con la mascota del tema a la derecha.

### Temas y personalización

- Los tokens `accent/ember` y `accent/ember-soft` se renombraron a `accent/primary` y `accent/soft`.
- 6 temas integrados (modos de la colección): **Brasa (oscuro, predeterminado)**, Alba (claro), Medianoche,
  Daltónico (verde/rojo → azul/naranja), Alto contraste y Fósforo (retro CRT). Valores en Figma.
- `/theme`: lista con vista previa en vivo del tema resaltado; "Personalizado…" edita tokens.
- `/config`: panel interactivo (tema, mascota, verbos del spinner, estilo de salida
  normal/conciso/explicativo/aprendizaje, mostrar pensamiento, barra de estado, permisos, notificaciones,
  idioma, autocompactado) con ámbito usuario/proyecto.
- `settings.json`: `theme`, `customThemes` (heredan de `base` y sobrescriben tokens), `mascot {name, animated}`,
  `spinnerVerbs`, `outputStyle`, `statusLine {command}`.
- Si la terminal no soporta truecolor, se usa la paleta ANSI de 256 o 16 colores más cercana.

### Mascotas (todas incluidas)

Decisión del usuario: el producto se llama **Códice** (nombre propio, al estilo "Claude Code"/"OpenCode") y las
4 mascotas vienen incluidas como compañeras. Pixel art en componentes `Mascota/*`; en la terminal se
dibujan con medios bloques `▀▄` (2 píxeles verticales por carácter). Cada una trae verbos de spinner propios.

| Mascota | Tema por defecto (modo `auto`) | Verbos |
|---|---|---|
| Chispa (llama) | Brasa | Encendiendo…, Chisporroteando… |
| Ajolote | Alba | Regenerando…, Burbujeando… |
| Nahual (jaguar) | Medianoche | Transformándose…, Invocando… |
| Xolo (xoloitzcuintle) | Fósforo y el resto | Olfateando…, Excavando… |

- `/mascot`: galería; `auto` (según tema), fijar una, `ninguna`, o crear una propia.
- Mascota propia: `~/.codice/mascots/<id>/mascot.json` con `name`, `palette`, `pixels` (filas de caracteres,
  `.` = transparente), `eyes` y `mouth` (qué caracteres son ojos/boca), `verbs` y `themes` opcional; o
  `/mascot import imagen.png` (se reduce a ≤ 24×24; decodificar PNG con `zlib` nativo).
- Estados generados automáticamente a partir de ojos/boca: reposo (parpadeo ~4 s), pensando (ojos entrecerrados),
  éxito (un salto + ✓), error (ojos en X + ✗). Siempre acompañados de texto.

## Accesibilidad (HCI) — requisito obligatorio

Tablero "Accesibilidad (HCI)" en Figma. Reglas que el código debe cumplir:
- Contraste: todo texto ≥ 4.5:1 sobre `bg/base`, `bg/surface`, `bg/elevated` y fondos del diff; tema Alto contraste
  ≥ 7:1; bordes ≥ 3:1. Los tokens de los 6 temas ya se ajustaron así (valores definitivos en Figma, no en este
  archivo). Los temas personalizados se validan al cargar y se avisa si algún token baja de 4.5:1.
- Nunca solo color: herramienta `●` ok / `○` pendiente / `✗` error; diff con `+`/`−`; `⚠` y `✗` con palabra;
  selección = `›` + negrita + fondo.
- `reduceMotion` (o `REDUCE_MOTION`): mascota y spinner estáticos; nada parpadea más de 3 veces por segundo.
- Solo teclado; esc siempre cancela; números 1–9 en menús; los diálogos de permiso no caducan; ctrl+o expande resultados.
- `NO_COLOR`, `TERM=dumb`, degradado truecolor → 256 → 16 colores; detectar fondo claro/oscuro; no tocar el tamaño de fuente.
- Modo lector de pantalla (`--screen-reader` / `accessibility.screenReader`): sin dibujos de caja, sin ASCII art ni
  mascota, sin reescribir líneas con `\r`; cada evento es una frase completa
  ("Herramienta Edit, correcta: src/auth.ts, 1 cambio…").
- Errores: qué pasó + causa + acción sugerida con el comando exacto.
- Las 10 heurísticas de Nielsen aplicadas (ver tablero), incluido `/rewind` para deshacer ediciones.

## Convenciones

- Interfaz y mensajes al usuario en **español**; prompt de sistema del agente en inglés
  (los modelos locales lo siguen mejor) con la orden de responder en el idioma del usuario.
- Comentarios de código breves y en español.
- El estilo visual de la terminal (colores, símbolos, banner, bloques de herramientas, diálogos de permisos)
  debe seguir el diseño aprobado en Figma.

## Plan por fases

0. Diseño en Figma: pantallas, temas, mascotas, accesibilidad, nombre. ← **hecho, esperando aprobación**
1. Núcleo: config, motor de temas (carga `design/themes.json`, degradado de colores, NO_COLOR), clientes LLM
   (Ollama + OpenAI), bucle del agente, herramientas básicas, REPL con el estilo del diseño.
2. Permisos, hooks, sesiones, compactado, `/rewind`.
3. Skills, agentes/subagentes, comandos personalizados.
4. MCP y plugins.
5. Personalización: `/theme`, `/config`, `/mascot` (render con medios bloques, estados, mascotas propias, PNG).
6. Accesibilidad: modo lector de pantalla, `reduceMotion`, validación de contraste de temas propios.
7. Pruebas, README, ejemplos (`examples/plugin-ejemplo`) y `npm link`.

## Flujo de trabajo con git (pedido por el usuario)

Repo: https://github.com/1mano1/codise-cli

- `main`: estable, solo recibe merges desde `dev`.
- `dev`: integración. Todo entra por **pull request** y se fusiona ahí.
- Una rama por tema desde `dev`, con nombre en inglés: `feat/core`, `feat/terminal-ui`, `feat/llm-providers`,
  `feat/tools`, `feat/agent-loop`, `feat/permissions-hooks-sessions`, `feat/extensions` (skills, agents,
  commands, plugins, MCP), `feat/remote-serve`, `feat/customization`, `feat/accessibility`, `test/suite`, `docs/readme`.
- **Commits y PR en inglés**, cortos, profesionales y al punto (Conventional Commits: `feat:`, `fix:`, `docs:`,
  `test:`, `refactor:`, `chore:`). Nada de explicaciones largas ni tono de tutorial.
- **Sin rastro de IA**: no agregar `Co-Authored-By` de Claude ni "Generated with Claude Code" en commits ni PR.
- PR → `dev` con resumen breve y cómo se probó; se fusiona y se borra la rama.
