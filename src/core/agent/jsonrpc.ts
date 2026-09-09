/**
 * JSON-RPC 2.0 message shapes and helpers, as used by the Model Context Protocol.
 */

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603
/** MCP: the client must (re)initialise before using the session. */
export const NOT_INITIALIZED = -32002
/** Zen: the agent is not allowed to do this (denied by the user, wrong token, foreign tab…). */
export const UNAUTHORIZED = -32001

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export function isRequest(m: unknown): m is JsonRpcRequest {
  return (
    isObject(m) &&
    m.jsonrpc === '2.0' &&
    typeof m.method === 'string' &&
    'id' in m &&
    (typeof m.id === 'string' || typeof m.id === 'number' || m.id === null)
  )
}

export function isNotification(m: unknown): m is JsonRpcNotification {
  return isObject(m) && m.jsonrpc === '2.0' && typeof m.method === 'string' && !('id' in m)
}

export function isResponse(m: unknown): m is JsonRpcResponse {
  return isObject(m) && m.jsonrpc === '2.0' && !('method' in m) && ('result' in m || 'error' in m)
}

export function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  const error: JsonRpcError = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id, error }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Read `params` as an object (JSON-RPC allows arrays, MCP never uses them). */
export function paramsOf(m: JsonRpcRequest | JsonRpcNotification): Record<string, unknown> {
  return isObject(m.params) ? m.params : {}
}
