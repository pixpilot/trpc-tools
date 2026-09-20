import makeConfig from '@pixpilot/eslint-config';

/**
 * @type {Awaited<ReturnType<typeof makeConfig>>}
 */
// eslint-disable-next-line antfu/no-top-level-await
const baseConfig = await makeConfig({
  pnpm: false,
  turbo: true,
});

export default baseConfig;
