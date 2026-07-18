/**
 * PRNG determinista del motor (T2.1).
 *
 * Math.random está PROHIBIDO en src/sim/ (regla de lint en scripts/lint-determinism.mjs).
 * Toda aleatoriedad de la simulación pasa por aquí: dispersión de armas, error de radar,
 * elección de módulo dañado. Mismo seed ⇒ misma secuencia, en cualquier máquina.
 *
 * Algoritmo: xoshiro128** — enteros de 32 bits, sin dependencia de float ni de la
 * plataforma. La aritmética se hace con Math.imul y >>> 0 para forzar 32 bits sin signo.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: string | number) {
    // splitmix32 para expandir la semilla a 4 palabras de estado.
    let h = typeof seed === "number" ? seed >>> 0 : hashString(String(seed));
    const next = () => {
      h = (h + 0x9e3779b9) >>> 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Entero sin signo de 32 bits. */
  nextUint32(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7) >>> 0, 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11) >>> 0;
    return result;
  }

  /** Float en [0,1). 24 bits de mantisa: suficiente y estable entre plataformas. */
  next(): number {
    return (this.nextUint32() >>> 8) / 16777216;
  }

  /** Float en [min,max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Entero en [0,n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Elige un índice según pesos. Usado para repartir daño entre módulos de un sector (D6). */
  weighted(weights: number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /**
   * Deriva un RNG hijo independiente. Permite que un subsistema (p. ej. el generador de
   * mapas) consuma aleatoriedad sin desplazar la secuencia del motor, lo que rompería
   * el determinismo al añadir o quitar una llamada.
   */
  fork(label: string): Rng {
    return new Rng(this.forkSeed(label));
  }

  /**
   * La SEMILLA que fork() usaría, sin construir el Rng. Es la misma derivación (consume
   * una tirada del padre + etiqueta), expuesta para quien necesita una semilla
   * serializable en vez de un Rng vivo: el MatchRunner de R3.8 deriva así la semilla de
   * cada ronda y la guarda en el resultado, de modo que cualquier ronda es reproducible
   * por sí sola con new Battle({ seed }).
   */
  forkSeed(label: string): string {
    return `${this.nextUint32()}:${label}`;
  }

  /** Estado serializable, para incluirlo en snapshots y verificar la reanudación de replays. */
  getState(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  setState(st: [number, number, number, number]): void {
    [this.s0, this.s1, this.s2, this.s3] = st;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
