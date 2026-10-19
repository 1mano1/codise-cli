# Códice — contexto del proyecto

Códice es un agente de programación **open source** para la terminal, inspirado en Claude Code,
pensado para funcionar con **modelos locales** (Ollama, LM Studio, llama.cpp, vLLM, Jan) y con
cualquier API compatible con OpenAI (OpenRouter, OpenAI, etc.).

Autor: Imanol. Carpeta: `C:\ProyectosIA_Imanol\Codice`. Comando: `codice`. Paquete npm: `codice-cli`
(`codice` está ocupado). Nombre elegido por el usuario entre Tequio Code, Milpa Code, Nido Code y Códice.

## Estado actual

- **v0.1.0 implementada**: todas las fases del plan están en `dev` (núcleo, UI, proveedores, herramientas, agente,
  permisos/hooks/sesiones, extensiones, remoto, personalización, accesibilidad, pruebas y CI).
- Pruebas: `npm test` (unitarias + e2e con servidor LLM falso). CI en GitHub Actions (Windows/Linux/macOS × Node 18/20/22).
- Pendiente de probar a mano por el usuario con un modelo real y una terminal interactiva.

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

0. Diseño en Figma: pantallas, temas, mascotas, accesibilidad, nombre. ✓
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

## Estado al 2026-10-18 (rama `feat/onboarding-i18n`)

Hecho en esta rama (pedido del usuario tras probar v0.1.0):
- **Asistente de inicio** (`src/onboarding.js`, primera vez o `/setup`): 1) idioma es/en → 2) tema con flechas,
  vista previa y mascota del tema → 3) cómo usar modelos: local (detecta Ollama/LM Studio/llama.cpp/vLLM/Jan),
  API key (Gemini, Groq, OpenRouter, OpenAI, Anthropic, DeepSeek; entrada oculta), PC remota (`codice serve`) o después.
- **Idioma de la interfaz** (`src/i18n.js`, `L(es, en)`, ajuste `language`). Los comandos son iguales en ambos
  idiomas y en inglés (`/help`, `/model`, `/theme`…).
- **Pantalla de inicio mínima** (no abrumar): banner + mascota, una línea de estado y una de ayuda.
- **Errores claros en dos líneas** (qué pasó + qué hacer), con ajuste de línea en vez de cortar texto.
- `/theme` muestra la mascota de cada tema; `/mascot` elige mascota **solo para el tema actual o para todos**
  (`themeMascots`).
- Tema `auto` por defecto; `--base-url` se muestra con su dirección (no "cli").

Pendiente:
- ~~Traducir lo restante~~ hecho en `feat/i18n-remaining` (serve/connect/bench, subcomandos, `--help`, web, MCP, plugins,
  PNG, mascotas, avisos de contraste). Prueba e2e del modo inglés incluida.
- Probar el asistente y la consola en una terminal real (no se puede automatizar sin TTY).
- Modelos del usuario: en la laptop no hay Ollama ni LM Studio. Solo hay en la caché de Hugging Face
  `Qwen2.5-0.5B-Instruct`, `Qwen2.5-3B-Instruct` e `Imanol11/qwen3b-int4-TinyQ` (formato transformers, requieren
  Python; no se pueden usar directamente). Opciones: instalar Ollama + `ollama pull qwen2.5-coder:3b`, o una API key
  con nivel gratuito (Gemini, Groq, OpenRouter `:free`).
- Las suscripciones de chat (Claude Pro/Max, ChatGPT Plus) no se pueden usar en apps de terceros: solo API keys.

## Modelo local del usuario (2026-10-18)

- Sus modelos en Hugging Face (cuenta **Imanol11**, https://huggingface.co/Imanol11): `qwen0.5b-int4-Octuma`,
  `qwen1.5b-int4-Octuma`, `qwen3b-int4-Octuma`, cuantizados con su librería **Octuma**
  (https://github.com/1mano1/octuma). Cada uno trae `.gguf` (llama.cpp) y `.tq.safetensors` (PyTorch).
- Descargado: `C:\ProyectosIA_Imanol\modelos\qwen3b-int4.gguf` (2.40 GB, SHA-256 verificado).
  Licencia Qwen Research (solo no comercial).
- llama.cpp b11381 (builds Vulkan y CPU) en `C:\ProyectosIA_Imanol\modelos\llama.cpp\`.
  Arranque: `C:\ProyectosIA_Imanol\modelos\iniciar-octuma.cmd` → servidor en `http://127.0.0.1:8080`
  (proveedor `llamacpp` de Códice, modelo `qwen3b-int4-octuma`).
- Medido en la laptop (Ryzen 5 5500U, 16 GB, Radeon integrada): ~14 tokens/s, primer token 0.5 s,
  **tool calling nativo** (`codice bench`).
- Prueba real: el 3B usa herramientas bien pero no resuelve bugs de lógica sencillos y tiende a repetir
  acciones → se añadió detector de bucles y fragmento post-Edit (`fix/small-model-robustness`).
  Para código conviene 7B+ (o API).

## Modelos locales gestionados por Códice (rama `feat/local-models`)

Pedido del usuario: no tener que "encender" el modelo aparte; elegirlo desde Códice y usarlo.
- Proveedor `local` (por defecto): detecta GGUF en `~/.codice/models`, `modelDirs` del usuario, caché de Hugging Face,
  LM Studio y Jan, más los modelos de **Ollama** (manifiesto → blob GGUF, sin necesitar Ollama encendido).
- Al primer mensaje arranca `llama-server` (puerto libre, `--jinja`, GPU con `-ngl`, respaldo a CPU) y lo apaga al salir
  o al cambiar de modelo (`src/local/engine.js`). Si falta el motor, lo descarga (llama.cpp `b11381`, versión fija).
- `/models`: lista, `add-dir`, `dirs`, `download <usuario/repo>` (Hugging Face, verificación SHA-256, `HF_TOKEN` para privados).
- Formatos no compatibles (safetensors, ONNX, MLX, GPTQ/AWQ) se detectan y se avisa que busquen la versión GGUF.
- En la laptop del usuario: `modelDirs = ["C:/ProyectosIA_Imanol/modelos"]` → detecta `qwen3b-int4`; respuesta completa
  en ~32 s la primera vez (la mayor parte es procesar el prompt de sistema en la iGPU), el motor se apaga al salir.
- Lección: no escribir texto con comillas invertidas dentro de `node -e "…"` en bash; usar el editor o archivos.

## Memoria compatible con otros agentes (rama `feat/memory-compat`)

- "Archivo de memoria" = `CODICE.md` en la raíz del proyecto (equivalente a `CLAUDE.md`). El prompt de sistema lo indica.
- Se leen también: `CLAUDE.md`/`.claude/CLAUDE.md` (Claude Code), `AGENTS.md` (Codex/OpenCode), `GEMINI.md`,
  `QWEN.md`, `.github/copilot-instructions.md`, `.cursorrules` y `.cursor/rules/*.mdc` (Cursor), `.windsurfrules`,
  `.clinerules` (archivo o carpeta), `CONVENTIONS.md` (Aider); y de usuario `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.gemini/GEMINI.md`, `~/.qwen/QWEN.md`. Se desactiva con `compat.claude: false`.
- `/init` incorpora lo vigente de esos archivos a `CODICE.md` sin borrarlos; `/memory` muestra de qué agente es cada uno.

## v2 de la interfaz de consola — APROBADA E IMPLEMENTADA (rama `feat/console-v2`)

Diseño en Figma, sección "v2 · Estructura de la consola (propuesta)" (pantallas A–D + notas HCI). Implementación:
- `src/ui/live.js`: zona viva al pie (spinner + diálogo + caja + estado); todo se imprime encima (`writeAbove`).
- `src/ui/editor.js` (`BoxInput`): editor propio en modo raw (multilínea, pegado entre corchetes, historial,
  paleta, escritura anticipada que queda en cola mientras el agente trabaja). Con lector de pantalla, `TERM=dumb`
  o sin TTY se usa la entrada lineal clásica (`src/ui/input.js`).
- `select()` se dibuja como diálogo dentro de la zona viva (con `tone` para el ámbar de permisos).
- Pruebas: `test/fixtures/vt.js` (terminal virtual) + `test/ui-harness.js` y `test/ui-onboarding.js` → `test/ui.js`.

Criterios del diseño:
- Bienvenida compacta en un contenedor: mascota pequeña + versión, modelo, carpeta y 3 atajos (sin banner gigante).
- Caja de escritura fija abajo, con borde de acento cuando tiene el foco; crece con el texto (hasta ~8 líneas).
- Barra de estado DEBAJO de la caja (modo, shift+tab, modelo, % contexto, tiempo de la última respuesta);
  la paleta "/" ocupa ese lugar al escribir comandos.
- Spinner y diálogos de permiso justo ENCIMA de la caja; durante un diálogo la caja se atenúa.
- Comandos largos completos en varias líneas; nada se desborda. Modo lector de pantalla: salida lineal sin cajas.

## Pulido de la consola v2 (rama `fix/flicker-streaming-tokens`)

Problemas reportados al probarla y solución:
- **Parpadeo**: la zona viva ya no se borra y redibuja; cada cuadro se escribe de una vez con salida sincronizada
  (`\x1b[?2026h`), cursor oculto y renglones sobrescritos (`\x1b[K`).
- **Texto de golpe**: el renglón en curso se muestra en la zona viva palabra por palabra (`setStreamLines`) y un
  suavizado revela las ráfagas a ritmo constante (`mainView` en `src/agent/agent.js`).
- **No responsivo**: historial de lo impreso (`history` en `src/ui/output.js`); al redimensionar se limpia la pantalla
  y se redibuja; bienvenida, diffs, cabeceras y mensajes del usuario son bloques que se recalculan (`outBlock`).
  La mascota se oculta en ventanas de menos de 64 columnas.
- **Caja siempre al fondo**: `anchorBottom()` empuja la zona viva al último renglón al iniciar y al redibujar.
- **Tokens**: cada petición reenvía instrucciones + conversación y cada paso con herramientas es una petición.
  Modo ligero `lean: 'auto'` (activo salvo en proveedores de nube): herramientas sin textos de ayuda → ~1,700 tokens
  por petición en vez de ~2,500. La barra ya no muestra el total acumulado (engañoso); `/cost` lo explica e
  incluye los tokens de caché.
- Diff de archivos nuevos: las líneas vacías ya salen con número y `+`.

## Memoria entre sesiones y recuperación de errores (rama `feat/session-memory`)

- Dentro de una sesión el modelo ya recibe toda la conversación (y se compacta si se llena).
- **Entre sesiones**: `src/activity.js` registra cada turno sin usar el modelo (pedido, archivos cambiados,
  herramientas, resultado, error) en `~/.codice/projects/<proyecto>/activity.jsonl`. Al iniciar, las últimas 10
  entradas de otras sesiones van al prompt ("Recent activity in this project"). `/memory` las muestra;
  `/memory clear-activity` las borra.
- Herramienta **`Remember`**: el agente anota hechos duraderos en la sección "## Notas" de `CODICE.md`.
- La bienvenida muestra qué contexto leyó ("memoria · CODICE.md · N actividades recientes" o sugiere `/init`).
- **Recuperación**: reintentos automáticos ante fallos pasajeros del modelo (red, 429/5xx, motor reiniciando;
  1 s / 3 s / 8 s, uno solo si la conexión es rechazada); si el contexto se desborda, compacta y reintenta;
  cada error de herramienta llega con la indicación de investigar la causa, corregir y seguir; regla en el prompt.

## Consumo y saldo (rama `feat/usage`)

- `src/usage.js`: histórico local por día y `proveedor:modelo` en `~/.codice/usage.json` (400 días), costo
  estimado con `settings.pricing` (USD por millón: `input`, `output`, `cached`) o el costo real que devuelve
  OpenRouter, límites de velocidad leídos de los encabezados (`x-ratelimit-*`, `anthropic-ratelimit-*`) y saldo
  por API donde existe: OpenRouter (usado/límite/restante), DeepSeek (saldo) y la PC propia (`/codice/usage`).
- `/usage [today|month|all]`: sesión, hoy y mes por modelo, saldo del proveedor actual, límites y enlace de
  facturación cuando el proveedor no da el saldo por API (Anthropic, OpenAI, Gemini, Groq). `/cost` sigue igual.
- `codice serve` lee la cola de cada respuesta de chat para contar tokens (total, por día y por IP) y los guarda
  en `~/.codice/serve-usage.json`; `GET /codice/usage` (con token) los expone.

## Compactación de la conversación (rama `feat/compaction`)

- Automática al llegar a `autoCompact` (85 % por defecto, se cambia en `/config`) o manual con `/compact [instrucciones]`;
  también si el modelo rechaza la petición por desbordar el contexto.
- Indicador "Compactando la conversación…" y al terminar "Conversación compactada · antes → después tokens".
- Resumen por secciones como Claude Code (pedido, conceptos, archivos, errores, pendientes, trabajo actual,
  siguiente paso con el último pedido literal). La transcripción se recorta al 60 % de la ventana (conserva el
  primer mensaje y lo reciente) para que modelos pequeños puedan resumir.
- Tras el resumen se agregan la lista de tareas y los archivos leídos/editados, para no perder el estado.
- Si el modelo falla al resumir, se compacta sin él (pedidos del usuario y últimos mensajes).
- La barra de estado muestra "N % para autocompactar" cuando faltan 15 puntos o menos.

## Peticiones comprimidas con gzip (rama `feat/gzip-requests`)

- Como Claude Code (oct. 2026): el cuerpo de cada petición al modelo (toda la conversación) se envía con
  `Content-Encoding: gzip` (`src/llm/compress.js`, `postJSON`). Medido: ~2.6× más ligero en texto y código, ~1 ms.
  Reduce la espera antes del primer token con internet lento; no acelera la generación.
- `compressRequests`: `'auto'` (por defecto: solo la API de Anthropic, como Claude Code, y la PC remota), `true` o `false`.
  `CODICE_GZIP=0` lo apaga. Si un servidor responde 400/415/422 al cuerpo comprimido, se reenvía sin comprimir y
  se recuerda para ese servidor durante la ejecución.
- `codice serve` descomprime el cuerpo antes de pasarlo a Ollama/llama.cpp (que no aceptan gzip).

## Diseño de la consola: bienvenida arriba, caja abajo, paneles (rama `fix/console-layout`)

- `live.js` lleva `contentRow` (renglón donde termina la conversación). La conversación crece desde arriba y la
  caja + barra de estado van en los últimos renglones; entre ambas hay un hueco en blanco dentro de la zona viva.
  El texto en curso y el spinner van pegados a la conversación; los diálogos, pegados a la caja.
- Arreglo: al encogerse la zona (se cierra un diálogo, la caja pierde líneas) la caja ya no se sube; antes solo se
  corregía al redimensionar.
- Comandos informativos (`panel: true`: help, usage, cost, context, status, doctor, tools, skills, commands, todos)
  se muestran en un panel encima de la caja (`showPanel` en `select.js`, salida capturada con `captureOutput`);
  esc lo cierra y no queda en la conversación; ↑↓/PgUp/PgDn desplazan. Con lector de pantalla se imprimen.
- La terminal virtual de pruebas (`test/fixtures/vt.js`) ahora tiene ventana visible e historial (`viewport()`).

## Búsqueda web (rama `feat/web-search`)

- `WebSearch` prueba motores en orden y pasa al siguiente si uno falla o lo bloquean: Brave (`BRAVE_API_KEY`),
  Tavily (`TAVILY_API_KEY`), SearXNG propio (`SEARXNG_URL`) y, sin clave, DuckDuckGo (html y lite) y Bing.
  En settings: `webSearch: { engine: 'auto'|'brave'|'tavily'|'searxng'|'duckduckgo'|'bing', braveKey, tavilyKey, searxngUrl }`.
- Parámetros como el de Claude Code: `allowed_domains`, `blocked_domains`, `max_results`. Quita duplicados y anuncios.
- Sin clave, DuckDuckGo bloquea tras varias búsquedas seguidas; por eso existe el respaldo y la sugerencia de clave.
- El prompt incluye la fecha de hoy y pide buscar lo que pudo cambiar tras el entrenamiento y citar las URLs.

## Agentes directos (rama `feat/direct-agents`)

- Regla en el prompt (agente principal y subagentes): hacer lo que se pide, completo y directo, sin advertencias,
  descargos ni comentarios morales no pedidos. Codice no agrega filtros de contenido propios; el límite lo pone
  el modelo elegido. Para modelos locales sin filtros, el usuario puede usar cualquier GGUF (p. ej. "abliterated").
- No se incluyen prompts para evadir los filtros de los modelos en la nube (viola sus términos y arriesga la cuenta).
- Se mantienen las protecciones del equipo: permisos, no ejecutar comandos destructivos sin pedirlo, no exponer secretos.

## Sandbox de comandos (rama `feat/sandbox`, diseño aprobado: Figma "v3 · Sandbox" E/F/G)

- `src/sandbox.js`: motores bubblewrap (Linux), sandbox-exec (macOS, perfil seatbelt) y Docker (Windows; un
  contenedor por proyecto `codice-sb-<hash>` que se reutiliza, proyecto en `/workspace`). Escritura: proyecto +
  `~/.codice/sandbox/{tmp,cache}` (+ `allowWrite`); TMPDIR y cachés de npm/pip apuntan ahí. Sin red salvo
  `allowedDomains`, vía un proxy local (CONNECT y HTTP) que solo deja pasar esos dominios.
- Modos `sandbox.mode`: `off` (por defecto), `auto`, `strict`. Con el sandbox activo, Bash no pide permiso
  (`autoAllow`). `detectBlock` reconoce bloqueos (ENOTFOUND/EAI_AGAIN, EROFS/EPERM, dominio rechazado por el
  proxy). En `auto` + consola: diálogo F (permitir dominio → `.codice/settings.local.json`, fuera una vez, no).
  En `strict` o `-p`: el modelo recibe la explicación y no debe rodearlo.
- UI: línea `sandbox` en la bienvenida, `⛨ sandbox` en la barra de estado, `/sandbox [auto|strict|off]`.
  El prompt le dice al modelo que está en sandbox (y que con Docker es un contenedor Linux con `sh`).
- Pruebas reales (se omiten sin motor): en CI Linux se instala bubblewrap; macOS usa sandbox-exec; probado en
  Windows con Docker Desktop. `CODICE_SANDBOX_ENGINE` fuerza el motor (pruebas).

## Bienvenida viva (rama `fix/live-mascot`)

- `banner()` acepta funciones para modelo, proveedor, mascota y sandbox: al redibujar muestra los valores actuales.
- `ui.redraw()` vuelve a dibujar la conversación en su lugar (lo usa también el cambio de tamaño).
- `runtime.save()` redibuja solo al cambiar modelo, proveedor, tema, mascota, idioma o `sandbox.mode`.
- `/mascot` y `/theme` ya no imprimen en la conversación (el cambio se ve en la bienvenida); con lector de
  pantalla o sin consola viva sí se anuncia.

## Feedback del turno y modelos pequeños (rama `feat/turn-feedback`)

- El indicador (spinner) sigue visible todo el turno, también mientras el modelo escribe ("Escribiendo…"),
  piensa ("Pensando…") o arma una llamada a herramienta ("Preparando Bash…", también en modo prompt donde el
  `<tool_call>` va oculto). Tiempo y tokens cuentan todo el turno (`beginTurn`). Si un paso lleva 8 s sin tokens:
  "el modelo está leyendo el contexto".
- Cierre de turno `ui.turnDone`: "✻ Listo · 14 s · 3 herramientas", "Esperando tu respuesta" (si terminó con
  pregunta o se rechazó un permiso) o "Detenido".
- Comandos que no imprimen nada dejan "⎿ guardado / cerrado / cerrado sin cambios".
- `announcesAction`: si el modelo termina anunciando ("voy a…", "a continuación…", "let me…") sin llamar
  herramientas, se le pide que lo haga (máx. 2 por turno).
- Read/Edit con archivo inexistente sugieren archivos con el mismo nombre en el proyecto y en ~/.codice
  (`findSimilar`), o piden usar Glob antes de preguntar. El prompt dice dónde viven los archivos de Códice.

## /provider add con clave directa (rama `fix/provider-add-key`)

- `/provider add <nombre> <url> [tipo] [CLAVE | VARIABLE]`: si el último dato es MAYÚSCULAS_CON_GUIONES es el
  nombre de una variable de entorno (`apiKeyEnv`); si no, es la clave (`apiKey`, en ~/.codice/settings.json).
  Si se omite el tipo, el tercer dato es la clave. Prueba la conexión al guardar y avisa si la clave falla o la
  variable no existe. El error 401 explica cuál de los dos casos es.
- Ejemplo real: llama-server.exe con `--host 0.0.0.0 --api-key …` en otra PC →
  `/provider add pc http://192.168.1.69:8081/v1 openai sk-local-…`.

## Pensamiento del modelo y ciclos (rama `fix/thinking-display`)

- `showThinking` ahora es `false` por defecto: el razonamiento no se imprime; el indicador muestra una línea con
  la idea actual ("Pensando: …"). `/config` → "Mostrar pensamiento completo" lo vuelve a imprimir todo.
- `thinking: false` (`/config` → "Pensamiento del modelo") apaga el razonamiento en servidores propios:
  `chat_template_kwargs.enable_thinking=false` (llama.cpp, vLLM, LM Studio) o `think:false` (Ollama). No se manda
  a la nube. Probado con qwen3.6-35b-a3b en llama-server: con pensamiento, "di hola" gastó 300 tokens pensando.
- `repeatsItself`: si los últimos 300 caracteres del texto o razonamiento ya aparecieron 2 veces antes, se corta
  la petición, no se guarda el texto repetido y se le pide decidir (máx. 2 por turno; luego se detiene).
- Mascotas: `normalizeMascot` corrige espacios, filas disparejas y bordes vacíos; `/mascot` muestra las que no
  cargan y por qué (`mascotErrors`).

## Llamadas a herramientas cortadas (rama `fix/broken-tool-args`)

Una tool_call con argumentos JSON inválidos (cortada por un bucle o por el límite de tokens) rompía la
conversación: llama-server respondía 500 en cada petición que la incluyera y el CLI reintentaba a ciegas.

- `src/agent/history.js`: `validArgs` (¿el argumento es un objeto JSON válido?) y `sanitizeHistory` (sustituye
  cada llamada rota por una nota en el texto del asistente, quita sus resultados y los resultados huérfanos; no
  pierde el resto del contexto). `brokenNote(name)` = la nota.
- Antes de cada petición se sanea `this.messages`; una llamada con JSON inválido no se ejecuta ni se guarda tal
  cual, y se le pide al modelo repetirla más corta (si fue por `finish_reason: length`, se le dice). Máx. 3 por turno.
- Error 500 con "Failed to parse tool call arguments": no se reintenta igual; se repara el historial (o se quita
  la última tool_call) y se reintenta una vez. Otros 500: máx. 2 reintentos.
- `Session.load` repara la sesión al cargarla (y la reguarda): las sesiones ya rotas vuelven a funcionar; `/resume`
  avisa cuántas reparó. Probado con una sesión real rota (Write de 11 KB cortado).
- `outputBudget`: siempre se manda `max_tokens` en servidores propios (configurado o ≤ 8192 sin pasar del contexto).
  `finish: length` + tool_calls → se validan como posiblemente cortadas.
- Detector de bucles (`repeatsItself`) también sobre los argumentos en streaming.
- `src/llm/sampling.js`: Qwen3/QwQ en servidores propios usan temp 0.6, top_p 0.95, top_k 20, presence_penalty 1
  (0.7 sin pensamiento), que evita los bucles de las temperaturas bajas. `settings.sampling` lo reemplaza. En la
  nube no se manda (top_k/min_p no siempre se aceptan).

Sesión rota manualmente: `/resume` la repara; o empieza una nueva con `/exit` y reabrir, o borra el último mensaje
con `/rewind`.

## Comandos en vivo mientras el agente trabaja (rama `fix/live-commands`)

- Antes, cualquier cosa escrita mientras el agente trabajaba se encolaba (incluidos /mascot, /theme…), y parecía
  que no funcionaban. Ahora los comandos marcados `live: true` se ejecutan al momento; el resto sigue a la cola.
- `live: true` en los comandos que no tocan al modelo ni la conversación: help, tools, skills, commands, context,
  cost, usage, todos, status, doctor, version, memory, mascot, theme, config, accessibility.
- `BoxInput` separa `working` (el agente trabaja) del estado de foco (`idle/prompt/modal/ask`), para que al
  terminar el agente no se pise un diálogo abierto. `command(text, { live })` no toca `setBusy` en modo live;
  `runLiveCommand` evita reentrancia. Placeholder de ocupado: "/comandos corren ya".
