/** Compatibility contract for saved onboarding presentation checkpoints.
 * Retains the newer checkpoint without treating it as execution authority. */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** User/company onboarding presentation only; never a wake instruction. */
    'hivemind/hq-tour': {
      readonly version: 1
      readonly userKey: string
      readonly step: number
      readonly presentation: 'active' | 'dismissed' | 'completed'
      readonly revision: number
      readonly updatedAt: string
    }
  }
}
export {}
