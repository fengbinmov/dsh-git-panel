import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@fengbinmov/dsh-git-panel', [
  'src/index.ts',
], {
  libExternal: [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-workspace',
  ],
})
