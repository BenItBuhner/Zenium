/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as crons from "../crons.js";
import type * as devices from "../devices.js";
import type * as http from "../http.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_customFunctions from "../lib/customFunctions.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as links from "../links.js";
import type * as sync from "../sync.js";
import type * as tokens from "../tokens.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  crons: typeof crons;
  devices: typeof devices;
  http: typeof http;
  "lib/crypto": typeof lib_crypto;
  "lib/customFunctions": typeof lib_customFunctions;
  "lib/errors": typeof lib_errors;
  "lib/limits": typeof lib_limits;
  "lib/rateLimits": typeof lib_rateLimits;
  links: typeof links;
  sync: typeof sync;
  tokens: typeof tokens;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
