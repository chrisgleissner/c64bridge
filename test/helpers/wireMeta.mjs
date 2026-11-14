// Metadata of a tool response as seen by an MCP client: structuredContent.data
// (which carries the values of textResult metadata) plus any extra top-level metadata.
export function wireMeta(result) {
  const data = result?.structuredContent?.data;
  return { ...(data && typeof data === "object" ? data : {}), ...(result?.metadata ?? {}) };
}
