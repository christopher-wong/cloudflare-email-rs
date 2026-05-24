/**
 * Convenience re-exports + helpers for working with the auto-generated
 * OpenAPI types in `api-types.ts`. Keeps call sites readable without
 * having to type `components['schemas']['SecretCreateReq']` everywhere.
 *
 * The shape:
 *
 *   import type { Schemas, RequestBody, ResponseBody } from '@/lib/api-typed';
 *
 *   const req: Schemas['SecretCreateReq'] = { ... };
 *   const resp = await api.post<Schemas['SecretCreateResp']>('/api/secret/create', req);
 *
 *   // Or, when you know the operationId from openapi-gen/src/paths.rs:
 *   type R = RequestBody<'secret_create'>;
 *   type S = ResponseBody<'secret_create', 200>;
 *
 * Regenerate `api-types.ts` after any change to openapi.json:
 *
 *   make openapi      # regenerates openapi.json AND api-types.ts
 *   # or, web-only:
 *   npm --prefix web run gen:types
 */

import type { components, operations } from './api-types';

/** Every named schema from the OpenAPI doc. */
export type Schemas = components['schemas'];

/** All operationIds (matches the function names in
 *  `openapi-gen/src/paths.rs`). */
export type OperationId = keyof operations;

/** JSON request body for a given operation. `never` if the op has
 *  no request body (e.g. a plain GET). */
export type RequestBody<Op extends OperationId> =
  operations[Op] extends { requestBody?: { content: { 'application/json': infer B } } }
    ? B
    : never;

/** JSON response body for a given operation + status code. Defaults
 *  to 200. `never` if the response carries no JSON body (binary
 *  download, 204 No Content, etc.). */
export type ResponseBody<
  Op extends OperationId,
  Status extends number = 200,
> = operations[Op] extends {
  responses: infer R;
}
  ? Status extends keyof R
    ? R[Status] extends { content: { 'application/json': infer B } }
      ? B
      : never
    : never
  : never;
