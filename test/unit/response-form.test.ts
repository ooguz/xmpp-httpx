import { describe, expect, it } from "vitest";
import { HttpxResponse } from "../../src/client/response.js";
import { streamFromBytes, textEncoder } from "../../src/util/bytes.js";

function response(body: string, contentType?: string): HttpxResponse {
  return new HttpxResponse({
    statusCode: 200,
    version: "1.1",
    headers: new Headers(contentType === undefined ? {} : { "content-type": contentType }),
    body: streamFromBytes(textEncoder.encode(body)),
  });
}

describe("HttpxResponse.formData", () => {
  it("parses urlencoded bodies", async () => {
    const form = await response(
      "name=ada&note=%C3%BCber+all&note=twice",
      "application/x-www-form-urlencoded",
    ).formData();
    expect(form.get("name")).toBe("ada");
    expect(form.getAll("note")).toEqual(["über all", "twice"]);
  });

  it("parses multipart bodies, which is why it delegates to the platform", async () => {
    const boundary = "----httpxBoundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="field"',
      "",
      "value",
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
      "Content-Type: text/plain",
      "",
      "file body",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const form = await response(body, `multipart/form-data; boundary=${boundary}`).formData();
    expect(form.get("field")).toBe("value");
    const file = form.get("file") as File;
    expect(file.name).toBe("a.txt");
    expect(await file.text()).toBe("file body");
  });

  it("explains itself when there is no Content-Type", async () => {
    await expect(response("a=1").formData()).rejects.toMatchObject({
      code: "protocol-error",
      message: expect.stringContaining("needs a Content-Type"),
    });
  });

  it("explains itself when the body is not form data", async () => {
    await expect(response("<html>", "text/html").formData()).rejects.toMatchObject({
      code: "protocol-error",
      message: expect.stringContaining("not form data"),
    });
  });
});
