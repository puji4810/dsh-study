/** Package-owned invariant companion for `@puji4810/dsh-study`. @module @puji4810/dsh-study/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@puji4810/dsh-study'
/** Cordis companion plugin name. */
export const name = 'studyos-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']
/**
 * No runtime invariant: StudyOS durable state lives in the learner's Vault files
 * (validated at every read and written atomically), and the plugin appends no
 * package-local session events beyond the generic `tool/result` records.
 */
const install: InvariantInstaller = () => {}
/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
