/// <reference types="vite/client" />

// Declares the environment variables this app reads, so TypeScript knows
// import.meta.env.VITE_API_BASE exists and is a string.
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
