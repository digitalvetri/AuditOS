/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_MODE?: 'true' | 'false';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
