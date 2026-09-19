import { XMLParser } from "fast-xml-parser";

/**
 * Feed XML is untrusted input. Entities are processed but external entities are
 * never resolved by fast-xml-parser, and attribute values are kept separate from
 * element text so a crafted attribute cannot masquerade as a field value.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

export function parseXml(text: string): unknown {
  return parser.parse(text);
}

/** A single child element parses to an object, several to an array. */
export function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** Element text, whether the parser produced a string or a wrapped node. */
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value && typeof value === "object" && "#text" in value)
    return text((value as { "#text": unknown })["#text"]);
  return "";
}
