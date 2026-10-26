"""Synthetic, side-effect-free MCP server for the Codex tool-search E2E."""
import json
import os
from pathlib import Path
import sys

SCHEMA_VERSION = int(os.environ.get("SYNTHETIC_MCP_SCHEMA_VERSION", "1"))

TOOLS = [{"name": f"synthetic_{index:03d}",
          "description": f"Synthetic unrelated operation {index}. " + "Unused fixture documentation. " * 12,
          "inputSchema": {"type": "object", "properties": {"label": {"type": "string"}}, "additionalProperties": False}}
         for index in range(128)]
TOOLS.append({"name": "needle_target", "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}, "description": f"Return the exact synthetic verification marker NEEDLE_TARGET_OK. SCHEMA_V{SCHEMA_VERSION}.",
              "inputSchema": {"type": "object", "properties": {"revision": {"type": "integer", "const": 2}} if SCHEMA_VERSION == 2 else {},
                              "required": ["revision"] if SCHEMA_VERSION == 2 else [], "additionalProperties": False}})

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError('object required')
        if 'id' not in request:
            continue
        method = request.get('method')
        if method == 'initialize':
            result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "synthetic-tool-search", "version": "1.0.0"}}
        elif method == 'tools/list':
            result = {"tools": TOOLS}
        elif method == 'tools/call':
            name = request.get('params', {}).get('name')
            if name != 'needle_target':
                raise ValueError('Unexpected synthetic tool executed')
            expected_args = {'revision': 2} if SCHEMA_VERSION == 2 else {}
            if request.get('params', {}).get('arguments', {}) != expected_args:
                raise ValueError('Synthetic schema revision mismatch')
            path = os.environ.get('SYNTHETIC_MCP_RECEIPT')
            if path:
                with Path(path).open('a') as output:
                    output.write(json.dumps({"name": name, "schema_version": SCHEMA_VERSION}) + '\n')
            result = {"content": [{"type": "text", "text": "NEEDLE_TARGET_OK"}], "isError": False}
        elif method == 'ping':
            result = {}
        else:
            print(json.dumps({"jsonrpc": "2.0", "id": request['id'], "error": {"code": -32601, "message": "method not found"}}), flush=True)
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": request['id'], "result": result}), flush=True)
    except (ValueError, TypeError, KeyError):
        # Never echo request data, including in this all-synthetic fixture.
        print(json.dumps({"jsonrpc": "2.0", "id": request.get('id') if isinstance(request, dict) else None, "error": {"code": -32602, "message": "invalid fixture request"}}), flush=True)
