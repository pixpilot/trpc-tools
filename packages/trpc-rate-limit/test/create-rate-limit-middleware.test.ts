import type { RateLimiterBinding, RateLimitMiddlewareConfig } from '../src';

import { initTRPC } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

import { createRateLimitMiddleware } from '../src';

interface TestContext {
  user: { id: string } | null;
  limiter?: RateLimiterBinding;
}

const t = initTRPC.context<TestContext>().create();

const caller = t.router({
  expensive: t.procedure
    .use(
      createRateLimitMiddleware(t, {
        getLimiter: (ctx) => ctx.limiter,
        getKey: (ctx) => ctx.user?.id ?? null,
      }),
    )
    .query(() => 'ok'),
}).createCaller;

function limiterReturning(success: boolean): RateLimiterBinding {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

function throwingLimiter(): RateLimiterBinding {
  return { limit: vi.fn().mockRejectedValue(new Error('binding exploded')) };
}

function callerWith(overrides: Partial<RateLimitMiddlewareConfig<TestContext>>) {
  return t.router({
    expensive: t.procedure
      .use(
        createRateLimitMiddleware(t, {
          getLimiter: (ctx) => ctx.limiter,
          getKey: (ctx) => ctx.user?.id ?? null,
          ...overrides,
        }),
      )
      .query(() => 'ok'),
  }).createCaller;
}

describe('createRateLimitMiddleware', () => {
  it('runs the procedure while the bucket has budget left', async () => {
    await expect(
      caller({ user: { id: 'user-1' }, limiter: limiterReturning(true) }).expensive(),
    ).resolves.toBe('ok');
  });

  it('rejects with TOO_MANY_REQUESTS once the bucket is spent', async () => {
    await expect(
      caller({ user: { id: 'user-1' }, limiter: limiterReturning(false) }).expensive(),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('uses the configured message', async () => {
    const limited = t.router({
      expensive: t.procedure
        .use(
          createRateLimitMiddleware(t, {
            getLimiter: (ctx) => ctx.limiter,
            getKey: () => 'fixed-key',
            message: 'Slow down there',
          }),
        )
        .query(() => 'ok'),
    }).createCaller;

    await expect(
      limited({ user: null, limiter: limiterReturning(false) }).expensive(),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Slow down there',
    });
  });

  it('keys the bucket on the value getKey returns', async () => {
    const limiter = limiterReturning(true);

    await caller({ user: { id: 'user-42' }, limiter }).expensive();

    expect(limiter.limit).toHaveBeenCalledWith({ key: 'user-42' });
  });

  it('passes the request through when no limiter is bound', async () => {
    await expect(caller({ user: { id: 'user-1' } }).expensive()).resolves.toBe('ok');
  });

  it('passes the request through when the key cannot be resolved', async () => {
    const limiter = limiterReturning(false);

    await expect(caller({ user: null, limiter }).expensive()).resolves.toBe('ok');
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it('fails open when the limiter throws', async () => {
    await expect(
      caller({ user: { id: 'user-1' }, limiter: throwingLimiter() }).expensive(),
    ).resolves.toBe('ok');
  });

  it('fails open when the limiter throws and onError is pass', async () => {
    await expect(
      callerWith({ onError: 'pass' })({
        user: { id: 'user-1' },
        limiter: throwingLimiter(),
      }).expensive(),
    ).resolves.toBe('ok');
  });

  it('fails closed when the limiter throws and onError is reject', async () => {
    await expect(
      callerWith({ onError: 'reject' })({
        user: { id: 'user-1' },
        limiter: throwingLimiter(),
      }).expensive(),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('uses the configured errorMessage when failing closed', async () => {
    await expect(
      callerWith({ onError: 'reject', errorMessage: 'Limiter is down' })({
        user: { id: 'user-1' },
        limiter: throwingLimiter(),
      }).expensive(),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Limiter is down',
    });
  });

  it('keeps the over-budget rejection distinct from a limiter fault', async () => {
    await expect(
      callerWith({ onError: 'reject' })({
        user: { id: 'user-1' },
        limiter: limiterReturning(false),
      }).expensive(),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('reports the limiter fault to onLimiterError', async () => {
    const onLimiterError = vi.fn();
    const error = new Error('binding exploded');

    await callerWith({ onLimiterError })({
      user: { id: 'user-1' },
      limiter: { limit: vi.fn().mockRejectedValue(error) },
    }).expensive();

    expect(onLimiterError).toHaveBeenCalledWith(error);
  });

  it('serves the request even when onLimiterError itself throws', async () => {
    await expect(
      callerWith({
        onLimiterError: () => {
          throw new Error('logger exploded');
        },
      })({ user: { id: 'user-1' }, limiter: throwingLimiter() }).expensive(),
    ).resolves.toBe('ok');
  });
});
