# Códice

**Agente de programación open source para la terminal.** Funciona con modelos locales (Ollama, LM Studio, llama.cpp, vLLM, Jan), con servicios en la nube compatibles con OpenAI y con **tu propia PC potente desde otra máquina**. Inspirado en Claude Code: herramientas, permisos, subagentes, skills, plugins, MCP y hooks.

> *Open-source terminal coding agent for local, cloud or self-hosted remote models. Spanish-first UI, zero dependencies, Node.js ≥ 18.*

```
            ▄█▀
 ██████   ██████  ██████  ██  ██████ ███████
██       ██    ██ ██   ██ ██ ██      ██
██       ██    ██ ██   ██ ██ ██      █████
██       ██    ██ ██   ██ ██ ██      ██
 ██████   ██████  ██████  ██  ██████ ███████
```

## Características

- **Cualquier modelo**: local, en la nube o en tu PC remota. Cambio en caliente con `/model` y `/provider`.
- **Cadena de respaldo**: si un proveedor no responde, usa el siguiente.
- **Herramientas**: leer, escribir y editar archivos (con diff), Bash, Glob, Grep, LS, WebFetch, WebSearch, lista de tareas, preguntas al usuario.
- **Modelos sin *tool calling***: se detectan solos y se usan herramientas por prompt (`<tool_call>`).
- **10 agentes expertos** incluidos y subagentes en paralelo. Crea los tuyos con `/agents new` (el modelo te ayuda a diseñarlos) y asigna a cada uno su propio modelo.
- **Skills, comandos personalizados, plugins (compatibles con el formato de Claude Code), MCP y hooks.**
- **Permisos**: modos `default`, `acceptEdits`, `plan` y `bypass`; reglas tipo `Bash(npm test:*)`.
- **Sesiones** con `--continue`/`/resume`, **puntos de control** con `/rewind` y **autocompactado** del contexto.
- **`codice serve` / `codice connect`**: usa los modelos de tu PC desde la laptop.
- **`/bench`**: mide velocidad y soporte de herramientas de tus modelos.
- **Temas, mascotas y personalización**; mascotas propias desde plantilla o PNG.
- **Accesible**: contraste WCAG AA en todos los temas (AAA en Alto contraste), modo lector de pantalla, movimiento reducido, sin color, solo teclado.
- **Cero dependencias**: solo Node.js.

## Instalación

Requiere [Node.js](https://nodejs.org) 18 o superior.

```bash
git clone https://github.com/1mano1/codise-cli.git
cd codise-cli
npm link        # deja disponible el comando "codice"
```

## Modelos locales sin instalar nada más

Códice encuentra tus modelos **GGUF** (y los que descargaste con **Ollama**, LM Studio o la caché de Hugging Face), y al elegir uno **arranca el motor llama.cpp solo** y lo apaga al salir. Si no tienes el motor, lo descarga la primera vez (unos 30 MB).

```
/models                                        elige entre tus modelos detectados
/models add-dir C:\mis-modelos                 añade una carpeta donde buscar
/models download Imanol11/qwen3b-int4-Octuma   descarga un GGUF de Hugging Face (verifica SHA-256)
```

Formatos: **GGUF** y modelos de **Ollama** se usan directo. safetensors/PyTorch, MLX, GPTQ/AWQ/EXL2 no (requieren Python o hardware específico); Códice los señala para que busques su versión GGUF.

## Inicio rápido (con Ollama)

```bash
ollama pull qwen2.5-coder:7b
cd mi-proyecto
codice
```

Al abrirse, Códice detecta los modelos disponibles y te deja elegir uno. Escribe lo que necesitas:

```
› el botón de enviar no valida el email, arréglalo
```

Tarea única, sin consola interactiva:

```bash
codice -p "explica qué hace src/app.js"
git diff | codice -p "escribe el mensaje de commit"
codice -p "lista los TODO del proyecto" --output-format json
```

## Proveedores

| Tipo | Proveedores |
|---|---|
| Local | `ollama`, `lmstudio`, `llamacpp`, `vllm`, `jan` |
| Nube | `openrouter`, `openai`, `groq`, `deepseek`, `anthropic`, `gemini` (API key por variable de entorno) |
| PC remota | cualquier máquina con `codice serve` |
| Propio | `/provider add <nombre> <url> [ollama\|openai\|codice] [VARIABLE_API_KEY]` |

```bash
codice --provider lmstudio --model qwen2.5-coder-14b
codice --base-url http://localhost:8080/v1 --model mi-modelo
codice config set fallback '["ollama:qwen2.5-coder:7b"]'   # respaldo
```

### Usar tu PC potente desde la laptop

En la PC (con Ollama o LM Studio corriendo):

```bash
codice serve
```

Muestra las direcciones de red y el comando exacto para la laptop:

```bash
codice connect http://192.168.1.50:8787 --token <token> --name pc-casa
```

Las herramientas (archivos, Bash) se ejecutan en la laptop; solo la inferencia viaja a la PC. Para usarlo fuera de casa usa **Tailscale**, ZeroTier o una VPN; no abras el puerto a internet. Para HTTPS: `codice serve --cert cert.pem --key key.pem`.

## Comandos

| Comando | Descripción |
|---|---|
| `/help` | Comandos y atajos |
| `/model`, `/models`, `/provider` | Modelo y proveedor |
| `/mode` | Modo de permisos (también `shift+tab`) |
| `/permissions` | Reglas allow/deny |
| `/agents` | Ver, crear, editar y asignar modelo a agentes |
| `/skills`, `/commands`, `/tools` | Recursos disponibles |
| `/mcp`, `/plugin` | Servidores MCP y plugins |
| `/memory`, `/init` | Memoria del proyecto (`CODICE.md`) |
| `/compact`, `/context` | Contexto |
| `/resume`, `/rewind`, `/clear` | Sesiones y puntos de control |
| `/theme`, `/mascot`, `/config`, `/accessibility` | Personalización |
| `/bench`, `/connect` | Rendimiento y PC remota |
| `/cost`, `/usage`, `/doctor`, `/status` | Uso, consumo y saldo por proveedor, diagnóstico |

**Atajos**: `!cmd` ejecuta en el shell · `#nota` guarda en memoria · `@ruta` adjunta un archivo · `\` + enter nueva línea · `esc` interrumpe · `ctrl+o` salida completa · `ctrl+c` ×2 salir.

## Agentes y subagentes

Incluidos: `general-purpose`, `explore`, `plan`, `code-reviewer`, `debugger`, `test-writer`, `refactorer`, `security-auditor`, `docs-writer`, `frontend`.

Un agente es un `.md` en `~/.codice/agents/` (usuario) o `.codice/agents/` (proyecto):

```markdown
---
name: revisor-sql
description: Revisa consultas SQL buscando errores, inyección y rendimiento.
tools: Read, Grep, Glob
model: ollama:qwen2.5-coder:14b
---
Eres un experto en SQL. …
```

Asigna un modelo distinto a cualquier agente: `codice config set agentModels.explore "ollama:qwen2.5-coder:1.5b"`.

## Skills, comandos, plugins, MCP y hooks

- **Skills**: `~/.codice/skills/<nombre>/SKILL.md` con `name` y `description`. El agente las carga cuando aplican, o úsalas con `/<nombre>`.
- **Comandos**: `.codice/commands/<nombre>.md` con `$ARGUMENTS`, `$1…$9` y `` !`comando` ``.
- **Plugins**: `/plugin install <ruta | url git | usuario/repo | plugin@marketplace>`. Agrupan skills, agentes, comandos, hooks y MCP. Ejemplo en [`examples/plugin-ejemplo`](examples/plugin-ejemplo).
- **MCP**: `/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .` o `.mcp.json` en el proyecto. Las herramientas aparecen como `mcp__servidor__herramienta`.
- **Hooks** (`settings.json`): `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SubagentStop`. Salir con código 2 bloquea la acción.

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx prettier --write ." }] }]
  }
}
```

Por compatibilidad, Códice también lee `CLAUDE.md`, `AGENTS.md` y las carpetas `.claude/` (desactívalo con `compat.claude: false`).

## Personalización

- **Temas**: Automático, Brasa, Alba (claro), Medianoche, Daltónico, Alto contraste y Fósforo. Crea los tuyos con `/theme` → *Personalizado…*; Códice avisa si algún color no alcanza el contraste mínimo.
- **Mascotas**: Chispa, Ajolote, Nahual y Xolo. En modo automático cada tema trae la suya. Crea la tuya con `/mascot` (plantilla JSON) o `/mascot import gato.png Michi`.
- **Estilos de respuesta**: normal, conciso, explicativo y aprendizaje.

## Accesibilidad

- Todo el texto de los temas incluidos cumple **WCAG AA (≥ 4.5:1)**; Alto contraste cumple **AAA (≥ 7:1)**.
- Los estados nunca dependen solo del color: `●` ok, `○` pendiente, `✗` error, `+`/`−` en diffs.
- `--screen-reader`: frases completas, sin dibujos ni animaciones.
- `--reduce-motion`, `--no-color` y `NO_COLOR` respetados.
- Todo se maneja con teclado; los menús aceptan números.

## Configuración

`~/.codice/settings.json` (usuario), `.codice/settings.json` (proyecto) y `.codice/settings.local.json` (local, no se versiona).

```json
{
  "provider": "ollama",
  "model": "qwen2.5-coder:14b",
  "fallback": ["lmstudio:qwen2.5-coder-7b"],
  "contextWindow": 32768,
  "theme": "auto",
  "mascot": { "name": "auto" },
  "permissions": { "mode": "default", "allow": ["Bash(npm test:*)"], "deny": ["Bash(rm -rf:*)"] },
  "agentModels": { "explore": "ollama:qwen2.5-coder:1.5b" }
}
```

## Desarrollo

```bash
npm test                 # pruebas unitarias y de punta a punta (sin modelo real)
node test/run.js remota  # filtrar por nombre
```

Flujo de ramas: `feat/*` → PR a `dev` → `main`.

## Licencia

[MIT](LICENSE) © Imanol Rodríguez
