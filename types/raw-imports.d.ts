/** Vite `?raw` static imports (used by tests for XML fixtures). */
declare module "*.xml?raw" {
  const content: string;
  export default content;
}
