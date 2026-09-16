/**
 * Consumer-side build for git/tarball installs (the `prepare` script):
 * transpile straight from src without tsc project references. Types are NOT
 * checked here — `pnpm run typecheck` owns that.
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@fengbinmov/dsh-git-panel', ['src/index.ts'])
