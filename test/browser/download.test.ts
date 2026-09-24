import { describe, expect, it } from "vitest";
import {
  filenameFor,
  isAttachment,
  isRenderableType,
  mediaType,
} from "../../examples/webext/src/download.js";

const PAGE = "httpx://site@example.org/dir/report.pdf";

describe("mediaType", () => {
  it("strips parameters and case", () => {
    expect(mediaType("Text/HTML; charset=UTF-8")).toBe("text/html");
    expect(mediaType("")).toBe("");
  });
});

describe("isRenderableType", () => {
  it("renders text, images, and structured text", () => {
    for (const type of [
      "text/html",
      "text/plain; charset=utf-8",
      "text/css",
      "image/png",
      "image/svg+xml",
      "application/json",
      "application/xml",
      "application/atom+xml",
      "application/vnd.api+json",
      "", // no type at all — browsers sniff as text
    ]) {
      expect(isRenderableType(type), type).toBe(true);
    }
  });

  it("downloads binary and unknown types", () => {
    for (const type of [
      "application/pdf",
      "application/zip",
      "application/octet-stream",
      "audio/mpeg",
      "video/mp4",
      "font/woff2",
    ]) {
      expect(isRenderableType(type), type).toBe(false);
    }
  });
});

describe("isAttachment", () => {
  it("detects the attachment disposition only", () => {
    expect(isAttachment("attachment")).toBe(true);
    expect(isAttachment('Attachment; filename="x.txt"')).toBe(true);
    expect(isAttachment("inline")).toBe(false);
    expect(isAttachment(null)).toBe(false);
  });
});

describe("filenameFor", () => {
  it("prefers the Content-Disposition filename", () => {
    expect(filenameFor(PAGE, 'attachment; filename="Q3 results.pdf"')).toBe(
      "Q3 results.pdf",
    );
    expect(filenameFor(PAGE, "attachment; filename=plain.txt")).toBe("plain.txt");
  });

  it("prefers RFC 5987 filename* and decodes it", () => {
    expect(
      filenameFor(
        PAGE,
        "attachment; filename=\"fallback.bin\"; filename*=UTF-8''rapor-%C3%A7.pdf",
      ),
    ).toBe("rapor-ç.pdf");
  });

  it("falls back to the URL's last path segment", () => {
    expect(filenameFor(PAGE, null)).toBe("report.pdf");
    expect(filenameFor("httpx://site@example.org/a/b/%C3%A7.bin", null)).toBe(
      "ç.bin",
    );
    expect(filenameFor("https://example.org/files/report.pdf?v=2#x", null)).toBe(
      "report.pdf",
    );
  });

  it("falls back to 'download' when there is no usable name", () => {
    expect(filenameFor("httpx://site@example.org/", null)).toBe("download");
    expect(filenameFor("httpx://site@example.org/", "attachment; filename=")).toBe(
      "download",
    );
    expect(filenameFor("not a url", null)).toBe("download");
  });

  it("never yields a path, a traversal, or control characters", () => {
    // Only the basename is honored, so no part of a hostile path survives.
    expect(filenameFor(PAGE, 'attachment; filename="../../etc/passwd"')).toBe(
      "passwd",
    );
    expect(filenameFor(PAGE, 'attachment; filename="/abs/evil.sh"')).toBe(
      "evil.sh",
    );
    expect(
      filenameFor(PAGE, 'attachment; filename="C:\\\\Windows\\\\evil.exe"'),
    ).toBe("evil.exe");
    // A path with nothing after the last separator yields no name at all.
    expect(filenameFor("httpx://site@example.org/", 'attachment; filename="../"')).toBe(
      "download",
    );
    expect(filenameFor(PAGE, 'attachment; filename=".hidden"')).toBe("hidden");
    expect(filenameFor(PAGE, 'attachment; filename="a\u0000b\u001fc.txt"')).toBe(
      "abc.txt",
    );
  });

  it("caps absurd names", () => {
    const long = `${"x".repeat(500)}.txt`;
    expect(filenameFor(PAGE, `attachment; filename="${long}"`).length).toBe(120);
  });
});
