// Emulador de terminal mínimo para pruebas: aplica los códigos ANSI que usa Códice y devuelve la pantalla.
export class VirtualTerminal {
  constructor(cols = 100, rows = 40) {
    this.cols = cols;
    this.rows = rows;
    this.lines = [''];
    this.x = 0;
    this.y = 0;
    this.saved = { x: 0, y: 0 };
  }

  line(y) {
    while (this.lines.length <= y) this.lines.push('');
    return this.lines[y];
  }

  put(ch) {
    if (this.x >= this.cols) { this.x = 0; this.y++; }
    const l = this.line(this.y).padEnd(this.x, ' ');
    this.lines[this.y] = l.slice(0, this.x) + ch + l.slice(this.x + 1);
    this.x++;
  }

  write(data) {
    const s = String(data);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\x1b') {
        const rest = s.slice(i);
        let m;
        if ((m = rest.match(/^\x1b\[(\??)([0-9;]*)([A-Za-z~])/))) {
          const [all, priv, params, cmd] = m;
          const n = Number(params.split(';')[0]) || 0;
          if (!priv) {
            if (cmd === 'A') this.y = Math.max(0, this.y - (n || 1));
            else if (cmd === 'B') this.y += n || 1;
            else if (cmd === 'C') this.x += n || 1;
            else if (cmd === 'D') this.x = Math.max(0, this.x - (n || 1));
            else if (cmd === 'J') {
              if (n === 2 || n === 3) { this.lines = ['']; }
              else { this.lines[this.y] = this.line(this.y).slice(0, this.x); this.lines.length = this.y + 1; }
            } else if (cmd === 'K') {
              if (n === 2) this.lines[this.y] = '';
              else this.lines[this.y] = this.line(this.y).slice(0, this.x);
            } else if (cmd === 'H') { this.x = 0; this.y = 0; }
          }
          i += all.length - 1;
          continue;
        }
        if (rest[1] === '7') { this.saved = { x: this.x, y: this.y }; i += 1; continue; }
        if (rest[1] === '8') { ({ x: this.x, y: this.y } = this.saved); i += 1; continue; }
        continue;
      }
      if (ch === '\r') { this.x = 0; continue; }
      if (ch === '\n') { this.y++; this.x = 0; this.line(this.y); continue; }
      if (ch === '\b') { this.x = Math.max(0, this.x - 1); continue; }
      if (ch === '\x07') continue;
      this.put(ch);
    }
  }

  screen() {
    return this.lines.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  }

  cursor() {
    return { x: this.x, y: this.y };
  }
}
