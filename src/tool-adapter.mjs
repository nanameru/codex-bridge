import { Transform } from "node:stream";

function orderedBridgeHistory(input, maxBytes) {
  const result = [];
  let size = 0;
  const append = (items) => {
    for (const item of items) {
      size += Buffer.byteLength(JSON.stringify(item)) + 1;
      if (size > maxBytes) throw new RangeError("expanded history too large");
      result.push(item);
    }
  };
  let block = [];
  const flush = () => {
    if (!block.length) return;
    let suffix = block.length;
    while (suffix > 0 && block[suffix - 1].type === "reasoning") suffix--;
    if (suffix > 0 && suffix < block.length && !block.slice(0, suffix).some((item) => item.type === "reasoning")) {
      block = [...block.slice(suffix), ...block.slice(0, suffix)];
    }
    let reasoning = [];
    let previousType;
    for (const item of block) {
      if (item.type === "reasoning") {
        if (previousType !== "reasoning") reasoning = [];
        reasoning.push(item);
      } else {
        if (item.type !== "function_call" || previousType !== "function_call") append(reasoning);
        append([item]);
      }
      previousType = item.type;
    }
    if (previousType === "reasoning") append(reasoning);
    block = [];
  };
  for (const item of input) {
    if (item.type === "reasoning" || item.type === "function_call" || item.role === "assistant") block.push(item);
    else { flush(); append([item]); }
  }
  flush();
  return result;
}

export function openCodeBody(body, maxBytes = 32 * 1024 * 1024) {
  const result = { ...body };
  if (Array.isArray(body.input)) {
    let previousInstruction;
    const input = body.input.filter((item) => {
      const instruction = ["system", "developer"].includes(item.role)
        && [undefined, "message"].includes(item.type)
        ? JSON.stringify({ role: item.role, content: item.content }) : undefined;
      const duplicate = instruction !== undefined && instruction === previousInstruction;
      previousInstruction = instruction;
      return !duplicate;
    });
    result.input = orderedBridgeHistory(input.map((item) => {
      if (item.type === "custom_tool_call") {
        return { type: "function_call", id: item.id, call_id: item.call_id, name: item.name,
          arguments: JSON.stringify({ input: item.input }) };
      }
      if (item.type === "custom_tool_call_output") return { ...item, type: "function_call_output" };
      return item;
    }), maxBytes);
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

export function nativeToolPayload(payload, customNames, depth = 0) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || depth > 1) {
    throw new Error("invalid response envelope");
  }
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
  if (payload.response) result.response = nativeToolPayload(payload.response, customNames, depth + 1);
  return result;
}

export function toolResponseStream(customNames, contentType, maxBytes) {
  const decoder = new TextDecoder();
  const customItems = new Set();
  const pendingReasoning = new Set();
  let deferred = [];
  let deferredBytes = 0;
  let sequence = 0;
  let buffer = "";
  const isSse = contentType.includes("text/event-stream");
  const event = (text) => {
    if (Buffer.byteLength(text) > maxBytes) throw new Error("upstream event too large");
    const lines = text.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return text + "\n\n";
    if (data === "[DONE]") {
      if (deferred.length) throw new Error("reasoning completion is missing");
      return text + "\n\n";
    }
    const payload = JSON.parse(data);
    if (payload.item?.type === "function_call" && customNames.has(payload.item.name)) {
      customItems.add(payload.item.id);
    }
    if (payload.type?.startsWith("response.function_call_arguments.") && customItems.has(payload.item_id)) return "";
    const headers = lines.filter((line) => !line.startsWith("data:"));
    const converted = nativeToolPayload(payload, customNames);
    const render = (value, prefix) => {
      if (typeof value.sequence_number === "number") value.sequence_number = sequence++;
      return prefix.join("\n") + "\ndata: " + JSON.stringify(value) + "\n\n";
    };
    const reasoningKey = payload.item?.id ?? payload.output_index;
    if (payload.type === "response.output_item.added" && payload.item?.type === "reasoning") {
      pendingReasoning.add(reasoningKey);
      if (pendingReasoning.size > 1024) throw new Error("too many pending reasoning items");
    }
    if (payload.type === "response.output_item.done" && payload.item?.type !== "reasoning" && pendingReasoning.size) {
      deferredBytes += Buffer.byteLength(JSON.stringify(converted)) + Buffer.byteLength(headers.join("\n"));
      if (deferredBytes > maxBytes) throw new Error("deferred output too large");
      deferred.push([converted, headers]);
      return "";
    }
    if (payload.type === "response.failed" || payload.type === "error") {
      deferred = [];
      deferredBytes = 0;
      pendingReasoning.clear();
    }
    if (payload.type === "response.completed" && pendingReasoning.size) throw new Error("reasoning completion is missing");
    let output = render(converted, headers);
    if (payload.type === "response.output_item.done" && payload.item?.type === "reasoning") {
      pendingReasoning.delete(reasoningKey);
      if (!pendingReasoning.size) {
        for (const [value, prefix] of deferred) output += render(value, prefix);
        deferred = [];
        deferredBytes = 0;
      }
    }
    return output;
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
        if (Buffer.byteLength(buffer) > maxBytes) throw new Error("upstream event too large");
        if (buffer.trim()) this.push(isSse ? event(buffer) : JSON.stringify(nativeToolPayload(JSON.parse(buffer), customNames)));
        if (deferred.length || pendingReasoning.size) throw new Error("reasoning completion is missing");
        callback();
      } catch (error) { callback(error); }
    },
  });
}
