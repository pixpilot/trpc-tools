import { initTRPC, TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { createAuthMiddlewares } from '../src';

interface TestContext {
  user: { id: string } | null;
  isAdmin?: boolean;
  requestId: string;
}

const t = initTRPC.context<TestContext>().create();
const { isAuthed, isAdmin } = createAuthMiddlewares(t);

const protectedCaller = t.router({
  currentUser: t.procedure.use(isAuthed).query(({ ctx }) => ({
    userId: ctx.user.id,
    requestId: ctx.requestId,
  })),
}).createCaller;

const adminCaller = t.router({
  dashboard: t.procedure.use(isAdmin).query(({ ctx }) => ({
    isAdmin: ctx.isAdmin,
    userId: ctx.user.id,
    requestId: ctx.requestId,
  })),
}).createCaller;

describe('createAuthMiddlewares', () => {
  it('rejects unauthenticated users', async () => {
    await expect(
      protectedCaller({
        user: null,
        requestId: 'request-1',
      }).currentUser(),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  });

  it('keeps authenticated context available', async () => {
    await expect(
      protectedCaller({
        user: { id: 'user-1' },
        requestId: 'request-1',
      }).currentUser(),
    ).resolves.toEqual({
      userId: 'user-1',
      requestId: 'request-1',
    });
  });

  it('rejects non-admin users', async () => {
    await expect(
      adminCaller({
        user: { id: 'user-1' },
        isAdmin: false,
        requestId: 'request-1',
      }).dashboard(),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  });

  it('allows admin users', async () => {
    await expect(
      adminCaller({
        user: { id: 'admin-1' },
        isAdmin: true,
        requestId: 'request-1',
      }).dashboard(),
    ).resolves.toEqual({
      isAdmin: true,
      userId: 'admin-1',
      requestId: 'request-1',
    });
  });

  it('throws tRPC errors', async () => {
    await expect(
      protectedCaller({
        user: null,
        requestId: 'request-1',
      }).currentUser(),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});
