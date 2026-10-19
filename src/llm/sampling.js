// Parámetros de muestreo por familia de modelo. Los Qwen3 caen en bucles de repetición con temperaturas bajas
// (≤ 0.3) y sin presence_penalty; estos son los valores que recomienda Qwen.
// settings.sampling = { temperature, top_p, top_k, min_p, presence_penalty } los reemplaza para cualquier modelo.

const QWEN3 = /qwen-?3(?:\.\d+)?(?=[-_:.\s]|$)|qwq/i;

export function samplingFor(model, settings = {}, provider = {}) {
  if (settings.sampling && typeof settings.sampling === 'object') return { ...settings.sampling };
  // en la nube no se mandan parámetros que algunas APIs no aceptan (top_k, min_p)
  if (provider?.cloud) return null;
  if (QWEN3.test(String(model || ''))) {
    return settings.thinking === false
      ? { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.0 }
      : { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.0 };
  }
  return null;
}

// Campos para el cuerpo de una petición compatible con OpenAI (llama.cpp, vLLM y LM Studio aceptan top_k y min_p).
export function openaiSamplingFields(s) {
  if (!s) return {};
  const out = {};
  for (const k of ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'frequency_penalty', 'repeat_penalty']) if (s[k] != null) out[k] = s[k];
  return out;
}
