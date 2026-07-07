import xml, { Element } from "@xmpp/xml";
import { NS_HTTPX, NS_JINGLE, NS_SIPUB } from "../constants.js";
import { CodecError } from "../errors.js";
import { decodeBase64, encodeBase64 } from "../util/base64.js";
import { cloneElement } from "../util/xml.js";

/**
 * The <data> child of <req>/<resp>, discriminated by encoding.
 *
 * sipub/jingle keep their element verbatim: the codec only extracts the
 * identifiers; SipubManager/JingleManager build and interpret the elements.
 * "unsupported" covers anything else — decoded losslessly so callers can
 * answer 501 cleanly.
 */
export type DataDescriptor =
  | { kind: "text"; text: string }
  | { kind: "xml"; element: Element }
  | { kind: "base64"; bytes: Uint8Array }
  | { kind: "chunkedBase64"; streamId: string }
  | { kind: "ibb"; sid: string }
  | { kind: "sipub"; id: string; element: Element }
  | { kind: "jingle"; sid: string; element: Element }
  | { kind: "unsupported"; name: string; element: Element };

export function encodeData(descriptor: DataDescriptor): Element {
  switch (descriptor.kind) {
    case "text":
      return xml("data", null, xml("text", null, descriptor.text));
    case "xml":
      return xml("data", null, xml("xml", null, cloneElement(descriptor.element)));
    case "base64":
      return xml(
        "data",
        null,
        xml("base64", null, encodeBase64(descriptor.bytes)),
      );
    case "chunkedBase64":
      return xml(
        "data",
        null,
        xml("chunkedBase64", { streamId: descriptor.streamId }),
      );
    case "ibb":
      return xml("data", null, xml("ibb", { sid: descriptor.sid }));
    case "sipub":
    case "jingle":
    case "unsupported":
      return xml("data", null, cloneElement(descriptor.element));
  }
}

/**
 * Accepts the parent <req>/<resp> element; missing/empty <data> → undefined.
 */
export function decodeData(parent: Element): DataDescriptor | undefined {
  // <data> inherits the urn:xmpp:http namespace from its parent.
  const data =
    parent.getChild("data", NS_HTTPX) ?? parent.getChild("data", "");
  if (!data) return undefined;

  const [child] = data.getChildElements();
  if (!child) return undefined;

  switch (child.getName()) {
    case "text":
      return { kind: "text", text: child.getText() };
    case "xml": {
      const [root, extra] = child.getChildElements();
      if (!root) {
        throw new CodecError("<xml> data with no child element");
      }
      if (extra) {
        throw new CodecError("<xml> data with multiple root elements");
      }
      return { kind: "xml", element: root };
    }
    case "base64": {
      try {
        return { kind: "base64", bytes: decodeBase64(child.getText()) };
      } catch (err) {
        throw new CodecError("invalid base64 in <data>", err);
      }
    }
    case "chunkedBase64": {
      const streamId = child.attrs["streamId"];
      if (!streamId) {
        throw new CodecError("<chunkedBase64> without streamId");
      }
      return { kind: "chunkedBase64", streamId };
    }
    case "ibb": {
      const sid = child.attrs["sid"];
      if (!sid) {
        throw new CodecError("<ibb> without sid");
      }
      return { kind: "ibb", sid };
    }
    case "sipub": {
      // A <sipub> in another namespace is somebody else's extension.
      if (child.getNS() !== NS_SIPUB) break;
      const id = child.attrs["id"];
      if (!id) {
        throw new CodecError("<sipub> without id");
      }
      return { kind: "sipub", id, element: child };
    }
    case "jingle": {
      if (child.getNS() !== NS_JINGLE) break;
      if (child.attrs["action"] !== "session-initiate") {
        throw new CodecError(
          "<jingle> in <data> must be a session-initiate",
        );
      }
      const sid = child.attrs["sid"];
      if (!sid) {
        throw new CodecError("<jingle> without sid");
      }
      return { kind: "jingle", sid, element: child };
    }
    default:
      break;
  }
  return { kind: "unsupported", name: child.getName(), element: child };
}
