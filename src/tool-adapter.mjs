import { Transform } from "node:stream";

export function openCodeBody(body) {
  const result = { ...body };
  if (Array.isArray(body.input)) {
    result.input = body.input.map((item) => {
      if (item.type === "custom_tool_call") {
        return { type: "function_call", id: item.id, call_id: item.call_id, name: item.name,
          arguments: JSON.stringify({ input: item.input }) };
      }
      if (item.type === "custom_tool_call_output") return { ...item, type: "function_call_output" };
      return item;
    });
  }
  if (Array.isArray(body.tools)) {
    result.tools = body.tools.map((tool) => tool.type === "custom" ? {
      type: "function", name: tool.name,
      description: (tool.description ?? "") + (tool.format ? "\nInput format: " + JSON.stringify(tool.format) : ""),
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
    } : tool);
  }
  if (["custom", "function"].includes(body.tool_choice?.type) && body.tool_choice.name) {
    result.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
  }
  return result;
}

export function nativeToolPayload(payload, customNames) {
  const item = (value) => {
    if (value?.type !== "function_call" || !customNames.has(value.name)) return value;
    const { arguments: argumentsText, ...rest } = value;
    if (!argumentsText && value.status !== "in_progress") throw new Error("custom tool arguments are missing");
    const argumentsValue = argumentsText ? JSON.parse(argumentsText) : { input: "" };
    if (typeof argumentsValue.input !== "string") throw new Error("custom tool input is missing");
    return { ...rest, type: "custom_tool_call", input: argumentsValue.input };
  };
  let result = { ...payload };
  if (payload.item) result.item = item(payload.item);
  if (Array.isArray(payload.output)) result.output = payload.output.map(item);
  if (payload.response) result.response = nativeToolPayload(payload.response, customNames);
  return result;
}

export function toolResponseStream(customNames, contentType, maxBytes) {
  const decoder = new TextDecoder();
  const customItems = new Set();
  let buffer = "";
  const isSse = contentType.includes("text/event-stream");
  const event = (text) => {
    const lines = text.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return text + "\n\n";
    const payload = JSON.parse(data);
    if (payload.item?.type === "function_call" && customNames.has(payload.item.name)) {
      customItems.add(payload.item.id);
    }
    if (payload.type?.startsWith("response.function_call_arguments.") && customItems.has(payload.item_id)) return "";
    const headers = lines.filter((line) => !line.startsWith("data:"));
    return headers.join("\n") + "\ndata: " + JSON.stringify(nativeToolPayload(payload, customNames)) + "\n\n";
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        if (isSse) {
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            this.push(event(buffer.slice(0, boundary.index)));
            buffer = buffer.slice(boundary.index + boundary[0].length);
          }
        }
        if (Buffer.byteLength(buffer) > maxBytes) throw new Error("upstream event too large");
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        buffer += decoder.decode();
        if (buffer.trim()) this.push(isSse ? event(buffer) : JSON.stringify(nativeToolPayload(JSON.parse(buffer), customNames)));
        callback();
      } catch (error) { callback(error); }
    },
  });
}
