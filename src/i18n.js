// Idioma de la interfaz (es | en). Los comandos son los mismos en ambos idiomas (en inglés).
let lang = 'es';

export function setLanguage(l) {
  lang = l === 'en' ? 'en' : 'es';
}

export function getLanguage() {
  return lang;
}

// L('texto en español', 'English text')
export function L(es, en) {
  return lang === 'en' ? en : es;
}
