/**
 * Firefox exposes `browser`, Chromium exposes `chrome`; both are absent when
 * the page is opened as a plain tab during development, so every caller must
 * cope with `undefined` rather than assume an extension context.
 */
export function extensionApi(): WebExtApi | undefined {
  return (
    (typeof browser !== "undefined" ? browser : undefined) ??
    (typeof chrome !== "undefined" ? chrome : undefined)
  );
}
