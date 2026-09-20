import type { TRPCMiddlewareBuilder, TRPCMiddlewareFunction } from '@trpc/server';
import { TRPCError } from '@trpc/server';

/**
 * The slice of Cloudflare's Rate Limiting binding this middleware needs.
 *
 * Declared structurally rather than imported from `@cloudflare/workers-types`
 * so this package stays runtime-agnostic — any limiter that can answer
 * "is this key over budget?" satisfies it, including the fakes used in tests.
 */
export interface RateLimiterBinding {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

/**
 * What to do when the limiter itself fails — it throws, or its answer cannot
 * be trusted. This is only about limiter faults; a limiter that cleanly
 * reports "over budget" always rejects.
 *
 * - `pass` (fail open): run the procedure anyway. A broken binding costs some
 *   extra load rather than a broken API.
 * - `reject` (fail closed): refuse with `SERVICE_UNAVAILABLE`. Pick this when
 *   an unthrottled procedure is the more expensive failure.
 */
export type RateLimitErrorBehavior = 'pass' | 'reject';

export interface RateLimitMiddlewareConfig<TContext> {
  /**
   * Resolves the limiter for the current request. Returning `undefined` means
   * "no limiter here" and the request passes through untouched — that is the
   * normal state outside a Worker (local `next dev`, vitest, scripts, build).
   */
  getLimiter: (ctx: TContext) => RateLimiterBinding | undefined;
  /**
   * Bucket the request is counted against. Returning `null` skips the limit,
   * so a caller the key cannot identify is never lumped in with everyone else.
   */
  getKey: (ctx: TContext) => string | null;
  message?: string;
  /**
   * How to treat a limiter fault. Defaults to `pass`, which keeps the API
   * serving when the binding misbehaves.
   */
  onError?: RateLimitErrorBehavior;
  /**
   * Message used when `onError: 'reject'` turns a limiter fault into a
   * rejection. Kept separate from `message` so clients can tell "you are over
   * budget" apart from "we cannot tell right now".
   */
  errorMessage?: string;
  /**
   * Called with the limiter fault before `onError` is applied. Use it to get
   * the failure into your logs — without it, a persistently broken limiter is
   * invisible under the default `pass`. Anything it throws is ignored.
   */
  onLimiterError?: (error: unknown) => void;
}

interface RateLimitMiddlewareFactory<TContext, TMeta extends object> {
  middleware: <$ContextOverrides>(
    fn: TRPCMiddlewareFunction<TContext, TMeta, object, $ContextOverrides, unknown>,
  ) => TRPCMiddlewareBuilder<TContext, TMeta, $ContextOverrides, unknown>;
}

const DEFAULT_MESSAGE = 'Too many requests. Please slow down and try again shortly.';
const DEFAULT_ERROR_MESSAGE = 'Rate limiting is unavailable. Please try again shortly.';

/**
 * Gates a procedure on a request-rate budget, rejecting with
 * `TOO_MANY_REQUESTS` once the caller's bucket is spent.
 *
 * This is an abuse guard, not an accounting device. Cloudflare's rate limiter
 * counts per colo and is explicitly approximate, so the count it reports is
 * never exact and must not back billing, credits, or any quota a user is
 * charged against.
 *
 * An unbound limiter, or a key that cannot be resolved, always passes the
 * request through — those are configuration states, not faults. A limiter that
 * throws is a fault, and `onError` decides it: `pass` (the default) runs the
 * procedure anyway, `reject` refuses with `SERVICE_UNAVAILABLE`.
 */
// eslint-disable-next-line ts/explicit-module-boundary-types
export function createRateLimitMiddleware<TContext, TMeta extends object = object>(
  t: RateLimitMiddlewareFactory<TContext, TMeta>,
  config: RateLimitMiddlewareConfig<TContext>,
) {
  return t.middleware<object>(async (opts) => {
    const { next } = opts;
    /*
     * tRPC hands the context back as `Simplify<TContext>` — the same keys with
     * the same types, but the compiler cannot prove that for an unresolved
     * generic. Sibling middlewares dodge this by only reading properties;
     * this one passes the whole context to the caller's resolvers, so the
     * equivalence has to be asserted once, here.
     */
    const ctx = opts.ctx as TContext;

    const limiter = config.getLimiter(ctx);

    if (limiter == null) {
      return next();
    }

    const key = config.getKey(ctx);

    if (key == null) {
      return next();
    }

    let allowed: boolean;

    try {
      const outcome = await limiter.limit({ key });
      allowed = outcome.success;
    } catch (error) {
      try {
        config.onLimiterError?.(error);
      } catch {
        // A broken logger must not decide whether the request is served.
      }

      if (config.onError === 'reject') {
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: config.errorMessage ?? DEFAULT_ERROR_MESSAGE,
          cause: error,
        });
      }

      return next();
    }

    if (!allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: config.message ?? DEFAULT_MESSAGE,
      });
    }

    return next();
  });
}
