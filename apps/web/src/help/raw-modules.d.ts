/**
 * EQ3 · Tipos de los imports de Vite que usa el Centro de Ayuda para EMBEBER en
 * build las fuentes de verdad (ficheros de texto con `?raw` y JSON con
 * `import.meta.glob`). No añade dependencias: Vite y Vitest los resuelven solos.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}

interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { eager: true; import?: string }): Record<string, T>;
}
