/// <reference types="vite/client" />

declare module '*.masm?raw' {
  const content: string;
  export default content;
}
